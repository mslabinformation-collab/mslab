// The admin menu folded to its icons or not (Dim 13.11): a cookie, so the server paints the next page as it was left, with no jump on its first
// paint (Shell.tsx reads it; Sidebar.tsx writes it). Only on /admin, a year; absent = the wide menu. Not a secret and not for the server's
// decisions: the sidebar's look only.

export const NAV_COOKIE = "mslab-admin-nav";

/** The cookie's one value: the menu folded to its icons. */
export const NARROW = "narrow";

/** The Set-Cookie line `document.cookie` takes for the choice (Secure on https; a cleared choice is the cookie gone). */
export function navCookie(narrow: boolean, https: boolean): string {
  const tail = `; Path=/admin; SameSite=Lax${https ? "; Secure" : ""}`;
  return narrow ? `${NAV_COOKIE}=${NARROW}; Max-Age=31536000${tail}` : `${NAV_COOKIE}=; Max-Age=0${tail}`;
}
