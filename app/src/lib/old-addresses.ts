// The old WordPress site's addresses and the new page each one leads to (SEO G6). The map is src/data/old-addresses.json, which
// tools/old-addresses-check.mjs also reads (every target must be in the sitemap). The old site was Estonian only: no /ru.

import map from "@/data/old-addresses.json";

const EXACT: Readonly<Record<string, string>> = map.exact;
const PREFIXES: readonly { prefix: string; to: string }[] = map.prefixes;

/**
 * The new page for an old address. `path` is canonicalPath(pathname) lowercased: exact addresses first, then the first
 * prefix rule whose prefix the path starts with. null: not an old address.
 */
export function oldAddressTarget(path: string): string | null {
  if (Object.prototype.hasOwnProperty.call(EXACT, path)) return EXACT[path];
  // (the bare root of a prefix, "/product", is the shop's own page: it goes to the same target)
  for (const rule of PREFIXES) if (path.startsWith(rule.prefix) || path === rule.prefix.slice(0, -1)) return rule.to;
  return null;
}
