import { agentEventStream } from "@softistx/ai-alxia";
import { responds, unchecked } from "@softistx/alxia";
import type { Base } from "../../http/context";
import { clientHeader } from "../../http/csrf";
import { fail } from "../../shared/errors";
import type { ConversationsRuntime } from "./conversations.runtime";

// A quiet stream sends a `: heartbeat` comment this often (ms): Bun closes a
// connection idle for 10 s, and a proxy a little longer.
export const HEARTBEAT_MS = 5_000;

// `GET /runs/:runId/events`: the transport beside `/graphql` that follows an
// answer being written (the second one, after the media routes), over the
// runs' detached log. The event ids are the positions in the run (1, 2, 3…),
// so a client reconnects with `Last-Event-ID` and misses nothing; a client that
// leaves never stops the run. Refusals are the API's JSON, `{ errors: [..] }`:
//
// 1. 403 `auth.errors.client-header-required`: no client header (as /graphql);
// 2. 401 `auth.errors.unauthenticated`: no viewer;
// 3. 403 `auth.errors.forbidden`: a viewer with no role;
// 4. 404 `conversations.errors.run-not-found`: no such run for the viewer. An
//    unknown run, an ended one past its retention, another member's and the
//    admin's all look alike.
export function runEvents(runtime: ConversationsRuntime, heartbeatMs: number) {
  return (app: Base) =>
    app.get(
      "/runs/:runId/events",
      responds({
        200: agentEventStream,
        401: unchecked,
        403: unchecked,
        404: unchecked,
      }),
      async ({ request, params, viewer, reply }) => {
        if (!request.headers.get(clientHeader)?.trim()) {
          return reply(403, {
            errors: [
              fail("auth.errors.client-header-required", {
                params: { header: clientHeader },
                status: 403,
              }).toJSON(),
            ],
          });
        }
        if (!viewer) {
          return reply(401, {
            errors: [
              fail("auth.errors.unauthenticated", { status: 401 }).toJSON(),
            ],
          });
        }
        if (viewer.role === null) {
          return reply(403, {
            errors: [fail("auth.errors.forbidden", { status: 403 }).toJSON()],
          });
        }
        if (!(await runtime.has(params.runId, viewer.id))) {
          return reply(404, {
            errors: [
              fail("conversations.errors.run-not-found", {
                status: 404,
              }).toJSON(),
            ],
          });
        }
        return reply(
          200,
          runtime.stream(params.runId, {
            lastEventId: request.headers.get("last-event-id"),
            ownerId: viewer.id,
            signal: request.signal,
            heartbeatMs,
          }),
        );
      },
    );
}
