import { describe, expect, test } from "bun:test";
import { Throttled } from "../../limits/ports";
import {
  codes,
  invalidCursor,
  limitedSend,
  messageNotFound,
  modelUnavailable,
  notEditable,
  notFound,
  notRegenerable,
  personaUnavailable,
  reactionLimit,
  restoreExpired,
  runInProgress,
  runNotFound,
  tooManyMessages,
} from "./conversations.errors";

const status = (error: { extensions: Record<string, unknown> }) =>
  error.extensions["http"];

describe("conversations errors", () => {
  test("each refusal has its code and status", () => {
    const cases = [
      [notFound(), "not-found", 404],
      [invalidCursor(), "invalid-cursor", 400],
      [runInProgress(), "run-in-progress", 409],
      [runNotFound(), "run-not-found", 404],
      [modelUnavailable(), "model-unavailable", 409],
      [personaUnavailable(), "persona-unavailable", 409],
      [messageNotFound(), "message-not-found", 404],
      [notEditable(), "not-editable", 409],
      [notRegenerable(), "not-regenerable", 409],
      [reactionLimit(), "reaction-limit", 409],
      [restoreExpired(), "restore-expired", 409],
    ] as const;
    for (const [error, slug, code] of cases) {
      expect(error.extensions["code"]).toBe(`conversations.errors.${slug}`);
      expect(status(error)).toEqual({ status: code });
    }
  });

  test("model-unavailable is about the modelId field", () => {
    expect(modelUnavailable().extensions["field"]).toBe("modelId");
  });

  test("too-many-messages carries the wait in seconds and minutes", () => {
    const error = tooManyMessages(90);
    expect(error.extensions["code"]).toBe(
      "conversations.errors.too-many-messages",
    );
    expect(status(error)).toEqual({ status: 429 });
    expect(error.extensions["params"]).toEqual({ retryAfter: 90, minutes: 2 });
    expect(error.extensions["retryAfter"]).toBe(90);
    expect(error.extensions["minutes"]).toBe(2);
  });

  test("limitedSend maps a refusal of the limit and lets the rest through", async () => {
    await limitedSend(async () => {});
    const refused = limitedSend(async () => {
      throw new Throttled("sends", 12);
    });
    await expect(refused).rejects.toMatchObject({
      extensions: { code: "conversations.errors.too-many-messages" },
    });
    const broken = limitedSend(async () => {
      throw new Error("boom");
    });
    await expect(broken).rejects.toThrow("boom");
  });

  test("the inventory names all fourteen", () => {
    expect(codes).toHaveLength(14);
    expect(codes).toContain("conversations.errors.invalid-parent");
  });
});
