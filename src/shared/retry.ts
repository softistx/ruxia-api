// Runs `write` again when it lost a MongoDB write conflict (code 112, or an
// error labelled `TransientTransactionError`), within a small budget, then
// throws `exhausted()`. `@softistx/mongo`'s `transaction` already reruns its
// callback on a transient error (`retryTransient`, on by default), so this
// wrapper is thin: it covers the conflict that surfaces outside that rerun and
// gives the caller one place to say "the client may send it again".
export const attempts = 5;

export const isWriteConflict = (error: unknown) => {
  const { code, errorLabels } = error as {
    code?: number;
    errorLabels?: string[];
  };
  return (
    code === 112 || errorLabels?.includes("TransientTransactionError") === true
  );
};

export async function retryWriteConflicts<T>(
  write: () => Promise<T>,
  exhausted: () => Error,
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (!isWriteConflict(error)) throw error;
      if (attempt === attempts) throw exhausted();
    }
  }
  throw exhausted();
}
