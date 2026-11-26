import { type Throttle, Throttled } from "./throttle";

// The throttle every `/media` kind that members upload shares: one count per
// account (`throttle.uploads`), the `ThrottleDecision` the media routes read
// (`true` lets it through, a number is the seconds to wait). It fails open: a
// down store lets the upload through (`unthrottled`, src/limits/throttle.ts).
export const uploadThrottle =
  (throttle: Pick<Throttle, "uploads">) =>
  async ({ viewer }: { viewer: { id: string } | null }) => {
    if (viewer === null) return true;
    try {
      await throttle.uploads(viewer.id)();
      return true;
    } catch (error) {
      if (error instanceof Throttled) return error.retryAfter;
      throw error;
    }
  };
