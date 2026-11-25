import { afterAll } from "bun:test";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";

// Preloaded by `bun test` (bunfig.toml), before any spec imports src/: one
// in-memory MongoDB, a one-node replica set so that transactions work, for the
// whole run. src/config/env.ts then reads its URI as MONGO_URI; the database is
// named by the default (ruxia), on that one server.
const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});
Bun.env["MONGO_URI"] = replSet.getUri();
// Specs never throttle through a Redis of the developer's .env, nor mail
// through its SMTP server: they inject their own.
delete Bun.env["REDIS_URL"];
delete Bun.env["MAIL_URL"];
delete Bun.env["SMTP_HOST"];
// ... nor store files in a bucket of the developer's .env: they use
// @softistx/s3/testing.
for (const name of [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
]) {
  delete Bun.env[name];
}

// The collections, and janus's (users, sessions, tokens, relations, invitations), as
// `bun run db:sync` creates them: autoSync does not know janus's, and a write
// inside a transaction to a collection not yet created would hang.
{
  const { appMongo, databaseOf } = await import("../src/config/db");
  const { syncMongoAdapter, syncMongoInvitations } = await import(
    "@softistx/janus-mongo"
  );
  await appMongo.sync();
  await syncMongoAdapter(databaseOf(appMongo));
  await syncMongoInvitations(databaseOf(appMongo));
  // The migrations, as `bun run db:migrate` runs them: the API's texts (the
  // `translations` collection) are in them. Then the catalogues load, as the
  // server does at startup, so `i18n.t()` and `errorCatalogue` see them.
  const { migrate } = await import("@softistx/mongo/migrations");
  const { migrations } = await import("../src/migrations");
  const { loadCatalogues } = await import("../src/modules/translations");
  await migrate(databaseOf(appMongo), migrations);
  await loadCatalogues(appMongo);
}

afterAll(async () => {
  const { closeDatabases } = await import("../src/config/db");
  await closeDatabases();
  await replSet.stop();
});
