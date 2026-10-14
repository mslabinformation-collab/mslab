import { FILE_URL_TTL_SEC } from "./lesson-files";
import type { FileStore } from "./media";

// A private object of the store answered to a page that shows it (e-course completion: a practical work's photo, to its student and to
// Maria). On R2 the answer is a 302 to a 5-minute signed address: the browser fetches the object from R2 itself, with the type it was
// stored with, and the bytes never pass through a function. The local folder of `next dev` and the e2e run has no addresses: its bytes come
// back inline. The caller has decided who may see the object; this only answers.

/**
 * A private object for a page that shows it: a 302 to a signed address (5 min) when the store can sign, else the bytes inline. null: the
 * store has no such object (asked only of the local folder: an address is signed without asking R2, which answers its own 404 there).
 * `headers` go on either answer (the caller's cache and referrer rules); the bytes also get `contentType`, inline and nosniff.
 */
export async function privateFileAnswer(store: FileStore, key: string, opts: { contentType: string; headers?: Record<string, string> }): Promise<Response | null> {
  const headers = opts.headers ?? {};
  if (store.signedGetUrl) return new Response(null, { status: 302, headers: { ...headers, location: await store.signedGetUrl(key, { expiresSec: FILE_URL_TTL_SEC }) } });
  const object = await store.get(key);
  if (!object) return null;
  return new Response(object.body, { headers: { ...headers, "content-type": opts.contentType, "content-disposition": "inline", "x-content-type-options": "nosniff" } });
}
