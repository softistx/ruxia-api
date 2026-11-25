import { syncMongoAdapter, syncMongoInvitations } from "@softistx/janus-mongo";
import { MigrationLockedError } from "@softistx/mongo/migrations";
import { app } from "./app";
import { appMongo, databaseOf } from "./config/db";
import { env } from "./config/env";
import { redis } from "./config/redis";
import { MigrationsOutOfSyncError } from "./migrations/status";
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

if (redis === undefined) console.warn("rate limits off: no REDIS_URL");

// In dev, the URL and the route table; in production, the URL alone. On
// SIGINT and SIGTERM, listen drains the requests in flight and exits.
app.listen({
  port: env.PORT,
  onListen: ({ dev, table, url }) =>
    console.log(dev ? table : `listening on ${url}`),
});
