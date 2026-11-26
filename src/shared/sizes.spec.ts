import { expect, test } from "bun:test";
import { MiB } from "./sizes";

test("a MiB is 1024 times 1024 bytes", () => {
  expect(MiB).toBe(1_048_576);
});
