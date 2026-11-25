import { defineCodes } from "../../i18n/define-codes";
import { fail } from "../../shared/errors";
import type { ModelDocument } from "./models.model";

// The module's refusals (CONTEXT.md lists their codes). `disabled` and
// `offline` are what a send to a model answers (`requireAvailable`).
export const codes = defineCodes("models", [
  "not-found",
  "disabled",
  "offline",
]);

// An id that names no model of the catalogue.
export const notFound = () => fail("models.errors.not-found", { status: 404 });

// The raw id beside the label the message prints.
const named = (model: Pick<ModelDocument, "_id" | "label">) => ({
  modelId: model._id,
  label: model.label,
});

// The model exists but an admin has not enabled it.
export const disabled = (model: Pick<ModelDocument, "_id" | "label">) =>
  fail("models.errors.disabled", { status: 409, params: named(model) });

// The model's server does not answer (the Mac is off): try another model.
export const offline = (model: Pick<ModelDocument, "_id" | "label">) =>
  fail("models.errors.offline", { status: 409, params: named(model) });
