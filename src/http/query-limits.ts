import { maxDepth, maxFields, maxListCost } from "@softistx/graphql-validation";
import { definePlugin } from "@softistx/graxia";
import { GraphQLError, type ValidationRule } from "graphql";
import { fail } from "../shared/errors";

// What a request may ask, checked from the document before anything runs.
//
// The schema will have cycles (a type that lists the types that refer back to
// it), so without a bound any caller could send a query whose cost grows
// exponentially with its depth. Three bounds:
//
// - `MAX_QUERY_DEPTH`: `maxDepth` of @softistx/graphql-validation. A screen walks
//   a few levels down the catalogue; 10 leaves margin and stops a cycle walked
//   a few times.
// - `MAX_QUERY_COST`: `maxListCost`, the estimated number of records the
//   operation touches. A field costs 1, times the sizes of the lists enclosing
//   it; a list is sized by its `first` (a literal as given; a variable counts
//   at its largest bound, the `@constraint(max)` of the argument: 100; a
//   negative value as the SDL default; a connection's `edges` take its
//   `first`; a list with no `first` as `DEFAULT_LIST_SIZE`). 100 000 leaves
//   margin over the heaviest legitimate document and stops a cycle walked at
//   its defaults (50 per lap: millions after a few laps).
// - `MAX_QUERY_FIELDS`: `maxFields`, the field selections of an operation,
//   aliases and `__typename` counted, a fragment counted at each use.
//   `maxListCost` does not bound breadth: 2000 aliases of a cheap query, or 3000
//   `__typename`, cost little each.
export const MAX_QUERY_DEPTH = 10;
export const MAX_QUERY_COST = 100_000;
export const MAX_QUERY_FIELDS = 500;

// The size of a list the document does not size: the schema's default page for
// the nested lists (50). A list with a `first` of its
// own takes that (else its SDL default), and a connection's `edges` the
// connection's `first`. Every size argument of the schema (`first`) means a page
// size, so `sizeArguments` keeps the package's default.
export const DEFAULT_LIST_SIZE = 50;

// The page maximum: every `first` of the schema has `@constraint(max: 100)`.
// `maxListCost` already sizes a variable `first` at that maximum (0.8.0); this
// is the safety net for a size argument that declares no bound.
export const MAX_PAGE_SIZE = 100;

const numberOf = (value: unknown) => (typeof value === "number" ? value : 0);

// The app's shape of a package refusal, found by `extensions.code` (never by
// its message), at the operation's location: the stable codes, with the
// numbers the messages and clients use. The code is in `extensions.code`; the
// HTTP status is graxia's, not `extensions.http.status` (`status: 400` below is
// ignored on validation errors): 200 for an `application/json` client, 400 for
// `application/graphql-response+json` (src/http/validation-status.spec.ts). Any other error as it is.
function reshaped(error: GraphQLError): GraphQLError {
  const { code, depth, cost, fields, limit } = error.extensions;
  const refusal =
    code === "QUERY_TOO_DEEP"
      ? fail("validation.errors.query-too-deep", {
          params: { depth: numberOf(depth), max: numberOf(limit) },
          status: 400,
        })
      : code === "QUERY_TOO_COSTLY"
        ? fail("validation.errors.query-too-costly", {
            params: { cost: numberOf(cost), maxCost: numberOf(limit) },
            status: 400,
          })
        : code === "QUERY_TOO_WIDE"
          ? fail("validation.errors.query-too-wide", {
              params: { fields: numberOf(fields), maxFields: numberOf(limit) },
              status: 400,
            })
          : undefined;
  if (!refusal) return error;
  return new GraphQLError(refusal.message, {
    nodes: error.nodes ?? null,
    extensions: refusal.extensions,
  });
}

// The rule, reporting its refusals in the app's shape: graxia refuses a
// `setResult` in an `onValidate` after-hook, so the errors are reshaped as the
// rule reports them.
const reshaping =
  (rule: ValidationRule): ValidationRule =>
  (context) =>
    rule(
      new Proxy(context, {
        get(target, property) {
          if (property === "reportError") {
            return (error: GraphQLError) => target.reportError(reshaped(error));
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );

// A graxia plugin (src/app.ts) adding the three rules to every request's
// validation and giving their refusals the app's shape. graxia's own `limits`
// (depth, aliases, root fields, cost) are off in src/app.ts: these are the
// app's.
//
// `ignoreIntrospection` is true in every environment for the depth and the cost: in production
// `introspectionOnlyInDev` already refuses `__schema` and `__type`, so a limit
// on top would only bury that refusal under a second one; elsewhere the
// standard introspection query is 15 levels deep and costs about 200 000, so
// Apollo Sandbox, GraphiQL and codegen tooling would be refused. `maxFields` does
// not ignore it: the standard query selects 220 fields, under the 500 limit, and
// counting it keeps a hostile repetition of `__schema` aliases bounded outside
// production.
export const queryLimits = definePlugin({
  name: "ruxia-query-limits",
  onValidate: ({ addRule }) => {
    addRule(
      reshaping(
        maxDepth({ depth: MAX_QUERY_DEPTH, ignoreIntrospection: true }),
      ),
    );
    addRule(
      reshaping(
        maxListCost({
          budget: MAX_QUERY_COST,
          defaultFirst: DEFAULT_LIST_SIZE,
          variableSize: MAX_PAGE_SIZE,
          ignoreIntrospection: true,
        }),
      ),
    );
    addRule(reshaping(maxFields({ limit: MAX_QUERY_FIELDS })));
  },
});
