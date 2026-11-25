import {
  connectMongo,
  defineMongo,
  type Mongo,
  type MongoOf,
  openMongo,
} from "@softistx/mongo";
import type { Db } from "mongodb";
import * as collections from "../modules/collections";
import { env } from "./env";

// ONE MongoClient and ONE database for the whole process: no tenancy.
// `connectMongo` shares the client per URI; the `Mongo` below is opened on it
// with `client`, which it never closes: `closeDatabases` does.
const connection = await connectMongo(env.MONGO_URI, {
  appName: "ruxia-api",
});

// Development and tests create the validators and indexes before a collection's
// first use; in production `bun run db:sync` does, as a deployment step (it
// needs the dbAdmin role).
const autoSync = Bun.env.NODE_ENV !== "production";

export const mongoConfig = defineMongo({
  client: connection.client,
  database: env.MONGO_DATABASE,
  collections,
  autoSync,
});

export type AppMongo = MongoOf<typeof mongoConfig>;

export const appMongo: AppMongo = await openMongo(mongoConfig);

// The driver's `Db` of a `Mongo`: what janus's adapter and the migrations take.
// A real `Mongo` only (never a request's scoped one). (`mongo.db` is typed per
// wiring, which a generic cannot resolve.)
export function databaseOf<C>(mongo: Mongo<C>): Db {
  return mongo.db as unknown as Db;
}

// The shutdown: the `Mongo`, then the shared client (its connection is the
// last holder).
export async function closeDatabases() {
  await appMongo.close();
  await connection.close();
}
