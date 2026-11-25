import { expect, spyOn, test } from "bun:test";
import { createConsoleMailer, redactTokens } from "./console-mailer";
import { serverMailer, smtpOptions } from "./mailer";

const message = {
  to: { name: "Ada", address: "ada@ruxia.test" },
  subject: "Sign in",
  html: "<p>…</p>",
  text: "Open https://ui.ruxia.test/auth/magic-link?token=abc.DEF_-1&x=2 now",
};

test("the console mailer prints a mail's tokens under NODE_ENV=development alone", async () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  await createConsoleMailer({ log, revealTokens: false }).send(message);
  await createConsoleMailer({ log, revealTokens: true }).send(message);
  expect(lines).toEqual([
    "[mail] to ada@ruxia.test: Sign in\nOpen https://ui.ruxia.test/auth/magic-link?token=[redacted]&x=2 now",
    `[mail] to ada@ruxia.test: Sign in\n${message.text}`,
  ]);
  // bun test runs with NODE_ENV=test: redacted by default.
  lines.length = 0;
  await createConsoleMailer({ log }).send(message);
  expect(lines[0]).toContain("token=[redacted]");
});

test("redactTokens leaves a text without a token as it is", () => {
  expect(redactTokens("no link here")).toBe("no link here");
});

test("without MAIL_URL, the server prints its mails", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await serverMailer(undefined).send(message);
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});

test("without MAIL_URL nor SMTP_HOST, the server prints its mails, whatever else is set", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await serverMailer({ port: 587, user: "u", password: "p" }).send(message);
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});

test("bumail: port 587 is STARTTLS, required with a login, and the certificate is checked against its name", () => {
  expect(
    smtpOptions({
      host: "bumail",
      user: "no-reply@softistx.com",
      password: "secret",
      tlsServername: "mail.softistx.com",
    }),
  ).toEqual({
    host: "bumail",
    port: 587,
    secure: false,
    auth: { user: "no-reply@softistx.com", pass: "secret" },
    requireTLS: true,
    tls: { servername: "mail.softistx.com" },
  });
});

test("port 465 is TLS from the first byte; no login means no auth and no forced TLS (mailpit)", () => {
  expect(
    smtpOptions({ host: "h", port: 465, user: "u", password: "p" }),
  ).toEqual({
    host: "h",
    port: 465,
    secure: true,
    auth: { user: "u", pass: "p" },
    requireTLS: false,
  });
  expect(smtpOptions({ host: "mailpit", port: 1025 })).toEqual({
    host: "mailpit",
    port: 1025,
    secure: false,
  });
});
