import { expect, spyOn, test } from "bun:test";
import { graphqlPost } from "~/app";
import { authApp, signedInAccount } from "~/auth";
import { MembersService } from "../modules/members/members.service";

// Pins the masking of an unexpected error on /graphql: the client gets
// INTERNAL_SERVER_ERROR, never the original message. (janus-graphql < 0.24.2
// could leak it under @envelop/core 6; this app masked it either way.)
test("an unexpected resolver error on /graphql answers INTERNAL_SERVER_ERROR, without its message", async () => {
  const kit = authApp();
  const { token } = await signedInAccount(kit, { role: "admin" });
  const boom = spyOn(MembersService.prototype, "list").mockImplementation(
    () => {
      throw new Error("secret detail");
    },
  );
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await graphqlPost(
      kit.app,
      JSON.stringify({ query: "{ members { totalCount } }" }),
      { authorization: `Bearer ${token}` },
    );
    const text = await response.text();
    expect(text).not.toContain("secret detail");
    expect(JSON.parse(text).errors?.[0]?.extensions?.code).toBe(
      "INTERNAL_SERVER_ERROR",
    );
  } finally {
    boom.mockRestore();
    log.mockRestore();
  }
});
