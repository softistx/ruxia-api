import type { CatalogueView, ErrorMessageView } from "./translations.utils";
import { languageOf } from "./translations.utils";

// What the service reads of the loaded catalogues (`loadCatalogues`), given by
// the registry and never defaulted: a language's version, and its error
// messages, which are only built when asked for.
export interface LoadedCatalogues {
  version(language: string): string;
  messages(language: string): ErrorMessageView[];
}

// The error catalogue, public: no viewer. `requested` is
// the request's language, taken when a query names none.
export class TranslationsService {
  constructor(
    private readonly loaded: LoadedCatalogues,
    private readonly requested: () => string,
  ) {}

  catalogue(language: string | null | undefined): CatalogueView {
    const code = languageOf(language, this.requested());
    return { language: code, version: this.loaded.version(code) };
  }

  version(language: string | null | undefined): string {
    return this.loaded.version(languageOf(language, this.requested()));
  }

  messages(language: string): ErrorMessageView[] {
    return this.loaded.messages(language);
  }
}
