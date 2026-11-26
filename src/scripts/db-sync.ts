import { syncMongoAdapter, syncMongoInvitations } from "@softistx/janus-mongo";
import { appMongo, closeDatabases, databaseOf } from "../config/db";
import { ensureVectorIndex } from "../modules/projects/projects.vector.mongo";

// A deployment step: brings the validators and indexes of the database, and
// janus's collections (users, sessions, tokens, relations, invitations), to what the
// definitions say (validators and indexes only; the migrations are
// `db:migrate`'s). Never `syncAll`: it would sync every definition the process
// loaded. It needs the dbAdmin role, which the app itself should not hold.
try {
  await appMongo.sync();
  await syncMongoAdapter(databaseOf(appMongo));
  // Not part of syncMongoAdapter: the invitations are an opt-in port.
  await syncMongoInvitations(databaseOf(appMongo));
  // The vector search index of the chunks: created once, needs `mongot`
  // (deploy/docker-compose.yaml). A failure stops the step.
  const created = await ensureVectorIndex(appMongo.db.chunks.raw);
  console.log(JSON.stringify({ vectorIndexCreated: created }));
  console.log(JSON.stringify({ database: appMongo.db.databaseName }, null, 2));
} finally {
  await closeDatabases();
}
