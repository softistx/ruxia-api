import { type Catalogue, mergeCatalogues } from "@softistx/i18n";
import { FALLBACK_LANGUAGE } from "../../i18n";
import {
  catalogueOf,
  type TranslationRow,
  versionOf,
} from "./translations.utils";

export interface BuiltTexts {
  // The merged catalogue of each shipped language.
  catalogues: Record<string, Catalogue>;
  // What `errorCatalogue` serves per language: the chain (itself, then French)
  // and its version, a digest of the merged texts.
  served: Map<string, { chain: Catalogue[]; version: string }>;
}

export interface TextSources {
  // The live translations.
  rows: readonly TranslationRow[];
  languages: readonly string[];
  // The @softistx/i18n catalogues by language: the packages' defaults.
  packages: Readonly<Record<string, Catalogue>>;
}

// What the API serves, layered: the packages' defaults, under the migrations'
// translations. Pure: both `loadCatalogues` and the specs build texts from it.
export function buildTexts(sources: TextSources): BuiltTexts {
  const { rows, languages, packages } = sources;
  const catalogues: Record<string, Catalogue> = {};
  for (const language of languages) {
    catalogues[language] = mergeCatalogues(
      packages[language] ?? {},
      catalogueOf(rows, language),
    );
  }
  const last = catalogues[FALLBACK_LANGUAGE] as Catalogue;
  const served = new Map<string, { chain: Catalogue[]; version: string }>();
  for (const language of languages) {
    const own = catalogues[language] as Catalogue;
    const chain = language === FALLBACK_LANGUAGE ? [own] : [own, last];
    served.set(language, { chain, version: versionOf(chain) });
  }
  return { catalogues, served };
}
