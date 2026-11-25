import { expect, test } from "bun:test";
import {
  type LoadedCatalogues,
  TranslationsService,
} from "./translations.service";

const loaded: LoadedCatalogues = {
  version: (language) => `v-${language}`,
  messages: (language) => [
    { code: "auth.errors.forbidden", message: language, params: [] },
  ],
};

test("a named language wins, else the request's", () => {
  const service = new TranslationsService(loaded, () => "en");
  expect(service.catalogue("fr")).toEqual({ language: "fr", version: "v-fr" });
  expect(service.catalogue(null)).toEqual({ language: "en", version: "v-en" });
  expect(service.catalogue(undefined).language).toBe("en");
});

test("the version follows the same choice, and messages are the language's", () => {
  const service = new TranslationsService(loaded, () => "en");
  expect(service.version("fr")).toBe("v-fr");
  expect(service.version(null)).toBe("v-en");
  expect(service.messages("fr")[0]?.message).toBe("fr");
});
