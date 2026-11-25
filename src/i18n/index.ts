import { createI18n } from "@softistx/alxia-i18n";
import { type BuiltInLanguage, setFallbackLanguage } from "@softistx/i18n";
import type { ErrorCode } from "./codes";

// French is the language of a request that names none we speak, and the last
// step of every chain.
export const FALLBACK_LANGUAGE = "fr";
setFallbackLanguage(FALLBACK_LANGUAGE);

// The request's language: `Accept-Language` first, then the `lang` query, then
// the `language` cookie, among French and English. `i18n.t()` translates in it
// anywhere in the request, an error's message included. The texts are in the
// database (the migrations' `translations`); `loadCatalogues`
// (src/modules/translations) gives them to it at startup.
export const i18n = createI18n<ErrorCode, BuiltInLanguage>({
  languages: ["fr", "en"],
  fallback: FALLBACK_LANGUAGE,
  fallbacks: () => [],
  order: ["header", "query", "cookie"],
});
