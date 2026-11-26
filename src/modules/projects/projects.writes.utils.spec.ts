import { expect, test } from "bun:test";
import { projectPatch } from "./projects.writes.utils";

test("an update patch holds only what the input names, trimmed", () => {
  expect(projectPatch({})).toEqual({});
  expect(
    projectPatch({ name: " A ", instructions: " b ", version: 2 }),
  ).toEqual({
    name: "A",
    instructions: "b",
    version: 2,
  });
  expect(projectPatch({ instructions: "" })).toEqual({ instructions: "" });
  expect(projectPatch({ name: null, instructions: null })).toEqual({});
});
