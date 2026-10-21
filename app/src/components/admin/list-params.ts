// The address of an admin list is its state (admin UX pass, README §1.10): `?otsi=` (search), the page's own filters (`?staatus=`, `?vorm=`,
// `?toimumine=` …), `?leht=` (the page), and `?id=` (the drawer that is open over it). Pure strings, no React: the server pages build their
// drawers' close links with withListParams, and the browser's ListToolbar builds its own replaces with listHref.

/** The parameter of the drawer that is open over a list: it belongs to the drawer, not to the list. */
const DRAWER_PARAM = "id";

/** `href` split into its path, its own query and its hash. */
function parts(href: string): { path: string; query: URLSearchParams; hash: string } {
  const hashAt = href.indexOf("#");
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const rest = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  return { path: queryAt === -1 ? rest : rest.slice(0, queryAt), query: new URLSearchParams(queryAt === -1 ? "" : rest.slice(queryAt + 1)), hash };
}

function join(path: string, query: URLSearchParams, hash: string): string {
  const q = query.toString();
  return `${path}${q ? `?${q}` : ""}${hash}`;
}

/**
 * `href` with the list's own address state added: every parameter of `sp` (the list's current search params) except the drawer's `id`, unless
 * `href` sets it itself. So a drawer's close link and a back link return to the same filtered, searched and paged list:
 * `withListParams("/admin/opilased", sp("vorm=e&otsi=kas&leht=2&id=17"))` is `/admin/opilased?vorm=e&otsi=kas&leht=2`. A hash stays last.
 */
export function withListParams(href: string, sp: URLSearchParams): string {
  const { path, query, hash } = parts(href);
  const own = new Set<string>();
  query.forEach((_value, key) => own.add(key));
  sp.forEach((value, key) => {
    if (key !== DRAWER_PARAM && !own.has(key)) query.append(key, value);
  });
  return join(path, query, hash);
}

/**
 * The list's address with some parameters changed (the toolbar's search and scope): a value sets the parameter, `null` or "" takes it away. The
 * page (`leht`) always goes: a new search or filter starts at page 1. Everything else, the drawer's `id` too, is as it was.
 */
export function listHref(pathname: string, sp: URLSearchParams, change: Record<string, string | null>): string {
  const query = new URLSearchParams(sp.toString());
  query.delete("leht");
  for (const key of Object.keys(change)) {
    const value = change[key];
    if (value === null || value === "") query.delete(key);
    else query.set(key, value);
  }
  return join(pathname, query, "");
}

/** An address as a string: `pathname` and the query of `sp`, with no `?` when there is none. What `useSearchParams` and `listHref` agree on. */
export function addressOf(pathname: string, sp: URLSearchParams): string {
  return join(pathname, sp, "");
}

/** The two halves of an address made by addressOf or listHref. */
export function splitAddress(address: string): { pathname: string; params: URLSearchParams } {
  const { path, query } = parts(address);
  return { pathname: path, params: query };
}
