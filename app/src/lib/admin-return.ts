// The admin's way back after signing in (admin UX pass piece 4c, B19, ruling R-f). A page of the admin opened signed out (a Telegram link to a check,
// a bookmark, SaveStatus's „logi uuesti sisse“) sends her to /admin/login?tagasi=<that page>; the login form sends the value with the request,
// the mailed link carries it as &tagasi=, and the link lands her there. The value comes from a query parameter, so it is an attacker's until
// checked: the login request checks it and the link checks it again (adminReturnPath). Anything else lands on /admin without a word (builder
// notes §5 C8). Plain functions: the middleware, the server and the browser (SaveStatus) use them.

import { UNCLEAN } from "./site-gate";

/** The request header the middleware sets on every /admin request: the path and query asked for (a server component knows neither); requireAdmin reads it. */
export const ADMIN_PATH_HEADER = "x-mslab-path";

/** The longest way back kept, before and after encoding. Nothing in the admin links further; a longer one lands on /admin. */
export const RETURN_MAX = 300;

/** An origin for the check of a path alone (the login page, requireAdmin, SaveStatus): a path with one slash in front keeps whichever origin it is given. */
export const PATH_ORIGIN = "https://mslab.invalid";

/** A tab, a newline or another control character (U+0000–U+001F, U+007F) in `s`? URL parsing drops tabs and newlines without a word, so they are refused before it. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

const ADMIN = /^\/admin(\/|$)/;
const LOGIN = /^\/admin\/login(\/|$)/;

/**
 * `raw` as a way back: a page of the admin on `origin` (/admin or /admin/…, never the login page itself), rebuilt from the parsed path, query and
 * fragment (so what goes into a Location header is encoded), or null. Refused: anything that is not a path with one slash in front (another site,
 * `//evil`, `/\evil`, an absolute URL, `%2F%2Fevil`), what lib/site-gate.ts UNCLEAN refuses in the path (dot segments, encoded dots, slashes and
 * backslashes, a backslash, two slashes in a row), a control character anywhere, and more than RETURN_MAX characters.
 */
export function adminReturnPath(raw: string | null, origin: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > RETURN_MAX) return null;
  if (!raw.startsWith("/") || hasControl(raw) || UNCLEAN.test(raw.split(/[?#]/, 1)[0])) return null;
  let url: URL;
  let base: URL;
  try {
    base = new URL(origin);
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || !ADMIN.test(url.pathname) || LOGIN.test(url.pathname)) return null;
  // the login page written with an encoded letter („/admin/%6Cogin“): the router reads it as the login page
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (LOGIN.test(decoded)) return null;
  const back = url.pathname + url.search + url.hash;
  return back.length > RETURN_MAX ? null : back;
}

/** The login page, with the way back to `path` as ?tagasi= (one encoded value); the plain login page for /admin itself (a sign-in lands there anyway) and for a path that is no way back. */
export function adminLoginHref(path: string | null): string {
  const back = adminReturnPath(path, PATH_ORIGIN);
  return back && back !== "/admin" ? `/admin/login?tagasi=${encodeURIComponent(back)}` : "/admin/login";
}
