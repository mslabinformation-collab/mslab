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
