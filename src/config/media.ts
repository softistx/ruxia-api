import type { MediaBucket } from "@softistx/alxia-media";
import { bindBucket, defineBucket } from "@softistx/s3";
import { env } from "./env";

// The bucket without storage: every call fails as an unavailable bucket does
// (`ServiceUnavailable`), which the media routes answer 503. What the server
// has without `S3_*`.
const unavailable = async (): Promise<never> => {
  throw Object.assign(new Error("no bucket is configured (S3_*)"), {
    code: "ServiceUnavailable",
  });
};
export const noMedia: MediaBucket = {
  open: unavailable,
  put: unavailable,
  delete: unavailable,
};

// The private bucket the media routes stream from, over `S3_*`: never public,
// no URL ever leaves the API. Without `S3_BUCKET`, `S3_ACCESS_KEY` and
// `S3_SECRET_KEY` it is `noMedia`, and nothing else changes.
export const serverMedia: MediaBucket =
  env.S3_BUCKET === undefined ||
  env.S3_ACCESS_KEY === undefined ||
  env.S3_SECRET_KEY === undefined
    ? noMedia
    : bindBucket(
        defineBucket({
          bucket: env.S3_BUCKET,
          key: (params: { key: string }) => params.key,
        }),
        {
          accessKeyId: env.S3_ACCESS_KEY,
          secretAccessKey: env.S3_SECRET_KEY,
          ...(env.S3_ENDPOINT !== undefined && { endpoint: env.S3_ENDPOINT }),
          ...(env.S3_REGION !== undefined && { region: env.S3_REGION }),
        },
      );
