import { health } from "@softistx/alxia";
import { graphql, type ServerContext } from "@softistx/alxia-graphql";
import {
  janusGraxia,
  janusGraxiaMaskError,
} from "@softistx/janus-graphql/graxia";
import type { Auth } from "./auth/auth";
import { janusViewer, type Viewer } from "./auth/viewer";
import { serverAuth } from "./config/auth";
import { appMongo, closeDatabases } from "./config/db";
import { redis, serverThrottle } from "./config/redis";
import { type Base, type BaseOptions, createBase } from "./http/context";
import { clientHeader } from "./http/csrf";
import { graphqlPlugins } from "./http/graphql-plugins";
import { schema } from "./http/schema";
import type { Throttle } from "./limits/throttle";
import { type Services, services } from "./modules/services";
import { cataloguesLoaded } from "./modules/translations";

// The largest body /graphql reads.
export const BODY_LIMIT = 100 * 1024;

// POST and GET /graphql over the schema: the context carries the request's
// services. The IDE (Apollo Sandbox) is given the client header.
function graphqlRoute(
  app: Base,
  auth: Auth,
  servicesOf: (
    viewer: Viewer | null,
    request: Request,
    ip: string | undefined,
  ) => Services,
) {
  return graphql(app, {
    schema,
    context: ({
      request,
      serverContext: { viewer, ip },
    }: {
      request: Request;
      serverContext: ServerContext<Base["~context"]>;
    }) => ({ services: servicesOf(viewer, request, ip) }),
    plugins: [
      ...graphqlPlugins,
      janusGraxia({ auth: auth.accounts, clock: auth.clock }),
    ],
    maskError: janusGraxiaMaskError(),
    // The app's own depth, cost and breadth limits (src/http/query-limits.ts).
    limits: {
      depth: false,
      aliases: false,
      rootFields: false,
      directives: false,
      cost: false,
    },
    ide: "apollo-sandbox",
    sandbox: { initialHeaders: { [clientHeader]: "apollo-sandbox" } },
  });
}

// The probes (GET /health, GET /ready), then POST and GET /graphql behind the
// base's middlewares. The IDE (Apollo Sandbox, on a browser's GET) follows
// alxia's dev switch: on under `bun dev` (NODE_ENV=development), off
// otherwise. /graphql refuses a request without `x-ruxia-client`
// (src/http/csrf.ts), which Apollo Sandbox is given. /ready answers 503 while
// MongoDB does not (src/config/db.ts), and until the error catalogue is loaded
// (src/modules/translations); a spec gives its own `catalogues`.
//
// Who sends a request is janus's account (`janusViewer`, src/auth/viewer.ts),
// and the anonymous operations count the client's address in `throttle`
// (`serverThrottle`, src/config/redis.ts); a spec gives its own `auth` (a
// memory mailer, a fixed clock) and `throttle`.
export function createApp(
  options: BaseOptions & {
    auth?: Auth;
    throttle?: Throttle;
    catalogues?: () => boolean;
  } = {},
) {
  const auth = options.auth ?? serverAuth();
  const throttle = options.throttle ?? serverThrottle;
  const cataloguesReady = options.catalogues ?? cataloguesLoaded;
  const servicesOf = (
    viewer: Viewer | null,
    request: Request,
    ip: string | undefined,
  ) => services({ auth, request, viewer, throttle, clientIp: ip });
  return (
    createBase({
      ...options,
      resolveViewer: options.resolveViewer ?? janusViewer(auth),
    })
      .plugin(probes(cataloguesReady))
      // A body past 100 KiB is refused (413) before it is read, for /graphql
      // below: a query is a few kilobytes (alxia's production guide, "Cap the body").
      .bodyLimit(BODY_LIMIT)
      .plugin((app) => graphqlRoute(app, auth, servicesOf))
      .onStop(async () => {
        await closeDatabases();
        await redis?.close();
      })
  );
}

// /health and /ready: Mongo answers a ping within a second, and the error
// catalogue is loaded (`cataloguesLoaded`: 503 until the first load).
function probes(cataloguesReady: () => boolean) {
  return health({
    checks: {
      mongo: async () =>
        Object.values(await appMongo.ping({ timeoutMS: 1_000 })).every(
          (result) => result.ok,
        ),
      catalogues: async () => cataloguesReady(),
    },
  });
}

// The app the server runs.
export const app = createApp();

export type App = typeof app;
