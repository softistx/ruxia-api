import { inSession, type KitContext } from "./context";
import { type TranslationSeed, translationSeed } from "./seeds";

// One seed per key from one flat file per language (`{ key: message }`): a key
// a language lacks is refused, so no migration ships a half-translated key.
export function translationSeeds(
  byLanguage: Readonly<Record<string, Readonly<Record<string, string>>>>,
): TranslationSeed[] {
  const languages = Object.keys(byLanguage);
  const keys = new Set(
    Object.values(byLanguage).flatMap((texts) => Object.keys(texts)),
  );
  return [...keys].map((key) => {
    const texts: Record<string, string> = {};
    for (const language of languages) {
      const text = byLanguage[language]?.[key];
      if (text === undefined) {
        throw new TypeError(`translation "${key}" has no ${language} text`);
      }
      texts[language] = text;
    }
    return { key, texts };
  });
}

// Adds the translations, or changes the text a key has in the languages the
// seed names (the other languages' texts stay). A key is never deleted, and an
// upsert never brings back a retired key: that would be a migration of its own.
export async function upsertTranslations(
  ctx: KitContext,
  seeds: readonly TranslationSeed[],
): Promise<void> {
  const now = new Date();
  const operations = seeds.map((seed) => {
    const { key, texts } = translationSeed.parse(seed);
    const at = key.lastIndexOf(".");
    return {
      updateOne: {
        filter: { _id: key },
        update: {
          $set: {
            ...Object.fromEntries(
              Object.entries(texts).map(([l, text]) => [`texts.${l}`, text]),
            ),
            updatedAt: now,
          },
          $setOnInsert: {
            namespace: key.slice(0, at),
            key: key.slice(at + 1),
            createdAt: now,
            version: 0,
            retiredAt: null,
            retiredBy: null,
          },
        },
        upsert: true,
      },
    };
  });
  if (operations.length === 0) return;
  await ctx.db
    .collection<{ _id: string }>("translations")
    .bulkWrite(operations, inSession(ctx));
}

// Retires translations: they stay readable, and are no longer served. The
// coverage spec refuses it while the code inventory still lists the key.
export async function retireTranslations(
  ctx: KitContext,
  keys: readonly string[],
): Promise<void> {
  const now = new Date();
  await ctx.db
    .collection<{ _id: string }>("translations")
    .updateMany(
      { _id: { $in: [...keys] } },
      { $set: { retiredAt: now, retiredBy: ctx.migration, updatedAt: now } },
      inSession(ctx),
    );
}
