import { describe, expect, test } from "bun:test";
import { createIssues, updateIssues } from "./personas.rules";

const key = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("personas rules", () => {
  test("a name of blanks and a key that is not a UUID are refused on their path", () => {
    expect(
      createIssues({ name: "   ", defaultModelId: "m", avatarKey: "x" }),
    ).toEqual([
      { path: "name", code: "validation.errors.required" },
      { path: "avatarKey", code: "validation.errors.invalid" },
    ]);
    expect(
      createIssues({ name: "Ada", defaultModelId: "m", avatarKey: key }),
    ).toEqual([]);
  });

  test("an update refuses a null on what cannot be cleared, not on the avatar or voice", () => {
    expect(
      updateIssues({
        name: null,
        tagline: null,
        personality: null,
        defaultModelId: null,
        tools: null,
        projectIds: null,
        visibility: null,
        avatarKey: null,
        voiceId: null,
      }).map((issue) => issue.path),
    ).toEqual([
      "name",
      "tagline",
      "personality",
      "defaultModelId",
      "tools",
      "projectIds",
      "visibility",
    ]);
    expect(updateIssues({ avatarKey: null, voiceId: null })).toEqual([]);
  });
});
