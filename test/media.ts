import type { MediaBucket } from "@softistx/alxia-media";

// A bucket in memory for the specs of the media routes: the three calls the
// routes make (`open`, `put`, `delete`), over a map. The real one is
// `@softistx/s3` over `S3_*` (src/config/media.ts); this one is never served.
export function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const bucket: MediaBucket = {
    async put({ key }, body, options) {
      const bytes = await new Response(body as BodyInit).bytes();
      objects.set(key, { bytes, type: options?.type ?? "" });
    },
    async open({ key }) {
      const found = objects.get(key);
      if (found === undefined) return undefined;
      const { bytes, type } = found;
      return {
        stream: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(),
        size: bytes.byteLength,
        contentLength: bytes.byteLength,
        contentType: type,
        contentEncoding: undefined,
        contentDisposition: undefined,
        cacheControl: undefined,
        eTag: `"${Bun.hash(bytes).toString(16)}"`,
        lastModified: undefined,
        contentRange: undefined,
      };
    },
    async delete({ key }) {
      objects.delete(key);
    },
  };
  return { bucket, objects };
}

// A 64x64 PNG (the smallest side the avatar kind takes), whose first bytes are PNG's.
export const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfFaEY1miH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBds4BLYkT81wAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);
