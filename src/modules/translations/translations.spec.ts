import { describe, expect, test } from "bun:test";
import { graphqlClient } from "@softistx/alxia-graphql/testing";
import { graphql } from "~/generated/graphql";
import { createApp } from "../../app";
import { clientHeader } from "../../http/csrf";
import { errorCodes } from "../../i18n/codes";

const ERROR_CATALOGUE_QUERY = graphql(`
  query ErrorCatalogue($language: Language) {
    errorCatalogue(language: $language) {
      language
      version
      messages {
        code
        message
        params {
          name
          kind
        }
      }
    }
  }
`);
const ERROR_CATALOGUE_VERSION_QUERY = graphql(`
  query ErrorCatalogueVersion($language: Language) {
    errorCatalogueVersion(language: $language)
  }
`);

const app = createApp();
const client = (headers: Record<string, string> = {}) =>
  graphqlClient(app, { headers: { [clientHeader]: "spec", ...headers } });

describe("Query.errorCatalogue", () => {
  test("is public and lists every code with its message and params", async () => {
    const result = await client().query(ERROR_CATALOGUE_QUERY, {
      variables: { language: "EN" },
    });
    expect(result.errors).toBeUndefined();
    const catalogue = result.data?.errorCatalogue;
    expect(catalogue?.language).toBe("EN");
    expect(catalogue?.messages.map((m) => m.code)).toEqual([...errorCodes]);
    expect(
      catalogue?.messages.find((m) => m.code === "validation.errors.too-short"),
    ).toEqual({
      code: "validation.errors.too-short",
      message:
        "This value is too short: at least {min, plural, one {# character} other {# characters}}.",
      params: [{ name: "min", kind: "PLURAL" }],
    });
    expect(
      catalogue?.messages.find(
        (m) => m.code === "auth.errors.client-header-required",
      )?.params,
    ).toEqual([{ name: "header", kind: "TEXT" }]);
  });

  test("falls back to the request's language, then to French", async () => {
    const english = await client({ "accept-language": "en" }).query(
      ERROR_CATALOGUE_QUERY,
    );
    expect(english.data?.errorCatalogue.language).toBe("EN");
    const none = await client().query(ERROR_CATALOGUE_QUERY);
    expect(none.data?.errorCatalogue.language).toBe("FR");
    expect(
      none.data?.errorCatalogue.messages.find(
        (m) => m.code === "validation.errors.required",
      )?.message,
    ).toBe("Ce champ est obligatoire.");
    const named = await client({ "accept-language": "en" }).query(
      ERROR_CATALOGUE_QUERY,
      { variables: { language: "FR" } },
    );
    expect(named.data?.errorCatalogue.language).toBe("FR");
  });

  test("its version is what errorCatalogueVersion answers, and differs by language", async () => {
    const versions = await Promise.all(
      (["FR", "EN"] as const).map(async (language) => {
        const full = await client().query(ERROR_CATALOGUE_QUERY, {
          variables: { language },
        });
        const cheap = await client().query(ERROR_CATALOGUE_VERSION_QUERY, {
          variables: { language },
        });
        expect(cheap.data?.errorCatalogueVersion).toBe(
          full.data?.errorCatalogue.version as string,
        );
        return cheap.data?.errorCatalogueVersion;
      }),
    );
    expect(versions[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(versions[0]).not.toBe(versions[1]);
  });

  test("a request without the client header is refused like any other", async () => {
    const bare = graphqlClient(app);
    const result = await bare.query(ERROR_CATALOGUE_VERSION_QUERY);
    expect(result.status).toBe(403);
  });
});
