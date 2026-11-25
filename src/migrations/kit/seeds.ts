import { z } from "zod";

// The shape a migration's texts are parsed with before they are written, so a
// typo fails the migration and not a later request. Frozen like the rest of
// the kit: it copies the model's rules instead of importing them, because the
// model evolves and a migration that ran must keep meaning what it meant.

const languageCode = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);

export const translationSeed = z
  .object({
    key: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/)
      .refine(
        (key) =>
          !key
            .split(".")
            .some((s) => ["__proto__", "constructor", "prototype"].includes(s)),
        "a key segment cannot be __proto__, constructor or prototype",
      ),
    texts: z.record(languageCode, z.string().min(1)),
  })
  .strict();

export type TranslationSeed = z.infer<typeof translationSeed>;
