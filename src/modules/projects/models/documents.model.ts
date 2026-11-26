import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../../shared/actors";

export const documentStatuses = ["pending", "indexed", "failed"] as const;
export type DocumentStatus = (typeof documentStatuses)[number];

// A file a member added to a project (docs/spec.md, section 4.7): `key` is its
// media key (`/media/project-documents/<key>`, its owner alone). It is its own
// kind of upload, not an attachment: it belongs to a project for good, is never
// swept as unlinked and is indexed in the background. `status` is where the
// indexing stands; `errorCode` (a stored string, not an error code of the API)
// says why a FAILED one failed. Hard deleted with its chunks and file.
export const projectDocuments = defineCollection({
  name: "projectDocuments",
  schema: z.object({
    _id: id(),
    ownerId: accountId,
    projectId: objectId(),
    key: z.uuid(),
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(100),
    bytes: z.number().int().min(0),
    status: z.enum(documentStatuses),
    errorCode: z.string().max(60).nullable().default(null),
    chunkCount: z.number().int().min(0).default(0),
  }),
  timestamps: true,
  actors,
  indexes: [
    { key: { key: 1 }, name: "project_documents_key", unique: true },
    {
      key: { ownerId: 1, projectId: 1, createdAt: 1, _id: 1 },
      name: "project_documents_project",
    },
  ],
});

export type FileRecord = ReadDocumentOf<typeof projectDocuments>;
