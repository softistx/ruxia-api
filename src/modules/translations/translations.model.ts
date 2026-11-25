import { defineCollection } from "@softistx/mongo";
import { z } from "zod";

// A language code, open: `fr`, `en`, `pt-BR`.
export const languageCode = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);

// A message in each language, in the database, read by `loadCatalogues`
// and written by migrations alone. `_id` is the full key,
// `<namespace>.<key>`, which for an API error is its code
// (`auth.errors.forbidden`); `namespace` is everything before the last dot.
// `texts` are ICU messages. A retired translation is kept, never deleted.
export const translationKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/);

export const translations = defineCollection({
  name: "translations",
  schema: z.object({
    _id: translationKey,
    namespace: z.string().min(1),
    key: z.string().min(1),
    texts: z.record(languageCode, z.string().min(1)),
    retiredAt: z.date().nullable().default(null),
    // The id of the migration that retired it.
    retiredBy: z.string().nullable().default(null),
  }),
  timestamps: true,
  optimisticLock: true,
  indexes: [
    {
      key: { namespace: 1, key: 1 },
      unique: true,
      name: "translations_key",
    },
  ],
});
