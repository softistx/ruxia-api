// The `errorCode`s the API itself writes on a FAILED answer, beside the SDK's
// wire codes (`MODEL_ERROR`, ...). Internal: they are in no GraphQL error
// inventory, a client reads them as `Message.errorCode` (CONTEXT.md, "Runs").

// The server went down under the run (the boot sweep, or `abortAll`).
export const INTERRUPTED = "INTERRUPTED";

// The run passed the longest a run may last.
export const TIMEOUT = "TIMEOUT";

// The answer could not be written when the run ended; the message was
// released by hand.
export const FINALISE_FAILED = "FINALISE_FAILED";
