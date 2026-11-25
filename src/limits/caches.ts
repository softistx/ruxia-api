import type { OllamaStatus } from "@softistx/ai-ollama";
import { defineCache } from "@softistx/redis";
import { z } from "zod";
import { STATUS_TTL_SECONDS } from "../modules/models/models.status";

// The caches, as @softistx/redis describes them: `defineRedis` wires every export
// of this file as `redis.cache.<export name>` (src/config/redis.ts).

// What the last Ollama probe saw (src/modules/models/models.probe.ts), under
// `ruxia:models:ollama:status`. It lives three probes (STATUS_TTL_SECONDS), so a probe that
// stopped leaves every Ollama model unavailable rather than stale.
export const models = defineCache({
  name: "models",
  key: (server: "ollama") => `${server}:status`,
  ttl: STATUS_TTL_SECONDS,
  schema: z.object({
    reachable: z.boolean(),
    version: z.string().exactOptional(),
    models: z.array(
      z.object({
        name: z.string(),
        size: z.number(),
        family: z.string(),
        capabilities: z.array(z.string()).exactOptional(),
      }),
    ),
  }) satisfies z.ZodType<OllamaStatus>,
});
