import { defineCache } from "@softistx/redis";
import { z } from "zod";

// The caches, as @softistx/redis describes them: `defineRedis` wires every export
// of this file as `redis.cache.<export name>` (src/config/redis.ts).

// Nothing is cached yet: a placeholder keeps `defineRedis` wired for the
// slices that follow.
export const placeholder = defineCache({
  name: "placeholder",
  key: (name: string) => name,
  ttl: 60,
  schema: z.number(),
});
