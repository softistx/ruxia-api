import type { AppMongo } from "../../config/db";

// The code a message left STREAMING by a process that went down ends with.
export const interruptedCode = "INTERRUPTED";

// At boot, before the server listens: every message still STREAMING belongs
// to a run that died with the previous process (there is one API process and
// its runs live in it), so it becomes FAILED `INTERRUPTED` (a streaming message
// holds no parts yet: the answer is written when the run ends), and every
// conversation goes back to idle (`activeRunId` null). Returns how
// many messages it ended.
export async function sweepRuns(
  mongo: Pick<AppMongo, "db">,
  now: () => Date,
): Promise<number> {
  const at = now();
  // Raw: a sweep over every member's documents, which the typed, owner-bound
  // writes cannot express; it bypasses the actors stamping, so no `updatedBy`
  // is set (the sweep is the system's, not a member's).
  const ended = await mongo.db.messages.raw.updateMany(
    { status: "streaming" },
    {
      $set: {
        status: "failed",
        errorCode: interruptedCode,
        updatedAt: at,
      },
      $inc: { version: 1 },
    },
  );
  await mongo.db.conversations.raw.updateMany(
    { activeRunId: { $ne: null } },
    { $set: { activeRunId: null, updatedAt: at }, $inc: { version: 1 } },
  );
  return ended.modifiedCount;
}
