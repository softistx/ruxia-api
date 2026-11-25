import { expect, test } from "bun:test";
import { codes, InvalidArguments } from "./operator.errors";

test("the operator's inventory is the one invalid-arguments code", () => {
  expect([...Object.values(codes)]).toContain(
    "operator.errors.invalid-arguments",
  );
});

test("InvalidArguments carries its code and its detail", () => {
  const error = new InvalidArguments("--email is required");
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("operator.errors.invalid-arguments");
  expect(error.message).toBe("--email is required");
});
