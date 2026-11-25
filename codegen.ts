import type { CodegenConfig } from "@graphql-codegen/cli";
import {
  clientCodegenScalars,
  codegenScalars,
} from "@softistx/graphql-scalars";

// `bun run generate` writes, from every src/**/*.graphqls and the SDL of
// @softistx/graphql-scalars and @constraint (generated/graphql/):
// - src/generated/graphql/resolvers.ts: the schema's types and `Resolvers`,
//   whose context is the app's own (`Context`, src/http/context.ts). A module maps
//   a type to the document its model stores with `mappers`.
// - src/generated/graphql/zod.ts: the Zod schemas of the inputs.
// - test/generated/graphql/: `graphql()`, which types each operation written
//   in a test/**/*.spec.ts, its variables and its result.
const schema = ["src/**/*.graphqls", "generated/graphql/**/*.graphqls"];

// `ignoreNoDocuments`: the image's build context has no spec file
// (.dockerignore), so the client has no operation to type there.
const config: CodegenConfig = {
  schema,
  ignoreNoDocuments: true,
  generates: {
    "src/generated/graphql/resolvers.ts": {
      plugins: ["typescript", "typescript-resolvers"],
      config: {
        contextType: "@/http/context#Context",
        scalars: codegenScalars,
        useTypeImports: true,
        useIndexSignature: true,
        // Enums as unions of their values: what the models store.
        enumsAsTypes: true,
        // A module maps a GraphQL type to the document it is read from:
        // `Subject: "@/modules/catalog#SubjectDocument"`.
        // The role enum resolves to the stored role names (src/auth/access.ts).
        enumValues: { Role: { ADMIN: "admin", MEMBER: "member" } },
        mappers: {
          Passkey: "@softistx/janus#Passkey as JanusPasskey",
          Viewer: "@/auth/viewer#ViewerModel",
          Member: "@/modules/members#MemberDocument",
          Invitation: "@/modules/invitations#InvitationView",
          ErrorCatalogue: "@/modules/translations#CatalogueView",
          ErrorMessage: "@/modules/translations#ErrorMessageView",
        },
      },
    },
    "src/generated/graphql/zod.ts": {
      plugins: ["@softistx/graphql-codegen-zod"],
      config: { scalarSchemas: "@softistx/graphql-scalars" },
    },
    "test/generated/graphql/": {
      documents: [
        "test/**/*.spec.ts",
        "src/**/*.spec.ts",
        "src/**/*.documents.ts",
      ],
      preset: "client",
      presetConfig: { fragmentMasking: false },
      config: {
        scalars: clientCodegenScalars,
        useTypeImports: true,
        enumsAsTypes: true,
      },
    },
  },
};

export default config;
