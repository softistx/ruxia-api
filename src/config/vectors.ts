import { mongoVectorIndex } from "../modules/projects/projects.vector.mongo";
import { indexQueue } from "../modules/projects/projects.worker";
import { appMongo } from "./db";
import { serverQueues } from "./redis";

// The vector index the server searches: `$vectorSearch` over `chunks`
// (src/modules/projects/projects.vector.mongo.ts).
export const serverVectors = mongoVectorIndex(appMongo.db.chunks.raw);

// Where an uploaded document waits for its indexing: the `indexing` queue.
export const serverIndexQueue = indexQueue(serverQueues.indexing);
