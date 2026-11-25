import { describe, expect, test } from "bun:test";
import { graphqlPost, queryPost, testApp } from "~/app";
import { BODY_LIMIT } from "../app";
import { clientHeader } from "./csrf";

const app = testApp();

describe("the body limit of /graphql", () => {
  test("a body over 100 KiB answers 413, one under it is read", async () => {
    const padding = " ".repeat(BODY_LIMIT);
    const big = await queryPost(app, `{ ping }${padding}`);
    expect(big.status).toBe(413);
    // A chunked body (no Content-Length) is counted as it arrives.
    const bytes = new TextEncoder().encode(
      JSON.stringify({ query: `{ ping }${padding}` }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 8192) {
          controller.enqueue(bytes.slice(at, at + 8192));
        }
        controller.close();
      },
    });
    const chunked = await app.fetch(
      new Request("https://ui.ruxia.test/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [clientHeader]: "spec",
        },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(chunked.status).toBe(413);
    const small = await queryPost(app, "{ ping }");
    expect(small.status).toBe(200);
    expect((await small.json()).errors).toBeUndefined();
  });

  test("a 2 MiB body answers 413, not 500, and logs no stack", async () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const big = await graphqlPost(
        app,
        JSON.stringify({ query: `{ ping }${" ".repeat(2 * 1024 * 1024)}` }),
      );
      expect(big.status).toBe(413);
    } finally {
      console.error = original;
    }
    expect(JSON.stringify(logged)).not.toContain("    at ");
  });
});
