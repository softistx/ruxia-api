import { defineCodes } from "../../i18n/define-codes";
import { Throttled } from "../../limits/ports";
import { fail, retryParams } from "../../shared/errors";

// The module's refusals (CONTEXT.md lists their codes). `not-found` covers a
// conversation that does not exist, is deleted, or is another member's: the
// three look alike on purpose, the admin's included. `invalid-parent` and
// `invalid-emoji` are field issues (`parentId`, `emoji`); `run-in-progress` is
// the send's and `run-not-found` the stop's and the run stream's.
export const codes = defineCodes("conversations", [
  "not-found",
  "invalid-cursor",
  "invalid-parent",
  "run-in-progress",
  "run-not-found",
  "model-unavailable",
  "persona-unavailable",
  "too-many-messages",
  "message-not-found",
  "not-editable",
  "not-regenerable",
  "invalid-emoji",
  "reaction-limit",
  "restore-expired",
  "too-many-exports",
]);

// An id that names no conversation of the viewer (or a malformed one).
export const notFound = () =>
  fail("conversations.errors.not-found", { status: 404 });

// A cursor that does not belong to this list.
export const invalidCursor = () =>
  fail("conversations.errors.invalid-cursor", { status: 400 });

// An answer is still being written in this conversation: wait for it or stop
// it.
export const runInProgress = () =>
  fail("conversations.errors.run-in-progress", { status: 409 });

// A run id that names no run of the viewer.
export const runNotFound = () =>
  fail("conversations.errors.run-not-found", { status: 404 });

// `modelId` names no model, or one an administrator has not enabled. An
// Ollama model that is merely offline is accepted here.
export const modelUnavailable = () =>
  fail("conversations.errors.model-unavailable", {
    status: 409,
    field: "modelId",
  });

// The conversation's persona can no longer be read by the viewer (it was made
// PRIVATE by someone else): the conversation stays readable, not continuable.
export const personaUnavailable = () =>
  fail("conversations.errors.persona-unavailable", { status: 409 });

// An id that names no message of the viewer's live conversations (or a
// malformed one): another member's, the admin's included.
export const messageNotFound = () =>
  fail("conversations.errors.message-not-found", { status: 404 });

// Only a member's own message can be edited: not an answer.
export const notEditable = () =>
  fail("conversations.errors.not-editable", { status: 409 });

// Only an answer can be regenerated: not a member's message.
export const notRegenerable = () =>
  fail("conversations.errors.not-regenerable", { status: 409 });

// A message already carries the most reactions it may.
export const reactionLimit = () =>
  fail("conversations.errors.reaction-limit", { status: 409 });

// The 30 days a deleted conversation can be restored in have passed.
export const restoreExpired = () =>
  fail("conversations.errors.restore-expired", { status: 409 });

// Past the exports' limit: when to try again, in seconds and minutes.
export const tooManyExports = (retryAfter: number) => {
  const params = retryParams(retryAfter);
  return fail("conversations.errors.too-many-exports", {
    status: 429,
    params,
    extensions: params,
  });
};

// Counts an export against the account's limit; a refusal is 429.
export async function limitedExport(limit: () => Promise<void>) {
  try {
    await limit();
  } catch (error) {
    if (error instanceof Throttled) throw tooManyExports(error.retryAfter);
    throw error;
  }
}

// Past the sends' limit: when to try again, in seconds and minutes.
export const tooManyMessages = (retryAfter: number) => {
  const params = retryParams(retryAfter);
  return fail("conversations.errors.too-many-messages", {
    status: 429,
    params,
    extensions: params,
  });
};

// Counts a send against the account's limit; a refusal is 429.
export async function limitedSend(limit: () => Promise<void>) {
  try {
    await limit();
  } catch (error) {
    if (error instanceof Throttled) throw tooManyMessages(error.retryAfter);
    throw error;
  }
}
