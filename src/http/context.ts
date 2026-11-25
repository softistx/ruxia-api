import { alxia, defineMiddleware } from "@softistx/alxia";
import type { GraphQLContext } from "@softistx/alxia-graphql";
import { StoreFailure } from "@softistx/janus";
import { anonymous, type ResolveViewer, type Viewer } from "../auth/viewer";
import { env } from "../config/env";
import { i18n } from "../i18n";
import type { Services } from "../modules/services";
import { unavailable } from "../shared/errors";
import { clientIp } from "./client-ip";

export type { Viewer } from "../auth/viewer";

// The base: what every resolver reads, decorated or derived here: `env`,
// `ip`, the client's address, `viewer`, `requestId`, and `t` and `language`,
// the request's language.
export function createBase(options: BaseOptions = {}) {
  const { proxySecret = env.API_PROXY_SECRET, resolveViewer = anonymous } =
    options;
  // `viewer` is the account the request names (`Authorization: Bearer <janus
  // token>`), or null. A query may be anonymous, so this refuses nothing; a
  // resolver that needs a viewer refuses (the guards (slice A3)). A session store
  // that cannot answer is a 503 (`auth.errors.unavailable`), never an
  // anonymous request: that would sign everybody out during the outage.
  const viewerOf = defineMiddleware(async ({ request, reply }, next) => {
    let viewer: Viewer | null;
    try {
      viewer = await resolveViewer(request);
    } catch (error) {
      if (!(error instanceof StoreFailure)) throw error;
      return reply(503, { errors: [unavailable().toJSON()] });
    }
    return next({ viewer });
  });
  // `requestId` names the request (it is echoed as a header). alxia
  // exposes none (it documents this very middleware as the way to have one), so
  // the base makes one: always generated here, never read from `X-Request-Id`,
  // which any client could forge into the audit trail.
  // It is echoed as the `X-Request-Id` response header, so a user can quote it
  // and an operator find that request in the logs.
  const requestIdOf = defineMiddleware(({ set }, next) => {
    const requestId: string = crypto.randomUUID();
    set.headers.set("x-request-id", requestId);
    return next({ requestId });
  });
  return alxia({
    // ctx.ip: the client's address. With the proxy secret configured, a request
    // that carries it is believed about X-Forwarded-For; any other is keyed by
    // its peer. Unset, alxia reads the peer only.
    ...(proxySecret !== undefined && { ip: clientIp({ secret: proxySecret }) }),
  })
    .decorate({ env })
    .use(i18n)
    .use(requestIdOf)
    .use(viewerOf);
}

export interface BaseOptions {
  // API_PROXY_SECRET by default; a spec gives its own.
  proxySecret?: string | undefined;
  // Who the request is from: src/app.ts wires janus's (janusViewer); without
  // it, anonymous. A spec gives its own.
  resolveViewer?: ResolveViewer;
}

export type Base = ReturnType<typeof createBase>;

// A resolver's context: graxia's and the base's, plus what src/app.ts's
// `context` option adds per request: `services`. The generated `Resolvers`
// takes it (codegen.ts: `contextType`). Read only: module code does not assign
// `viewer` or `requestId`.
export type Context = Readonly<GraphQLContext<Base, { services: Services }>>;

// The part of a context the module guards read (`requirePermission`, the
// `readServices` and `writeServices` of each module): the viewer and the
// services. GraphQL's context is one; a second entry point would build the
// same two, so a tool runs the guards a resolver runs.
export type GuardContext = Pick<Context, "viewer" | "services">;
