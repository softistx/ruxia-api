import { defineMigration } from "@softistx/mongo/migrations";
import models from "./2026-11-25-models-seed/models.json";

export const id = "2026-11-25-models-seed";

// The Claude models, enabled (docs/spec.md, section 2). Their prices are not
// stored: they come from `ANTHROPIC_PRICES` of @softistx/ai-anthropic until a
// document carries its own (`prices`). Ollama models are not seeded: the
// probe lists the ones installed, disabled. A model already there (an admin
// disabled it, or a replay) is left exactly as it is.
export const modelsSeed = defineMigration({
  id,
  async up({ db, session }) {
    const now = new Date();
    await db.collection<{ _id: string }>("models").bulkWrite(
      models.map((model) => ({
        updateOne: {
          filter: { _id: model._id },
          update: {
            $setOnInsert: {
              ...model,
              createdAt: now,
              updatedAt: now,
              version: 0,
            },
          },
          upsert: true,
        },
      })),
      session === undefined ? {} : { session },
    );
  },
  // Removes what `up` created.
  async down({ db, session }) {
    await db
      .collection<{ _id: string }>("models")
      .deleteMany(
        { _id: { $in: models.map((model) => model._id) } },
        session === undefined ? {} : { session },
      );
  },
});
