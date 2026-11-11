// The rules for what an image key may be, shared by the server (server/media.ts, server/edit-check.ts) and the pure rules that run in the browser too
// (domain/newsletter-campaign.ts). Pure, no lookbehind (tests/unit/old-safari.test.ts).

const MEDIA_KEY = /^img\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/**
 * Is this a key putImage could have made? The only keys /media serves. A lesson file (lessons/<uuid>.<ext>,
 * server/lesson-files.ts) is not one, though its extension may be an image's: the img/ prefix keeps it private.
 */
export function isMediaKey(key: string): boolean {
  return MEDIA_KEY.test(key);
}

/**
 * What an upload is for (POST /api/admin/upload?for=…): any picture of the site ("image", the default), or a certificate design's background photo
 * (2026-11-11 certificate designs, spec §4), which the PDF embeds as it was uploaded: a JPEG of at most 1.5 MB (BACKGROUND_UPLOAD), so that the
 * certificate stays small. The browser (components/admin/ImageUpload.tsx) and the server (server/media.ts putImage) hold the same limits.
 */
export const UPLOAD_KINDS = ["image", "certificate-background"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];
export const isUploadKind = (v: unknown): v is UploadKind => typeof v === "string" && (UPLOAD_KINDS as readonly string[]).includes(v);
export const BACKGROUND_UPLOAD = { types: ["image/jpeg"], maxBytes: 1.5 * 1024 * 1024 } as const;

/** Static images shipped with the site (the seed's photos); the only image keys besides uploads. */
const SEED_IMAGE = /^\/seed\/[a-z0-9][a-z0-9._-]*\.(jpe?g|png|webp)$/i;

/** Is this a key the admin may store for a picture: an upload (isMediaKey) or a picture of the site (/seed/…), never an address of another site? */
export const isStorableImageKey = (key: string): boolean => isMediaKey(key) || SEED_IMAGE.test(key);

/**
 * Public URL for a stored image key.
 * "/seed/x.jpg" (static asset) and absolute http(s) URLs are returned as-is; anything else is an R2 key
 * ("img/abc.jpg") served by the /media route. A key starting with two slashes or backslashes ("//host/x.jpg",
 * "/\host/x.jpg") is not a site path but a protocol-relative address of another host, so it is refused (""), as an
 * empty key is.
 */
export function mediaUrl(key: string): string {
  if (!key) return "";
  if (/^[/\\]{2}/.test(key)) return "";
  if (key.startsWith("/") || /^https?:\/\//i.test(key)) return key;
  return "/media/" + key.split("/").map(encodeURIComponent).join("/");
}
