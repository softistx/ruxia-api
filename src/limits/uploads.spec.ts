import { describe, expect, test } from "bun:test";
import { countingThrottle } from "~/throttle";
import { unthrottled } from "./throttle";
import { uploadThrottle } from "./uploads";

describe("uploadThrottle", () => {
  test("lets an upload through until the account's limit, then answers the wait", async () => {
    const decide = uploadThrottle(
      countingThrottle({ after: 1, retryAfter: 7 }),
    );
    const ada = { viewer: { id: "ada" } };
    expect(await decide(ada)).toBe(true);
    expect(await decide(ada)).toBe(7);
  });

  test("no viewer is not counted, and a store that fails open lets it through", async () => {
    expect(await uploadThrottle(unthrottled)({ viewer: null })).toBe(true);
    expect(await uploadThrottle(unthrottled)({ viewer: { id: "a" } })).toBe(
      true,
    );
  });
});
