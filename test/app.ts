import { createApp } from "../src/app";
import { clientHeader } from "../src/http/csrf";

// A raw POST of a document to `app`'s /graphql with the client header, for the
// specs of the request limits (depth, cost, body size, introspection). `app`
// is anything with a `fetch`: the real one, or a spec's own.
export type Fetching = {
  fetch: (request: Request) => Response | Promise<Response>;
};

export const testApp = () => createApp();

export const graphqlPost = (
  app: Fetching,
  body: string,
  headers: Record<string, string> = {},
) =>
  Promise.resolve(
    app.fetch(
      new Request("https://ui.ruxia.test/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [clientHeader]: "spec",
          ...headers,
        },
        body,
      }),
    ),
  );

export const queryPost = (
  app: Fetching,
  query: string,
  variables?: Record<string, unknown>,
) => graphqlPost(app, JSON.stringify({ query, variables }));
