import { isObjectIdString, toObjectId } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import { z } from "zod";
import type { ErrorCode } from "../i18n/codes";
import { type FieldIssue, invalid } from "./errors";

// An id input of a mutation (`ids: [ID!]!`), each id once, in order, with its
// position in the input (`ids.<i>` names a refused one): a repeated id counts
// at its first position.
export function distinctIds(ids: readonly string[]): [number, string][] {
  const seen = new Set<string>();
  const kept: [number, string][] = [];
  for (const [i, id] of ids.entries()) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push([i, id]);
  }
  return kept;
}

// The issue of the id at position `i` of `ids` that `code` refuses.
export const idsIssue = (i: number, code: ErrorCode): FieldIssue => ({
  path: `ids.${i}`,
  code,
});

// The id a list's filter gives (`filter.<name>`): undefined when absent, or
// `validation.errors.invalid` on `filter.<name>` when malformed.
export function filterId(
  given: string | null | undefined,
  name: string,
): ObjectId | undefined {
  if (given === undefined || given === null) return undefined;
  if (!isObjectIdString(given)) {
    throw invalid([
      { path: `filter.${name}`, code: "validation.errors.invalid" },
    ]);
  }
  return toObjectId(given);
}

// The account id a list's filter gives (`filter.<name>`, a janus UUID):
// undefined when absent, or `validation.errors.invalid` on `filter.<name>`
// when malformed.
export function filterAccountId(
  given: string | null | undefined,
  name: string,
): string | undefined {
  if (given === undefined || given === null) return undefined;
  if (!z.uuid().safeParse(given).success) {
    throw invalid([
      { path: `filter.${name}`, code: "validation.errors.invalid" },
    ]);
  }
  return given.toLowerCase();
}
