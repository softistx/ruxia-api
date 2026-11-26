import { defineCodes } from "../../i18n/define-codes";
import { fail } from "../../shared/errors";
import { MAX_ITEMS } from "./memory.rules";

// The module's refusals (CONTEXT.md lists their codes). `not-found` covers an
// item that does not exist or is another member's: the two look alike on
// purpose, the admin's included. `full`: the persona already holds the most
// items a member may keep for it.
export const codes = defineCodes("memory", ["not-found", "full"]);

export const itemNotFound = () =>
  fail("memory.errors.not-found", { status: 404 });

export const memoryFull = () =>
  fail("memory.errors.full", { status: 409, params: { max: MAX_ITEMS } });
