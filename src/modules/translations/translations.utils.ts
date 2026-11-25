import { createHash } from "node:crypto";
import { type Catalogue, parseMessage } from "@softistx/i18n";

export interface TranslationRow {
  _id: string;
  texts: Record<string, string>;
}

const unsafe = new Set(["__proto__", "constructor", "prototype"]);

type Branch = { [key: string]: string | Branch };

const clash = (key: string) =>
  new TypeError(`translations: "${key}" is both a message and a branch`);

// The catalogue of one language: the rows that have a text in it, as the nested
// tree @softistx/alxia-i18n and @softistx/i18n read (`validation.errors.required` is
// `{ validation: { errors: { required } } }`). A key that is both a message and
// the start of another key is refused: the tree cannot hold both.
export function catalogueOf(
  rows: readonly TranslationRow[],
  language: string,
): Catalogue {
  const root: Branch = {};
  for (const row of rows) {
    const text = row.texts[language];
    if (text === undefined) continue;
    const path = row._id.split(".");
    const leaf = path.pop() as string;
    if ([...path, leaf].some((step) => unsafe.has(step))) throw clash(row._id);
    let branch = root;
    for (const step of path) {
      const next = branch[step] ?? {};
      if (typeof next === "string") throw clash(row._id);
      branch[step] = next;
      branch = next;
    }
    if (branch[leaf] !== undefined) throw clash(row._id);
    branch[leaf] = text;
  }
  return root;
}

export interface ErrorMessageView {
  code: string;
  message: string;
}

// The text a dotted code has in a catalogue tree, or undefined when the tree
// has none (a branch is not a message).
export function messageIn(
  catalogue: Catalogue,
  code: string,
): string | undefined {
  let node: unknown = catalogue;
  for (const step of code.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[step];
  }
  return typeof node === "string" ? node : undefined;
}

// Every code's message, in the order of `codes`, each from the first catalogue
// of the chain that has it (the language's, then French's); a code none has is
// left out (the consistency spec keeps that from happening).
export function messagesOf(
  chain: readonly Catalogue[],
  codes: readonly string[],
): ErrorMessageView[] {
  const messages: ErrorMessageView[] = [];
  for (const code of codes) {
    for (const catalogue of chain) {
      const message = messageIn(catalogue, code);
      if (message === undefined) continue;
      messages.push({ code, message });
      break;
    }
  }
  return messages;
}

// JSON with the keys of every object sorted: the same tree is the same string
// whatever the order its keys were merged in.
export function stableJson(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${entries.join(",")}}`;
}

// The version of what a language serves: a digest of its chain's catalogues,
// package defaults and translations merged. It changes when any text of them
// does (a migration, a package upgrade), and not otherwise, so it is the same
// after a restart.
export function versionOf(chain: readonly Catalogue[]): string {
  return createHash("sha256")
    .update(stableJson(chain))
    .digest("hex")
    .slice(0, 32);
}

// What `Query.errorCatalogue` resolves to: the language and its version;
// `messages` is read when it is selected.
export interface CatalogueView {
  language: string;
  version: string;
}

// The language code a `Language` argument names (`FR` is `fr`), or the
// request's when the query names none.
export const languageOf = (
  argument: string | null | undefined,
  requested: string,
): string => argument?.toLowerCase() ?? requested;

// The GraphQL `Language` value (`FR`) of a language code (`fr`).
export function languageValue(code: string): "EN" | "FR" {
  const values = { en: "EN", fr: "FR" } as const;
  if (code !== "en" && code !== "fr") {
    throw new TypeError(`translations: unknown language "${code}"`);
  }
  return values[code];
}

const paramKinds = {
  plain: "TEXT",
  number: "NUMBER",
  date: "DATE",
  plural: "PLURAL",
  select: "SELECT",
} as const;

const kinds: Readonly<Record<string, keyof typeof paramKinds>> = {
  argument: "plain",
  number: "number",
  date: "date",
  plural: "plural",
  select: "select",
};

export interface MessageArgument {
  name: string;
  kind: keyof typeof paramKinds;
}

// The arguments a message names, each once per kind, in order of appearance.
export const messageArguments = (message: string): MessageArgument[] =>
  parseMessage(message).flatMap(({ name, kind }) => {
    const known = kinds[kind];
    return known === undefined ? [] : [{ name, kind: known }];
  });

// The arguments as `ErrorMessage.params` lists them.
export const errorParams = (message: string) =>
  messageArguments(message).map(({ name, kind }) => ({
    name,
    kind: paramKinds[kind],
  }));
