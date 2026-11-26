import { ollamaStatus } from "@softistx/ai-ollama";
import { syncMongoAdapter, syncMongoInvitations } from "@softistx/janus-mongo";
import { MigrationLockedError } from "@softistx/mongo/migrations";
import { app } from "./app";
import { appMongo, databaseOf } from "./config/db";
import { serverEmbedder } from "./config/embeddings";
import { env } from "./config/env";
import { serverMedia } from "./config/media";
import { redis, serverQueues, serverStatuses } from "./config/redis";
import { serverVectors } from "./config/vectors";
import { MigrationsOutOfSyncError } from "./migrations/status";
import { AttachmentsPurge } from "./modules/attachments";
import {
  ConversationsPurge,
  PURGE_BATCH,
  PURGE_BUDGET_MS,
  PURGE_DEADLINE_MS,
  PURGE_INTERVAL_MS,
  sweepRuns,
} from "./modules/conversations";
import {
  intervalTicker,
  ModelsProbe,
  PROBE_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
} from "./modules/models";
import {
  DocumentIndexer,
  ensureVectorIndex,
  IndexingWorker,
  PROJECTS_PURGE_BATCH,
  PROJECTS_PURGE_INTERVAL_MS,
  ProjectsPurge,
} from "./modules/projects";
import { bootCatalogues } from "./modules/translations";

// In development, janus's collections, indexes and validators are synced at
// startup, as the app's are on first use (autoSync); in production
// `bun run db:sync` does both, as a deployment step. The collections are
// synced BEFORE the migrations below: a validator older than a migration's
// fields (`additionalProperties: false`) would refuse its backfill on an
// existing development database.
const development = Bun.env.NODE_ENV !== "production";
if (development) {
  await appMongo.sync();
  await syncMongoAdapter(databaseOf(appMongo));
  await syncMongoInvitations(databaseOf(appMongo));
  // The vector index needs MongoDB's search component (`mongot`, deploy/): a
  // development database without it only loses `search_project`.
  try {
    await ensureVectorIndex(appMongo.db.chunks.raw);
  } catch (error) {
    console.warn(`vector index not created: ${(error as Error).message}`);
  }
}

// The API's texts come from the database, written by the migrations: in
// development the pending ones are applied here, anywhere else a pending
// migration stops the server (`bun run db:migrate` runs at deploy). `/ready`
// answers 503 until they are loaded.
try {
  await bootCatalogues(appMongo, { autoMigrate: development });
} catch (error) {
  if (
    !(error instanceof MigrationsOutOfSyncError) &&
    !(error instanceof MigrationLockedError)
  ) {
    throw error;
  }
  console.error(error.message);
  process.exit(1);
}

// The runs live in this process: a message a previous one left STREAMING
// belongs to a run that is gone, and is ended before the first request.
const interrupted = await sweepRuns(appMongo, () => new Date());
if (interrupted > 0) console.warn(`${interrupted} interrupted runs ended`);

if (redis === undefined) console.warn("rate limits off: no REDIS_URL");

// The Ollama health probe (every 30 s, answer cached in Redis): never started
// by a spec. Without OLLAMA_BASE_URL, or without Redis to keep its answer in,
// it does not run and every Ollama model is unavailable.
if (env.OLLAMA_BASE_URL === undefined) {
  console.warn("ollama probe off: no OLLAMA_BASE_URL");
} else if (redis === undefined) {
  console.warn("ollama probe off: no REDIS_URL");
} else {
  const probe = new ModelsProbe({
    mongo: appMongo,
    status: ollamaStatus,
    statuses: serverStatuses,
    ticker: intervalTicker,
    baseUrl: env.OLLAMA_BASE_URL,
    intervalMs: PROBE_INTERVAL_MS,
    timeoutMs: PROBE_TIMEOUT_MS,
    log: (message) => console.warn(message),
  });
  probe.start();
  // listen drains and exits on these; the timer is unref'd, stopping it is
  // for the tidy shutdown.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => probe.stop());
  }
}

// The daily purge of the conversations deleted more than 30 days ago, with
// their messages and exports: started here only, never by a spec. Its timer is
// unref'd; stopping it is for the tidy shutdown.
const purge = new ConversationsPurge({
  mongo: appMongo,
  media: serverMedia,
  attachments: new AttachmentsPurge(appMongo, serverMedia, (message) =>
    console.warn(message),
  ),
  ticker: intervalTicker,
  now: () => new Date(),
  intervalMs: PURGE_INTERVAL_MS,
  batch: PURGE_BATCH,
  budgetMs: PURGE_BUDGET_MS,
  deadlineMs: PURGE_DEADLINE_MS,
  log: (message) => console.warn(message),
});
purge.start();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => purge.stop());
}

// The indexing of the projects' documents (queue `indexing`: Redis, or this
// process without REDIS_URL) and the daily purge of deleted projects: started
// here only, never by a spec.
if (redis === undefined)
  console.warn("indexing queue is in-process: no REDIS_URL");
const indexing = new IndexingWorker(
  serverQueues.indexing,
  new DocumentIndexer({
    mongo: appMongo,
    files: serverMedia,
    embedder: serverEmbedder,
    vectors: serverVectors,
    log: (message) => console.warn(message),
  }),
);
indexing.start();
const projectsPurge = new ProjectsPurge({
  mongo: appMongo,
  files: serverMedia,
  vectors: serverVectors,
  ticker: intervalTicker,
  now: () => new Date(),
  intervalMs: PROJECTS_PURGE_INTERVAL_MS,
  batch: PROJECTS_PURGE_BATCH,
  log: (message) => console.warn(message),
});
projectsPurge.start();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    projectsPurge.stop();
    void indexing.stop();
  });
}

// In dev, the URL and the route table; in production, the URL alone. On
// SIGINT and SIGTERM, listen drains the requests in flight and exits.
app.listen({
  port: env.PORT,
  onListen: ({ dev, table, url }) =>
    console.log(dev ? table : `listening on ${url}`),
});
