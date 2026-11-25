import {
  ConflictError,
  NotFoundError,
  OptimisticLockError,
  ValidationError,
} from "@softistx/mongo";
import type { GraphQLError } from "graphql";
import { ZodError } from "zod";
import { invalid } from "./errors";

// A write whose storage errors become the module's refusals: a record gone is
// `notFound`, a lost version lock `stale`, a unique index that refused
// `conflict`, a document the schema refused `validation.errors.invalid` on the
// paths it names. Any other error passes through.
export async function storageErrors<T>(
  write: () => Promise<T>,
  refusals: {
    notFound: () => GraphQLError;
    stale: () => GraphQLError;
    conflict: () => GraphQLError;
  },
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof NotFoundError) throw refusals.notFound();
    if (error instanceof OptimisticLockError) throw refusals.stale();
    if (error instanceof ConflictError) throw refusals.conflict();
    const paths =
      error instanceof ZodError
        ? error.issues.map((issue) => issue.path.join("."))
        : error instanceof ValidationError
          ? error.issues.map((issue) => issue.path)
          : undefined;
    if (!paths) throw error;
    throw invalid(
      paths.map((path) => ({ path, code: "validation.errors.invalid" })),
    );
  }
}
