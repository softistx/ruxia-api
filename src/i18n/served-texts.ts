import type { Catalogue } from "@softistx/i18n";
import { messagesOf } from "../modules/translations/translations.utils";

// The catalogue chain each language serves, set by `loadCatalogues`
// (src/modules/translations/translations.load.ts). A leaf module, so that
// src/shared/errors/ can read it without an import cycle.
let chains = new Map<string, Catalogue[]>();

export const setServedChains = (next: Map<string, Catalogue[]>) => {
  chains = next;
};

// The text a code has in each served language (the language's own, else
// French's), for the test guard of `fail()` (src/shared/errors/).
export const textsOfCode = (code: string) =>
  [...chains].map(([language, chain]) => ({
    language,
    message: messagesOf(chain, [code])[0]?.message,
  }));
