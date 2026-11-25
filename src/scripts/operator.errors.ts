import { defineCodes } from "../i18n/define-codes";

// The codes the operator's scripts (`admin:create`) answer with
// (`operator.errors.<slug>`): the inventory `ErrorCode` (src/i18n/codes.ts)
// gathers. CONTEXT.md lists them.
export const codes = defineCodes("operator", ["invalid-arguments"]);

// The arguments are checked before anything of the application is loaded, so
// this one is worded by the script itself (code and detail); the catalogue
// carries its text for the clients that list every code.
export class InvalidArguments extends Error {
  readonly code = "operator.errors.invalid-arguments";
}
