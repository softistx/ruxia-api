import type { AppMongo } from "../config/db";

// The transaction a write runs in (`mongo.as(viewer).transaction`'s callback
// argument): what a module passes to another module's service so that its
// write joins the caller's transaction.
export type Tx = Parameters<
  Parameters<ReturnType<AppMongo["as"]>["transaction"]>[0]
>[0];
