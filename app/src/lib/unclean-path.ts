// One fact shared by the coming-soon gate (lib/site-gate.ts, server side) and the admin's way back after signing in (lib/admin-return.ts, which
// SaveStatus runs in the browser too). A leaf of its own, so the browser gets this pattern without the gate and its cookie signing.

/**
 * A path the router could read as another one: a dot segment ("/admin/../konto"), an encoded dot, slash or backslash, a backslash, or two slashes
 * in a row. A browser never sends one (the URL parser removes real dot segments before the middleware sees the path).
 */
export const UNCLEAN = /(^|\/)\.{1,2}(\/|$)|%2e|%2f|%5c|\\|\/\//i;
