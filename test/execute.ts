import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { execute } from "graphql";
import { janusViewer, type Viewer } from "../src/auth/viewer";
import { schema } from "../src/http/schema";
import { unthrottled } from "../src/limits/throttle";
import { conversationsRuntime } from "../src/modules/conversations";
import { noStatuses } from "../src/modules/models";
import { services } from "../src/modules/services";
import type { AuthApp } from "./auth";
import { fakeAdapters } from "./conversations";

// Runs an operation in process, as `viewer`, with the resolvers of /graphql
// and no HTTP in between.
export async function executeAs<D, V extends Record<string, unknown>>(
  kit: Pick<AuthApp, "auth">,
  viewer: Viewer | null,
  document: TypedDocumentNode<D, V>,
  variables?: V,
) {
  const request = new Request("https://spec.ruxia.test/graphql");
  const result = await execute({
    schema,
    document,
    ...(variables && { variableValues: variables }),
    contextValue: {
      viewer,
      services: services({
        auth: kit.auth,
        request,
        viewer,
        throttle: unthrottled,
        clientIp: undefined,
        statuses: noStatuses,
        adapters: fakeAdapters(),
        titleModelId: "claude-haiku-5-5",
        runtime: conversationsRuntime({ maxRunMs: 60_000 }),
        observers: [],
        now: () => new Date(),
      }),
    },
  });
  return {
    data: (result.data ?? undefined) as D | undefined,
    ...(result.errors && { errors: result.errors }),
  };
}

// The viewer of the account's own session.
export const sessionViewer = async (
  kit: Pick<AuthApp, "auth">,
  token: string,
) => {
  const viewer = await janusViewer(kit.auth)(
    new Request("https://spec.ruxia.test/graphql", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  if (!viewer) throw new Error("no session for the viewer");
  return viewer;
};
