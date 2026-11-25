import type { Resolvers } from "@/generated/graphql/resolvers";
import { errorParams, languageValue } from "./translations.utils";

// The error catalogue is public: no guard. `messages` is its own field, so a
// query that selects only `version`, or `errorCatalogueVersion`, builds no list.
export const translationResolvers: Resolvers = {
  Query: {
    errorCatalogue: (_, { language }, ctx) =>
      ctx.services.translations.catalogue(language),
    errorCatalogueVersion: (_, { language }, ctx) =>
      ctx.services.translations.version(language),
  },
  ErrorCatalogue: {
    language: ({ language }) => languageValue(language),
    messages: ({ language }, _, ctx) =>
      ctx.services.translations.messages(language),
  },
  ErrorMessage: {
    params: ({ message }) => errorParams(message),
  },
};
