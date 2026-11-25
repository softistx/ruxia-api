import { expect, test } from "bun:test";

// src/config/env.ts reads Bun.env once, when it is first imported: a spec
// gives it a fresh copy (a query string makes a new module) under the values
// it tests.
let loads = 0;
const load = async (values: Record<string, string | undefined>) => {
  const before = Object.fromEntries(
    Object.keys(values).map((key) => [key, Bun.env[key]]),
  );
  const set = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  };
  set(values);
  try {
    loads += 1;
    return await import(`./env.ts?load=${loads}`);
  } finally {
    set(before);
  }
};

// 32 bytes in base64 (`openssl rand -base64 32`).
const key = Buffer.alloc(32, 7).toString("base64");

const production = {
  NODE_ENV: "production",
  TOTP_KEYS: `2026-10:${key}`,
  API_PROXY_SECRET: "s".repeat(32),
  UI_ORIGIN: "https://app.ruxia.example/",
  MAIL_FROM: "noreply@ruxia.example",
  MAIL_URL: "smtps://ruxia:secret@smtp.ruxia.example:465",
  REDIS_URL: "rediss://default:secret@redis.ruxia.example:6380",
};

test("a complete production environment loads, UI_ORIGIN without its trailing slash", async () => {
  const { env } = await load(production);
  expect(env.UI_ORIGIN).toBe("https://app.ruxia.example");
  expect(env.API_PROXY_SECRET).toBe(production.API_PROXY_SECRET);
});

test("in production, each of the six variables is required", async () => {
  for (const name of [
    "API_PROXY_SECRET",
    "TOTP_KEYS",
    "UI_ORIGIN",
    "MAIL_FROM",
    "MAIL_URL",
    "REDIS_URL",
  ] as const) {
    await expect(load({ ...production, [name]: undefined })).rejects.toThrow(
      name,
    );
  }
});

test("UI_ORIGIN has no path", async () => {
  await expect(
    load({ ...production, UI_ORIGIN: "https://x.example/app" }),
  ).rejects.toThrow("UI_ORIGIN");
});

test("in production, each malformed variable stops the app, naming it", async () => {
  const malformed = {
    API_PROXY_SECRET: "s".repeat(31),
    TOTP_KEYS: "2026-10:too-short",
    UI_ORIGIN: "http://app.ruxia.example",
    MAIL_FROM: "not-an-address",
    MAIL_URL: "http://smtp.ruxia.example",
    REDIS_URL: "http://redis.ruxia.example",
  };
  for (const [name, value] of Object.entries(malformed)) {
    await expect(load({ ...production, [name]: value })).rejects.toThrow(name);
  }
});

test("in development, each unset variable gets its default or stays unset", async () => {
  const { env } = await load({
    NODE_ENV: "development",
    API_PROXY_SECRET: undefined,
    UI_ORIGIN: undefined,
    MAIL_FROM: undefined,
    MAIL_URL: undefined,
    REDIS_URL: undefined,
    PORT: undefined,
    MONGO_DATABASE: undefined,
  });
  expect(env.UI_ORIGIN).toBe("http://localhost:5173");
  expect(env.MAIL_FROM).toBe("noreply@ruxia.test");
  expect(env.API_PROXY_SECRET).toBeUndefined();
  expect(env.MAIL_URL).toBeUndefined();
  expect(env.REDIS_URL).toBeUndefined();
  expect(env.PORT).toBe(3000);
  expect(env.MONGO_DATABASE).toBe("ruxia");
});

test("in development, an empty value is unset, and a set one is still checked", async () => {
  const empty = await load({
    NODE_ENV: "development",
    MAIL_URL: "",
    REDIS_URL: "",
  });
  expect(empty.env.MAIL_URL).toBeUndefined();
  expect(empty.env.REDIS_URL).toBeUndefined();
  await expect(
    load({ NODE_ENV: "development", API_PROXY_SECRET: "short" }),
  ).rejects.toThrow("API_PROXY_SECRET");
});

test("TOTP_KEYS is a list of id:key, the first sealing: rotation keeps the old key after the new one", async () => {
  const old = Buffer.alloc(32, 9).toString("base64");
  const { env } = await load({
    ...production,
    TOTP_KEYS: `2026-10:${key}, 2026-04:${old}`,
  });
  expect(env.TOTP_KEYS).toEqual([
    { id: "2026-10", key },
    { id: "2026-04", key: old },
  ]);
});

test("in production, TOTP_KEYS refuses a missing, empty, malformed, repeated or development key", async () => {
  const bad = [
    "",
    "nokey",
    `bad id:${key}`,
    `2026-10:${key.slice(0, 40)}`,
    `2026-10:${key},2026-10:${key}`,
    "dev:cnV4aWEtZGV2ZWxvcG1lbnQtdG90cC1rZXktMDAwMDE",
    // the same 32 bytes, padded, or with a non-canonical last character
    "dev:cnV4aWEtZGV2ZWxvcG1lbnQtdG90cC1rZXktMDAwMDE=",
    "dev:cnV4aWEtZGV2ZWxvcG1lbnQtdG90cC1rZXktMDAwMDF",
  ];
  for (const value of bad) {
    await expect(load({ ...production, TOTP_KEYS: value })).rejects.toThrow(
      "TOTP_KEYS",
    );
  }
});

test("outside production, a development key stands in for an unset TOTP_KEYS, and a set one is still checked", async () => {
  const { env } = await load({ NODE_ENV: "development", TOTP_KEYS: undefined });
  expect(env.TOTP_KEYS).toHaveLength(1);
  expect(env.TOTP_KEYS[0].id).toBe("dev");
  await expect(
    load({ NODE_ENV: "development", TOTP_KEYS: "nokey" }),
  ).rejects.toThrow("TOTP_KEYS");
});

test("the S3_* variables are optional everywhere, and an empty one is unset", async () => {
  const none = {
    S3_ENDPOINT: undefined,
    S3_REGION: undefined,
    S3_BUCKET: undefined,
    S3_ACCESS_KEY: undefined,
    S3_SECRET_KEY: undefined,
  };
  for (const base of [production, { NODE_ENV: "development" }]) {
    const { env } = await load({ ...base, ...none });
    expect(env.S3_BUCKET).toBeUndefined();
    expect(env.S3_ENDPOINT).toBeUndefined();
  }
  const { env } = await load({
    ...production,
    ...none,
    S3_BUCKET: "",
    S3_ENDPOINT: "",
  });
  expect(env.S3_BUCKET).toBeUndefined();
  expect(env.S3_ENDPOINT).toBeUndefined();
});

test("set, the S3_* variables are read, and a malformed endpoint stops the app", async () => {
  const set = {
    S3_ENDPOINT: "http://localhost:9000",
    S3_REGION: "us-east-1",
    S3_BUCKET: "ruxia-media",
    S3_ACCESS_KEY: "ruxia-dev",
    S3_SECRET_KEY: "ruxia-dev-secret",
  };
  const { env } = await load({ ...production, ...set });
  expect(env.S3_BUCKET).toBe("ruxia-media");
  expect(env.S3_ENDPOINT).toBe("http://localhost:9000");
  await expect(
    load({ ...production, ...set, S3_ENDPOINT: "minio:9000" }),
  ).rejects.toThrow("S3_ENDPOINT");
});

test("production takes its SMTP server as MAIL_URL or as SMTP_*, and one of them is required", async () => {
  const bumail = {
    SMTP_HOST: "bumail",
    SMTP_USER: "no-reply@softistx.com",
    SMTP_PASSWORD: "secret",
    SMTP_TLS_SERVERNAME: "mail.softistx.com",
  };
  const { env } = await load({ ...production, MAIL_URL: undefined, ...bumail });
  expect(env.MAIL_URL).toBeUndefined();
  expect(env.SMTP_HOST).toBe("bumail");
  expect(env.SMTP_PORT).toBe(587);
  expect(env.SMTP_TLS_SERVERNAME).toBe("mail.softistx.com");
  await expect(
    load({ ...production, MAIL_URL: undefined, SMTP_HOST: "" }),
  ).rejects.toThrow("MAIL_URL or SMTP_HOST");
  await expect(
    load({ ...production, ...bumail, SMTP_PORT: "70000" }),
  ).rejects.toThrow("SMTP_PORT");
});

test("MCP_HOSTNAME and API_ORIGIN are gone: set, they change nothing", async () => {
  const { env } = await load({
    ...production,
    MCP_HOSTNAME: "mcp-ruxia.example",
    API_ORIGIN: "https://mcp-ruxia.example",
  });
  expect("MCP_HOSTNAME" in env).toBe(false);
  expect("API_ORIGIN" in env).toBe(false);
  expect(env.UI_ORIGIN).toBe("https://app.ruxia.example");
});

test("OLLAMA_BASE_URL is optional, empty is unset, and must be an http(s) URL", async () => {
  expect((await load({ OLLAMA_BASE_URL: undefined })).env.OLLAMA_BASE_URL).toBe(
    undefined,
  );
  expect((await load({ OLLAMA_BASE_URL: "" })).env.OLLAMA_BASE_URL).toBe(
    undefined,
  );
  expect(
    (await load({ OLLAMA_BASE_URL: "http://100.64.0.2:11434" })).env
      .OLLAMA_BASE_URL,
  ).toBe("http://100.64.0.2:11434");
  await expect(load({ OLLAMA_BASE_URL: "mac.local" })).rejects.toThrow();
});
