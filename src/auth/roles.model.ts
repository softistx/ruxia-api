import { defineCollection } from "@softistx/mongo";
import { z } from "zod";

// The lock documents of the roles, `_id` being `platform`: every write of a
// role raises `version` inside a transaction first, so two at once conflict on
// it and the loser runs again (the plugin's "narrower locks"). One document for
// the whole platform, since the last-admin guard (slice A5) must read and
// write the admins serialised with every other role change. Created on first
// use, never deleted.
export const roleLocks = defineCollection({
  name: "role_locks",
  schema: z.object({
    _id: z.string(),
    version: z.number().int().default(0),
  }),
});
