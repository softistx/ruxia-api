import {
  invalidInputError,
  type Translate,
} from "@softistx/graphql-validation";
import { GraphQLError, type GraphQLErrorOptions } from "graphql";
import { IntlMessageFormat } from "intl-messageformat";
import { i18n } from "../../i18n";
import type { ErrorCode } from "../../i18n/codes";
import type { Params } from "../../i18n/params";
import { textsOfCode } from "../../i18n/served-texts";

// Under `bun test` (NODE_ENV=test), a refusal whose text names an argument its
// params do not give is a bug in the producer: the formatter would swallow it
// and answer the raw text. So every refusal and every field issue is checked
// against the text of both languages (formatted, so only the branches the
// params select need their arguments), and throws naming the code and the
// missing argument. Off otherwise: a request never pays for it.
function assertParams(code: string, params: Params | undefined) {
  if (Bun.env.NODE_ENV !== "test") return;
  for (const { language, message } of textsOfCode(code)) {
    if (message === undefined) continue;
    try {
      // Only the arguments of the branches the params select are needed.
      new IntlMessageFormat(message, language).format(params ?? {});
    } catch (error) {
      throw new Error(
        `${code}: the ${language} text cannot be formatted with ${JSON.stringify(Object.keys(params ?? {}))}: ${(error as Error).message}`,
      );
    }
  }
}

// A refused operation: `extensions.code` is the error code, stable, which
// clients map to their own translation; `message` is that key translated in
// the request's language, their fallback; `extensions.params`, when given, are
// the values that message interpolates, so a client can word the refusal
// itself; `extensions.http.status`, when given, is the HTTP status graxia
// answers a top-level failure with. A refusal about an input field is an issue
// of `invalidInput`, not a code of its own.
export function fail(
  code: ErrorCode,
  options: {
    params?: Params;
    status?: number;
    field?: string;
    // More `extensions` a client reads (additive to code, field, params).
    extensions?: Record<string, unknown>;
  } = {},
): GraphQLError {
  assertParams(code, options.params);
  return new GraphQLError(i18n.t(code, options.params), {
    extensions: {
      ...options.extensions,
      code,
      // The input field a refusal is about (a conflict that no `@constraint`
      // can name), for the client to show beside it.
      ...(options.field && { field: options.field }),
      ...(options.params && { params: options.params }),
      ...(options.status && { http: { status: options.status } }),
    },
  });
}

// janus's store (sessions, accounts, relations) could not answer: 503, never a
// refusal, which would read as "signed out" or "not allowed".
export const unavailable = () =>
  fail("auth.errors.unavailable", { status: 503 });

// Concurrent writes kept beating this one: `retryWriteConflicts` gave up after
// its attempts. 409, the client may send the request again.
export const exhausted = () => fail("auth.errors.exhausted", { status: 409 });

// The params of a refusal that says when to try again: `retryAfter` in whole
// seconds and `minutes`, the same wait rounded up to whole minutes (at least
// 1), which the messages word instead of counting seconds.
export const retryParams = (retryAfter: number) => ({
  retryAfter,
  minutes: Math.max(1, Math.ceil(retryAfter / 60)),
});

// One refused field of an input: `path` is relative to the input ("name",
// "person.firstName"), `code` an error code, `params` the values its message
// interpolates, passed on to clients.
export interface FieldIssue {
  path: string;
  code: ErrorCode;
  params?: Params;
}

// The request's language, for the builders of @softistx/graphql-validation.
const translate: Translate = (code, params) => {
  assertParams(code, params);
  return i18n.t(code as ErrorCode, params);
};

// An input refused as a whole, with every field that refused it: one error
// whatever the module, `validation.errors.invalid-input`, status 400, and
// `extensions.fields: [{ path, code, message, params? }]`, each message
// translated (@softistx/graphql-validation's `invalidInputError`).
export const invalidInput = (
  issues: FieldIssue[],
  options: GraphQLErrorOptions = {},
): GraphQLError => invalidInputError(issues, { ...options, translate });

// An input refused, with every field that refused it.
export const invalid = (issues: FieldIssue[]) => invalidInput(issues);

// A non-nullable field an update gives as null: it cannot be cleared.
export function required<T extends object>(
  input: T,
  keys: readonly (keyof T & string)[],
): FieldIssue[] {
  return keys
    .filter((key) => input[key] === null)
    .map((path) => ({ path, code: "validation.errors.required" }));
}
