import type { ClientSession, Collection } from "mongodb";

// A lock document: `{ _id, version }` in a collection of its own, raised
// inside a transaction FIRST so that two writers of what it guards conflict on
// it and the loser runs again once the winner committed (the plugin's
// "serialising on a narrower lock document"). Created on first use, never
// deleted. `raw` is the driver collection (`collection.raw`), whose transient
// error the driver itself recognises and runs the transaction again for.
export type Locks = Collection<{ _id: string; version: number }>;

// Creates the document when it is not there yet, OUTSIDE the transaction:
// losing the race to create it (duplicate key) is harmless.
export async function ensureLock(raw: Locks, id: string) {
  try {
    await raw.updateOne(
      { _id: id },
      { $setOnInsert: { version: 0 } },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
}

// Raises the document inside the transaction of `session`: a concurrent writer
// of the same document conflicts here.
export async function raiseLock(
  raw: Locks,
  id: string,
  session: ClientSession | undefined,
) {
  await raw.updateOne(
    { _id: id },
    { $inc: { version: 1 } },
    { ...(session && { session }) },
  );
}
