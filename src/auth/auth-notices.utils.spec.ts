import { expect, test } from "bun:test";
import { whenOf } from "./auth-notices.utils";

const at = new Date(Date.UTC(2026, 10, 25, 14, 5));

test("the time is worded in the account's language, in UTC", () => {
  expect(whenOf(at, "en")).toContain("November 25, 2026");
  expect(whenOf(at, "en")).toContain("2:05");
  expect(whenOf(at, "fr")).toContain("25 novembre 2026");
  expect(whenOf(at, "fr")).toContain("14:05");
});
