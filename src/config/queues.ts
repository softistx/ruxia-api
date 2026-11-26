import { defineQueue } from "@softistx/redis";
import { z } from "zod";

// The background queues, as @softistx/redis describes them: `defineRedis`
// wires every export of this file as `redis.queues.<export name>`
// (src/config/redis.ts), and without Redis `localQueues` runs the same
// definitions in this process (a development convenience: a job does not
// survive a restart).

// The indexing of a project document (src/modules/projects): read, chunked,
// embedded, stored. Three attempts, waiting 5 s then 10 s; a run is cut after
// 5 minutes. The payload is an id only, never content.
export const indexing = defineQueue({
  name: "indexing",
  schema: z.object({ documentId: z.string().min(1).max(64) }),
  attempts: 3,
  backoff: { base: "5s", max: "5m" },
  lease: "2m",
  timeout: "5m",
  keepCompleted: { age: "10m", count: 100 },
  keepFailed: "7d",
});
