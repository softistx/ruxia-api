import { defineMigration } from "@softistx/mongo/migrations";
import en from "./2026-11-28-budgets-errors/translations.en.json";
import fr from "./2026-11-28-budgets-errors/translations.fr.json";
import { translationSeeds, upsertTranslations } from "./kit";

export const id = "2026-11-28-budgets-errors";

// The message of the budgets code (`budgets.errors.exhausted`). In French and English; the data is frozen JSON beside this file.
const seeds = () => translationSeeds({ fr, en });

export const budgetsErrors = defineMigration({
  id,
  async up({ db, session }) {
    await upsertTranslations({ db, session, migration: id }, seeds());
  },
  // Removes what `up` created.
  async down({ db, session }) {
    await db
      .collection<{ _id: string }>("translations")
      .deleteMany(
        { _id: { $in: seeds().map((s) => s.key) } },
        session === undefined ? {} : { session },
      );
  },
});
