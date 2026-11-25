import { definePlugin } from "@softistx/graxia";
import type { ValidationRule } from "graphql";
import { fail } from "../shared/errors";

// A graxia plugin (src/app.ts): `__schema` and `__type` are refused when
// `NODE_ENV=production` (alxia's production guide, "Introspection off in
// production"), allowed everywhere else, so Apollo Sandbox, GraphiQL and the
// specs keep working. The variable is read for each request, not once at start.
// This hides the schema from a client that asks, not from one that guesses
// field names: it is not authorisation. Codegen and `bun run schema:print`
// read the SDL files, never `/graphql`.
// graphql-js's rule, in the app's error shape: `validation.errors.introspection-disabled`
// at each `__schema` or `__type`. The code is in `extensions.code`; the HTTP
// status is graxia's (`status: 400` is ignored on validation errors): 200 for
// an `application/json` client, 400 for `application/graphql-response+json`.
const noIntrospection: ValidationRule = (context) => ({
  Field(node) {
    if (node.name.value === "__schema" || node.name.value === "__type") {
      context.reportError(
        fail("validation.errors.introspection-disabled", { status: 400 }),
      );
    }
  },
});

export const introspectionOnlyInDev = definePlugin({
  name: "ruxia-introspection",
  onValidate: ({ addRule }) => {
    if (process.env["NODE_ENV"] === "production") {
      addRule(noIntrospection);
    }
  },
});
