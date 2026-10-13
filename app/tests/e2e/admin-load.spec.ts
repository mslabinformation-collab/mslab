import { randomBytes } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { signInAsAdmin, type CreatedRows } from "./admin-login";
import { removeAdminRows } from "./fixtures";
import { E2E_REVIEW_KEY } from "./prod-build";
import { PROD_BUILD } from "./target";
import { test, expect } from "./test";

// The production build under load: a burst of signed-in admin pages, one after another and side by side, with public
// pages and public answers that read the database at the same time, all answer (one database pool for the process,
// db/client.ts; the signed-in admin looked up once per request, server/auth.ts). On 02.10.2026 the live Cloudflare
// Worker answered about a quarter of the admin pages with a 500; the check on Vercel (03.10.2026) repeated this by hand.
//
// Local production build only (E2E_PROD_BUILD): it signs in by writing to the local database.

test.skip(!PROD_BUILD, "the production build under load: the local production build only (E2E_PROD_BUILD=1)");
test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");

const ADMIN_PAGES = [
  "/admin",
  "/admin/avaleht",
  "/admin/kalender",
  "/admin/kampaania",
  "/admin/koolitaja",
  "/admin/koolitused",
  "/admin/maksed",
  "/admin/opilased",
  "/admin/paringud",
  "/admin/praktika",
  "/admin/protokollid",
  "/admin/registreerimised",
  "/admin/seaded",
  "/admin/tagasiside",
  "/admin/uudised",
  "/admin/uudiskiri",
];

/** Public pages (cached once rendered: a revalidation by another test renders them again from the database). */
const PUBLIC_PAGES = ["/ru/koolitaja", "/ru/praktika", "/ru/uudised", "/ru/kontakt", "/privaatsus", "/tingimused"];

const created: CreatedRows = { tokens: new Set<string>(), sessions: new Set<string>() };

test.afterAll(async () => {
  await removeAdminRows(created);
});

type Answer = { path: string; status: number; note: string };

async function adminGet(request: APIRequestContext, cookie: string, path: string): Promise<Answer> {
  const res = await request.get(path, { headers: { cookie }, maxRedirects: 0, failOnStatusCode: false });
  const html = await res.text();
  // the admin shell, rendered for the signed-in admin (a failed session lookup is a 500, a lost session a redirect)
  return { path, status: res.status(), note: res.status() === 200 && !html.includes('href="#main"') ? "no admin shell" : "" };
}

async function publicPage(request: APIRequestContext, path: string): Promise<Answer> {
  const res = await request.get(path, { maxRedirects: 0, failOnStatusCode: false });
  await res.body();
  return { path, status: res.status(), note: "" };
}

/** The review comment list: read from the KV table of the database on every request. */
async function commentList(request: APIRequestContext): Promise<Answer> {
  const res = await request.get("/api/feedback", { headers: { "x-key": E2E_REVIEW_KEY }, failOnStatusCode: false });
  const body = (await res.json().catch(() => null)) as { items?: unknown[] } | null;
  return { path: "/api/feedback", status: res.status(), note: Array.isArray(body?.items) ? "" : "no comment list" };
}

/** The newsletter link with a token nobody has: one SELECT; "viga" would mean the database failed. */
async function confirmLink(request: APIRequestContext): Promise<Answer> {
  const res = await request.get(`/api/newsletter/confirm?t=${randomBytes(32).toString("base64url")}`, { maxRedirects: 0, failOnStatusCode: false });
  const outcome = new URL(res.headers()["location"] ?? "/", "http://x").searchParams.get("uudiskiri");
  return { path: "/api/newsletter/confirm", status: res.status(), note: outcome === "vigane" ? "" : `uudiskiri=${outcome}` };
}

const failures = (answers: Answer[], ok: (a: Answer) => boolean) => answers.filter((a) => !ok(a) || a.note).map((a) => `${a.path}: ${a.status} ${a.note}`.trim());

test("signed-in admin pages one after another and side by side, with public answers between them: every answer is right", async ({ page, context, request }) => {
  test.setTimeout(240_000);
  await signInAsAdmin(page, context, "", created);
  const session = (await context.cookies()).find((c) => c.name === "__Host-mslab_admin")!.value;
  const cookie = `__Host-mslab_admin=${session}`;

  const admin: Answer[] = [];
  const pub: Answer[] = [];
  for (let i = 0; i < 40; i++) admin.push(await adminGet(request, cookie, ADMIN_PAGES[i % ADMIN_PAGES.length]));
  for (let round = 0; round < 10; round++) {
    const [answers, publicAnswers, link] = await Promise.all([
      Promise.all([0, 1, 2, 3].map((j) => adminGet(request, cookie, ADMIN_PAGES[(round * 4 + j) % ADMIN_PAGES.length]))),
      Promise.all([...[0, 1].map((j) => publicPage(request, PUBLIC_PAGES[(round * 2 + j) % PUBLIC_PAGES.length])), commentList(request)]),
      confirmLink(request),
    ]);
    admin.push(...answers);
    pub.push(...publicAnswers, link);
  }

  expect(admin).toHaveLength(80);
  expect(failures(admin, (a) => a.status === 200), "admin pages").toEqual([]);
  expect(failures(pub, (a) => (a.path === "/api/newsletter/confirm" ? a.status === 303 : a.status === 200)), "public answers").toEqual([]);
});
