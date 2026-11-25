import {
  type BuiltInLanguage,
  type Catalogue,
  registerCatalogue,
  resources,
} from "@softistx/i18n";
import { migrate } from "@softistx/mongo/migrations";
import { type AppMongo, databaseOf } from "../../config/db";
import { i18n } from "../../i18n";
import { errorCodes } from "../../i18n/codes";
import { setServedChains } from "../../i18n/served-texts";
import { migrations } from "../../migrations";
import { assertMigrated } from "../../migrations/status";
import type { LoadedCatalogues } from "./translations.service";
import { buildTexts } from "./translations.texts";
import { messagesOf } from "./translations.utils";

let loaded = false;

// What the API serves of each language, built by `loadCatalogues`: its merged
// catalogue and the version of its chain (itself, then French).
const served = new Map<string, { chain: Catalogue[]; version: string }>();

// The version of the error catalogue a language serves, "" for a language that
// is not shipped. In memory: asking for it reads nothing.
export const catalogueVersion = (language: string): string =>
  served.get(language)?.version ?? "";

// Every error code's message in a language, each missing one filled from
// French: the `errorCatalogue` list, computed when it is selected.
export const errorMessages = (language: string) =>
  messagesOf(served.get(language)?.chain ?? [], errorCodes);

// What the translations service reads.
export const loadedCatalogues: LoadedCatalogues = {
  version: catalogueVersion,
  messages: errorMessages,
};

// Whether `loadCatalogues` has run: what `/ready` waits for.
export const cataloguesLoaded = () => loaded;

// The catalogues the API speaks, read once at startup from the database
// (a request reads the in-memory catalogues only):
//  1. refuses a database with a pending migration (`MigrationsOutOfSyncError`);
//  2. reads the live translations;
//  3. per shipped language (`i18n.supported`), layers the @softistx/i18n defaults
//     under the translations (`buildTexts`);
//  4. gives them to @softistx/alxia-i18n (`setResources`) and registers them with
//     @softistx/i18n, for the packages that translate through it;
//  5. keeps what `errorCatalogue` serves per language (the chain and its
//     version, a digest of the merged texts: a changed text changes the
//     version of the languages it touches, a restart does not).
// The fallback language, French, must be a shipped language.
export async function loadCatalogues(
  mongo: AppMongo,
  list: typeof migrations = migrations,
): Promise<void> {
  await assertMigrated(databaseOf(mongo), list);
  const rows = (await mongo.db.translations.raw.find({}).toArray()).filter(
    (row) => row.retiredAt === null,
  );
  const built = buildTexts({
    rows,
    languages: i18n.supported,
    packages: resources as Record<string, Catalogue>,
  });
  for (const [language, merged] of Object.entries(built.catalogues)) {
    registerCatalogue(language, merged, { replace: true });
  }
  i18n.setResources(built.catalogues as Record<BuiltInLanguage, Catalogue>);
  served.clear();
  for (const [language, entry] of built.served) served.set(language, entry);
  setServedChains(
    new Map([...served].map(([language, { chain }]) => [language, chain])),
  );
  loaded = true;
}

// What the server does before it listens: in development (`autoMigrate`) it
// applies the pending migrations itself; anywhere else a pending
// migration stops it (`MigrationsOutOfSyncError`), since `bun run db:migrate`
// is a deployment step, not something every instance races to do at boot.
export async function bootCatalogues(
  mongo: AppMongo,
  options: { autoMigrate: boolean; list?: typeof migrations },
): Promise<void> {
  const list = options.list ?? migrations;
  if (options.autoMigrate) await migrate(databaseOf(mongo), list);
  await loadCatalogues(mongo, list);
}
