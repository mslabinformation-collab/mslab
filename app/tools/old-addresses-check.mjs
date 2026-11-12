// Checks that every page the old WordPress addresses lead to is in the sitemap (SEO G6).
//
//   node tools/old-addresses-check.mjs <sitemap URL or file>
//
// Reads src/data/old-addresses.json (next to this tool, wherever it is run from) and the sitemap once: fetched for an http(s) argument, else
// read as a file. Only the targets a sitemap lists are checked: the public pages (lib/alternates.ts PUBLIC_SITEMAP_PATHS) and the course and post
// pages (/koolitused/<slug>, /uudised/<slug>). Any other target (the private /konto, never in a sitemap) is skipped, and one line says which.
// Every checked target's Estonian address (the target path under the sitemap's own origin) must be a <loc>; the ones whose address is not are
// printed, and the exit code is 1. Otherwise it prints "all N targets are in the sitemap".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MAP_FILE = fileURLToPath(new URL("../src/data/old-addresses.json", import.meta.url));

/** The distinct target paths of the map, in the order they first appear. */
export function targetsOf(/** @type {{ exact: Record<string, string>, prefixes: { to: string }[] }} */ map) {
  return [...new Set([...Object.values(map.exact), ...map.prefixes.map((p) => p.to)])];
}

/** The pages with a fixed address that a sitemap lists (the same list as lib/alternates.ts PUBLIC_SITEMAP_PATHS, which a plain-Node tool cannot import). */
const PUBLIC_PATHS = new Set(["/", "/koolitused", "/koolituskalender", "/praktika", "/koolitaja", "/kontakt", "/uudised", "/privaatsus", "/tingimused"]);
const SLUG_PAGE = /^\/(koolitused|uudised)\/[^/]+$/;

/** Splits the targets into those a sitemap lists (`checked`) and the others (`skipped`, e.g. the private /konto). */
export function splitTargets(/** @type {string[]} */ targets) {
  const checked = targets.filter((t) => PUBLIC_PATHS.has(t) || SLUG_PAGE.test(t));
  return { checked, skipped: targets.filter((t) => !checked.includes(t)) };
}

/** The <loc> values of a sitemap, without a trailing slash. */
export function locsOf(/** @type {string} */ xml) {
  return [...xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map((m) => m[1].replace(/\/+$/, ""));
}

/** The targets whose ET address (any origin: the path alone is compared) is not a <loc> of `xml`. */
export function missingTargets(/** @type {string[]} */ targets, /** @type {string} */ xml) {
  const paths = new Set(
    locsOf(xml).map((loc) => {
      try {
        return new URL(loc).pathname.replace(/\/+$/, "") || "/";
      } catch {
        return loc;
      }
    }),
  );
  return targets.filter((t) => !paths.has(t));
}

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.error("usage: node tools/old-addresses-check.mjs <sitemap URL or file>");
    process.exit(2);
  }
  let xml;
  try {
    xml = /^https?:\/\//i.test(source) ? await fetchText(source) : readFileSync(source, "utf8");
  } catch (error) {
    console.error(`old-addresses-check: cannot read ${source}: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
  const { checked: targets, skipped } = splitTargets(targetsOf(JSON.parse(readFileSync(MAP_FILE, "utf8"))));
  if (skipped.length > 0) console.log(`skipped (not a page a sitemap lists): ${skipped.join(", ")}`);
  const missing = missingTargets(targets, xml);
  if (missing.length > 0) {
    for (const t of missing) console.log(`not in the sitemap: ${t}`);
    process.exit(1);
  }
  console.log(`all ${targets.length} targets are in the sitemap`);
}

async function fetchText(/** @type {string} */ url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error("no answer within 15 seconds");
    throw error;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
