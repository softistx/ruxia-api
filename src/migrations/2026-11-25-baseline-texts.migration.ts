import { defineMigration } from "@softistx/mongo/migrations";
import en from "./2026-11-25-baseline-texts/translations.en.json";
import fr from "./2026-11-25-baseline-texts/translations.fr.json";
import { translationSeeds, upsertTranslations } from "./kit";

export const id = "2026-11-25-baseline-texts";

// The texts every API starts with: the request base and the shared field reasons (`auth.errors.client-header-required`, `validation.errors.*`). In French and English; the data is frozen JSON beside this file.
const seeds = () => translationSeeds({ fr, en });

export const baselineTexts = defineMigration({
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
