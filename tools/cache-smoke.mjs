// Read-only smoke test of the deployed site on Vercel. GET and HEAD requests only: nothing is written, no form is sent.
//
//   node tools/cache-smoke.mjs [base] [--only=A,B,C]   (default https://mslab.ee, all three parts)
//
// A. 60 requests one after another, about one per second, across the main pages (ET and RU) and the hub;
// B. 30 requests at the same time, over the same pages.
// A request fails when it ends with anything but 2xx or 3xx (redirects are not followed: /guide -> /guide/ is fine) or
// does not answer within 20 s. Every fifth request is a HEAD, the others GET. The script also counts how Vercel served
// each answer (the x-vercel-cache header: HIT, MISS, STALE, PRERENDER, BYPASS, or "-" when the header is missing).
// C. The client account (phase 2a, with a lesson's shell from phase 3a), 19 GETs, every miss an error:
//    - each /konto… shell twice: 200, no set-cookie, and the second answer from the cache (HIT, PRERENDER or STALE);
//    - /api/konto/me twice without a cookie: 401, cache-control "private, no-store", never answered from the cache (HIT, STALE);
//    - /konto/sisene?viga=link: a 303 to the same path with the parameter moved into the fragment (#viga=link: nothing left in the
//      query, no other host), cache-control no-store.
//    Against a local `next start` (no Vercel CDN in front) the cache is read from x-nextjs-cache when x-vercel-cache is missing.
// The coming-soon gate (SITE_GATE, src/middleware.ts): while it is on, which it is on mslab.ee until the launch, every page is the one
// coming-soon page and a script's call to an /api address is a 404 {"ok":false,"error":"not_found"}. The script asks /api/konto/me
// once first; when it gets that answer it says so, reports A and B as the coming-soon page's cache, and does not check C (the account
// is not served: its answers would be the gate's, "6 errors" about routes nobody changed). C needs the gate off: the site after the
// launch, or a local production build (docs/deploy.md section 3).
// The script exits with 1 when anything failed. A part that was not checked is not a failure; the last line says so.
//
// It is a check to run once after a deployment, not a load test: 110 requests in all.

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="));
const parts = new Set((only ? only.slice("--only=".length) : "A,B,C").split(",").map((p) => p.trim().toUpperCase()));
const base = (args.find((a) => !a.startsWith("--")) ?? "https://mslab.ee").replace(/\/+$/, "");
if (!/^https?:\/\/[^/\s]+$/.test(base)) {
  console.error(`not a site address: ${base} (expected https://host, without a path)`);
  process.exit(2);
}
if ([...parts].some((p) => !["A", "B", "C"].includes(p))) {
  console.error(`--only takes A, B and C, comma separated (got ${only})`);
  process.exit(2);
}

const PAGES = [
  // Estonian
  "/",
  "/koolitused",
  "/koolitused/kulmumeistri-baaskoolitus",
  "/koolituskalender",
  "/praktika",
  "/koolitaja",
  "/uudised",
  // Russian
  "/ru",
  "/ru/koolitused/lash-lift-botox",
  "/ru/praktika",
  "/ru/koolitaja",
  "/ru/uudised",
  // the design hub and a prototype (static files of public/)
  "/guide/",
  "/p/d/",
];
const TIMEOUT_MS = 20_000;
const READ_ONLY = new Set(["GET", "HEAD"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request. Never anything but GET or HEAD. */
async function hit(path, method) {
  if (!READ_ONLY.has(method)) throw new Error(`cache-smoke is read-only: ${method} is not allowed`);
  const started = Date.now();
  try {
    const res = await fetch(base + path, { method, redirect: "manual", headers: { "user-agent": "mslab-cache-smoke" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer(); // the whole answer, as a visitor would wait for it (empty for HEAD)
    const how = (res.headers.get("x-vercel-cache") ?? "-").toUpperCase();
    const ok = res.status >= 200 && res.status < 400;
    return { path, method, status: res.status, ms: Date.now() - started, how, error: ok ? null : `status ${res.status}` };
  } catch (e) {
    return { path, method, status: 0, ms: Date.now() - started, how: "-", error: e instanceof Error ? e.name : "error" };
  }
}

const methodOf = (i) => (i % 5 === 4 ? "HEAD" : "GET");

function count(rows) {
  const served = {};
  for (const r of rows) served[r.how] = (served[r.how] ?? 0) + 1;
  return served;
}

function report(title, rows) {
  const errors = rows.filter((r) => r.error);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n${title}: ${rows.length} requests, ${errors.length} errors; x-vercel-cache ${JSON.stringify(count(rows))}; time median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms.at(-1)} ms`);
  for (const r of errors) console.log(`  ERROR ${r.method} ${r.path}: ${r.error}`);
  return errors.length;
}

// ---------- C. the client account (phase 2a) ----------

/** The account's static shells (Estonian and Russian): served by the CDN, the same for every visitor. */
const SHELLS = [
  "/konto",
  "/ru/konto",
  "/konto/sisene",
  "/ru/konto/sisene",
  "/konto/lemmikud",
  "/konto/andmed",
  // the seed's e-course (any slug-shaped address renders the same shell; a real one adds no cache entry of its own)
  "/konto/kursus/kulmumeistri-e-koolitus",
  // a lesson of it (phase 3a): the same kind of shell, with a lesson id as its second dimension; the content comes from the browser's own API call
  "/konto/kursus/kulmumeistri-e-koolitus/1",
];
const FROM_CACHE = new Set(["HIT", "PRERENDER", "STALE"]);

/** How an answer was served: Vercel's CDN header, else (a local `next start`) Next's own. */
const cacheOf = (res) => (res.headers.get("x-vercel-cache") ?? res.headers.get("x-nextjs-cache") ?? "-").toUpperCase();

/**
 * Is the site behind the coming-soon gate? The gate answers a script's call to /api/konto/me with 404 and `error: "not_found"`
 * (src/middleware.ts); the account's own router answers 401 here, and its 404 for an unknown address has no `error`.
 */
async function behindGate() {
  try {
    const res = await fetch(base + "/api/konto/me", { method: "GET", redirect: "manual", headers: { "user-agent": "mslab-cache-smoke" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json().catch(() => null);
    return res.status === 404 && body?.error === "not_found";
  } catch {
    return false;
  }
}

let probes = 0;

/** One GET of part C, never followed: the status and the headers that matter, or the error. */
async function probe(path) {
  probes++;
  try {
    const res = await fetch(base + path, { method: "GET", redirect: "manual", headers: { "user-agent": "mslab-cache-smoke" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer();
    return { status: res.status, how: cacheOf(res), cookie: res.headers.get("set-cookie"), control: res.headers.get("cache-control") ?? "", location: res.headers.get("location") };
  } catch (e) {
    return { status: 0, how: "-", cookie: null, control: "", location: null, error: e instanceof Error ? e.name : "error" };
  }
}

/** Part C: every problem found, one line each. */
async function account() {
  const problems = [];
  const show = (path, r) => console.log(`C  GET  ${r.status} ${r.how.padEnd(9)} ${path}`);
  for (const path of SHELLS) {
    const first = await probe(path);
    show(path, first);
    const second = await probe(path);
    show(path, second);
    for (const [n, r] of [["1st", first], ["2nd", second]]) {
      if (r.status !== 200) problems.push(`${path} (${n}): status ${r.status}${r.error ? ` ${r.error}` : ""}`);
      if (r.cookie) problems.push(`${path} (${n}): set-cookie on a shared page`);
    }
    if (!FROM_CACHE.has(second.how)) problems.push(`${path}: the second answer is not from the cache (${second.how})`);
  }
  for (const n of ["1st", "2nd"]) {
    const r = await probe("/api/konto/me");
    show("/api/konto/me", r);
    if (r.status !== 401) problems.push(`/api/konto/me (${n}): status ${r.status}, expected 401`);
    if (r.control.replace(/\s+/g, "") !== "private,no-store") problems.push(`/api/konto/me (${n}): cache-control "${r.control}", expected "private, no-store"`);
    if (r.how === "HIT" || r.how === "STALE") problems.push(`/api/konto/me (${n}): answered from the cache (${r.how})`);
  }
  const moved = await probe("/konto/sisene?viga=link");
  show("/konto/sisene?viga=link", moved);
  const to = moved.location ? new URL(moved.location, base) : null;
  if (moved.status !== 303) problems.push(`/konto/sisene?viga=link: status ${moved.status}, expected 303`);
  else if (!to || to.origin !== new URL(base).origin || to.pathname !== "/konto/sisene" || to.search !== "" || to.hash !== "#viga=link")
    problems.push(`/konto/sisene?viga=link: Location ${moved.location}, expected /konto/sisene#viga=link`);
  if (!/(^|,)\s*no-store\s*(,|$)/.test(moved.control)) problems.push(`/konto/sisene?viga=link: cache-control "${moved.control}", expected no-store`);
  return problems;
}

console.log(`cache smoke test against ${base} (${new Date().toISOString()}), parts ${[...parts].sort().join(", ")}`);

const gated = await behindGate();
if (gated) {
  const effects = [];
  if (parts.has("A") || parts.has("B")) effects.push("A and B measure its cache only");
  if (parts.has("C")) effects.push("C (the client account) is not checked: run it once the gate is off (the launch) or against a local production build");
  console.log(`NOTE: ${base} is behind the coming-soon gate (SITE_GATE): every page is the one coming-soon page, so ${effects.join(", and ")}`);
}

let failed = 0;
const ab = [];
if (parts.has("A")) {
  const sequential = [];
  for (let i = 0; i < 60; i++) {
    const r = await hit(PAGES[i % PAGES.length], methodOf(i));
    sequential.push(r);
    console.log(`${String(i + 1).padStart(2)} ${r.method.padEnd(4)} ${r.status} ${String(r.ms).padStart(5)} ms ${r.how.padEnd(9)} ${r.path}`);
    await sleep(Math.max(0, 1000 - r.ms));
  }
  failed += report("A. 60 one after another, about 1/s", sequential);
  ab.push(...sequential);
}
if (parts.has("B")) {
  const parallel = await Promise.all(Array.from({ length: 30 }, (_, i) => hit(PAGES[(i * 5) % PAGES.length], methodOf(i))));
  failed += report("B. 30 at the same time", parallel);
  ab.push(...parallel);
}
if (ab.length) console.log(`\nx-vercel-cache over the ${ab.length} requests of A and B: ${JSON.stringify(count(ab))}`);
const notChecked = [];
if (parts.has("C")) {
  if (gated) {
    console.log("\nC. the client account: NOT CHECKED (the coming-soon gate answers every address)");
    notChecked.push("C");
  } else {
    const problems = await account();
    console.log(`\nC. the client account: ${probes} requests, ${problems.length} errors`);
    for (const p of problems) console.log(`  ERROR ${p}`);
    failed += problems.length;
  }
}
const unchecked = notChecked.length ? ` (part ${notChecked.join(", ")} not checked: the site is behind the coming-soon gate)` : "";
console.log(failed === 0 ? `PASS: 0 errors${unchecked}` : `FAIL: ${failed} errors${unchecked}`);
process.exit(failed === 0 ? 0 : 1);
