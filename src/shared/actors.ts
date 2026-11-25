import { z } from "zod";

// Who wrote a document (`createdBy`, `updatedBy`, and `archivedBy` where a
// collection names its `deletedBy` so): a janus account id, a UUIDv7 string.
// Every collection stamps the same type, so `mongo.as(viewer.id)` stamps them
// all.
export const accountId = z.uuid();

export const actors = { type: accountId };

// What a collection that archives (soft delete) declares: `archivedAt` and
// `archivedBy` are `deletedAt` and `deletedBy` of @softistx/mongo under the names
// the schema speaks.
export const archiving = {
  softDelete: { deletedAt: "archivedAt" },
  actors: { type: accountId, deletedBy: "archivedBy" },
} as const;
