// Uploaded images, kept in a MediaStore: the Cloudflare R2 bucket through its S3 API (server/r2.ts), or a folder in
// development (server/media-local.ts); server/media-store.ts picks one. The admin's browser shrinks and re-encodes every
// image before it is sent (components/admin/ImageUpload.tsx), but the server trusts none of that: putImage checks the
// declared type, the size and the file's first bytes itself. Keys are img/<random uuid>.<ext>, never the visitor's file
// name, and /media serves nothing else (isMediaKey).

import { isMediaKey } from "@/lib/media";

/**
 * Largest upload accepted (bytes). The browser sends images of at most 2400 px, usually under 2 MB. Vercel Functions
 * refuse a request body over 4.5 MB themselves (a bare 413 the admin page cannot explain), so the limit is below that,
 * with room for the multipart envelope (the upload route's ENVELOPE): the size message comes from this check.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
export type ImageType = keyof typeof IMAGE_TYPES;
const CONTENT_TYPE_OF: Record<string, ImageType> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Why an upload was refused: not JPEG/PNG/WebP, over 4 MB, empty, or bytes that are not the declared image type. */
export type UploadReason = "type" | "size" | "empty" | "content";

export class UploadError extends Error {
  constructor(readonly reason: UploadReason) {
    super(`upload refused: ${reason}`);
    this.name = "UploadError";
  }
}

/**
 * What a store hands back for a key. `contentType` is the type the object was stored with (null: it has none) and
 * `etag` the store's tag for its bytes. A store that does not know them may leave them out: serveMedia then goes by the
 * key's extension and sends no ETag.
 */
export type MediaObject = { body: ReadableStream | ArrayBuffer; contentType?: string | null; etag?: string | null };

/** The reading half of a store: all /media needs. */
export type MediaSource = { get(key: string): Promise<MediaObject | null> };

/**
 * Where images are kept. `put` stores the bytes under the key with their content type (a second put of a key replaces
 * the first) and, when given, the `disposition`: the Content-Disposition kept with the object, a lesson file's download
 * name. `get` is null when there is no such key, and throws when the store cannot be reached.
 */
export type MediaStore = MediaSource & { put(key: string, bytes: ArrayBuffer, contentType: string, disposition?: string): Promise<void> };

/**
 * A store that can also remove an object and, on R2, give a short-lived signed address of one (the lesson files,
 * server/lesson-files.ts): the browser fetches the object from R2 itself, with the type and Content-Disposition it was stored
 * with. `delete` of a key that is not there is fine. The local folder has no addresses: the account API sends its bytes itself.
 */
export type FileStore = MediaStore & {
  delete(key: string): Promise<void>;
  signedGetUrl?(key: string, opts: { expiresSec: number }): Promise<string>;
};

/** A store with nothing in it: /media answers 404 for every key (production without R2 variables). */
export const NO_MEDIA: MediaSource = { get: async () => null };

// (isMediaKey, the rule for a key putImage could have made, is lib/media.ts's: the pure rules share it; it stays importable from here)
export { isMediaKey };

/** The content type that belongs to a media key's extension. */
export function contentTypeOfKey(key: string): ImageType {
  return CONTENT_TYPE_OF[key.slice(key.lastIndexOf(".") + 1)];
}

const startsWith = (bytes: Uint8Array, sig: number[], at = 0) => bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);

/** Do the first bytes look like the declared type? JPEG FF D8 FF, PNG 89 50 4E 47 0D 0A 1A 0A, WebP "RIFF" <size> "WEBP". */
export function hasImageSignature(type: ImageType, head: Uint8Array): boolean {
  switch (type) {
    case "image/jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8);
  }
}

const isImageType = (type: string): type is ImageType => Object.hasOwn(IMAGE_TYPES, type);

/**
 * Stores an uploaded image in the store and returns its key (img/<uuid>.<ext>). Throws UploadError when the declared type
 * is not JPEG/PNG/WebP, the file is empty or over 4 MB, or its first bytes are not that type; whatever the store throws
 * is the store's error. The content type is kept with the object, so /media answers with it.
 */
export async function putImage(store: MediaStore, file: File): Promise<{ key: string }> {
  const type = file.type;
  if (!isImageType(type)) throw new UploadError("type");
  if (file.size === 0) throw new UploadError("empty");
  if (file.size > MAX_IMAGE_BYTES) throw new UploadError("size");
  const bytes = await file.arrayBuffer();
  if (!hasImageSignature(type, new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength)))) throw new UploadError("content");
  const key = `img/${crypto.randomUUID()}.${IMAGE_TYPES[type]}`;
  await store.put(key, bytes, type);
  return { key };
}

// ---------- GET /media/<key> ----------

/** A key never changes its bytes (a new upload gets a new key), so browsers and the edge may keep it for a year. */
export const MEDIA_CACHE = "public, max-age=31536000, immutable";

/**
 * Vercel's CDN caches a function's response only when told to: by s-maxage, or by CDN-Cache-Control /
 * Vercel-CDN-Cache-Control, which are for the CDN alone (Vercel strips this one; the browser goes by Cache-Control).
 * Without it every first view per visitor and region would be a function call and a read from R2. Sent with the image
 * only: a 404 stays no-store, so an image asked for too early is not remembered as missing.
 */
export const MEDIA_CDN_CACHE_HEADER = "vercel-cdn-cache-control";

/**
 * An image is only ever shown inside our pages; this keeps a stray SVG-like payload from running as a document.
 * next.config.ts gives /media the same value (its headers() would otherwise replace the route's own).
 */
export const MEDIA_CSP = "default-src 'none'; sandbox";

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/**
 * The answer for /media/<key>: 404 unless the key is one putImage makes and the object exists; otherwise the bytes with
 * the stored image type (or the one of the extension when the stored one is not an image type we allow), nosniff, the
 * immutable cache header and the same for Vercel's CDN (MEDIA_CDN_CACHE_HEADER).
 */
export async function serveMedia(store: MediaSource, key: string): Promise<Response> {
  if (!isMediaKey(key)) return notFound();
  const object = await store.get(key);
  if (!object) return notFound();
  const stored = object.contentType ?? "";
  const contentType = isImageType(stored) && stored === contentTypeOfKey(key) ? stored : contentTypeOfKey(key);
  return new Response(object.body, {
    headers: {
      "content-type": contentType,
      "cache-control": MEDIA_CACHE,
      [MEDIA_CDN_CACHE_HEADER]: MEDIA_CACHE,
      ...(object.etag ? { etag: object.etag } : {}),
      "x-content-type-options": "nosniff",
      "content-security-policy": MEDIA_CSP,
    },
  });
}
