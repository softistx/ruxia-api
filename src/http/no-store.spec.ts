import { describe, expect, test } from "bun:test";
import { queryPost, testApp } from "~/app";

const app = testApp();

describe("Cache-Control on /graphql", () => {
  test("an answer, an answer with errors and a refused request are all no-store", async () => {
    const answered = await queryPost(app, "{ ping }");
    expect(answered.status).toBe(200);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    const invalid = await queryPost(app, "{ nope }");
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    const refused = await app.fetch(
      new Request("https://ui.ruxia.test/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ ping }" }),
      }),
    );
    expect(refused.status).toBe(403);
    expect(refused.headers.get("cache-control")).toBe("no-store");
  });
});
