import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { LOCAL_ADMINS } from "../local-secrets";
import { onLocalDb, sha256Hex } from "./fixtures";
import { PROD_BUILD } from "./target";
import { expect } from "./test";

// Signing in during the e2e tests (local dev server only).
//
// - Only the first placeholder admin of .env.example is ever used to ask for a login link, never a real address
//   (tests/unit/test-addresses.test.ts keeps every real address out of the repository). Locally the link comes back in
//   the answer (devLink) and is never e-mailed (server/login.ts).
// - One address may hold at most 3 unused links at a time (server/auth.ts LOGIN_TOKEN_CAP), and the workers sign in in
//   parallel. So asking for a link and using it (or deleting it) happens under one lock shared by all worker processes:
//   at most one test link is unused at any moment, and the cap is never reached by the tests themselves.

export const ADMIN = LOCAL_ADMINS[0];

const LOCK = join(tmpdir(), "mslab-e2e-login.lock");
/** A lock older than this was left by a worker that crashed while holding it. */
const STALE_MS = 20_000;
const WAIT_MS = 25_000;
let held = false;

/** Takes the login lock (re-entrant within one worker: its tests run one after the other). */
export async function lockLogin(): Promise<void> {
  if (held) return;
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, "owner"), `${process.pid} ${new Date().toISOString()}`);
      held = true;
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) rmSync(LOCK, { recursive: true, force: true });
    } catch {
      // released meanwhile
    }
    if (Date.now() > deadline) throw new Error("e2e: the login lock was not free within 25 s");
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** Gives the lock back: call it once the test's link is used up or deleted (also safe when not held). */
export function unlockLogin(): void {
  if (!held) return;
  held = false;
  rmSync(LOCK, { recursive: true, force: true });
}

export type CreatedRows = { tokens: Set<string>; sessions: Set<string> };

/**
 * Signs in as Dim through the devLink and lands on /admin; the token and the session cookie go into `created` (the test
 * deletes them afterwards). The link is asked for and used under the login lock.
 */
export async function signInAsAdmin(page: Page, context: BrowserContext, ip: string, created: CreatedRows): Promise<void> {
  if (PROD_BUILD) return signInWithLocalSession(page, context, created);
  await lockLogin();
  try {
    const res = await page.request.post("/api/auth/request", { data: { email: ADMIN }, headers: { "x-forwarded-for": ip } });
    expect(res.status()).toBe(200);
    const { devLink } = (await res.json()) as { devLink?: string };
    expect(devLink, "devLink in the local answer").toBeTruthy();
    const link = new URL(devLink!);
    created.tokens.add(link.searchParams.get("t")!);
    await page.goto(link.pathname + link.search);
    await expect(page).toHaveURL(/\/admin$/);
  } finally {
    unlockLogin();
  }
  const cookie = (await context.cookies()).find((c) => c.name === "__Host-mslab_admin");
  expect(cookie, "session cookie").toBeTruthy();
  created.sessions.add(cookie!.value);
}

/** A login link's lifetime (server/auth.ts TOKEN_TTL_MS). */
const TOKEN_TTL_MS = 15 * 60_000;

/**
 * Against the local production build (E2E_PROD_BUILD) there is no devLink: a production build never returns one, and
 * the e-mail is not sent locally. So the test stores a login link for Dim's address as server/auth.ts createLoginToken
 * would (the SHA-256 of a random token, 15 minutes, in the LOCAL database) and opens it: the app's own /api/auth/verify
 * uses it and sets the session cookie. Dim only.
 */
async function signInWithLocalSession(page: Page, context: BrowserContext, created: CreatedRows): Promise<void> {
  const raw = randomBytes(32).toString("base64url");
  await onLocalDb((sql) => sql`insert into auth_tokens (hash, email, expires_at) values (${sha256Hex(raw)}, ${ADMIN}, ${new Date(Date.now() + TOKEN_TTL_MS)})`);
  created.tokens.add(raw);
  await page.goto(`/api/auth/verify?t=${raw}`);
  await expect(page).toHaveURL(/\/admin$/);
  const cookie = (await context.cookies()).find((c) => c.name === "__Host-mslab_admin");
  expect(cookie, "session cookie").toBeTruthy();
  created.sessions.add(cookie!.value);
}

/**
 * Waits until the admin page has hydrated (<html data-admin-ready>, set by the shell after React's commit). Typing into
 * a controlled editor field before that can be overwritten by the field's server value (seen once under load: a filled
 * textarea came back with the stored text spliced into it).
 */
export async function adminReady(page: Page): Promise<void> {
  await expect(page.locator("html[data-admin-ready]")).toBeAttached({ timeout: 15_000 });
}

/**
 * The page's „Sisu keel“ switch (EditLang.tsx LangSwitch, in the page heading): one tap sets the language of every bilingual field on the page, and the
 * browser keeps the choice (localStorage `mslab-edit-lang`), so a later page of the same test opens in it. Waits until the choice shows.
 */
export async function editLang(page: Page, lang: "et" | "ru"): Promise<void> {
  // (:visible — a page still being swapped in by the stream holds a hidden server copy of itself)
  const segment = page.locator(`[data-edit-lang-switch] [data-edit-lang="${lang}"]:visible`);
  await segment.click();
  await expect(segment).toHaveAttribute("aria-pressed", "true");
}

/**
 * The page-wide „Salvesta“ of an admin editor page: the button of its own save bar (SaveBar.tsx, `data-save-bar`), whichever editor the page is. On
 * Seaded (admin UX pass piece 3b, Task 4) only the legal texts have one, at the foot of their form in „Lepingud ja tingimused“ (the contact
 * contract's card keeps its own „Salvesta lepingud“); every other card autosaves (seadedAutosave).
 */
export const saveBarButton = (page: Page): Locator => page.locator("[data-save-bar]").getByRole("button", { name: "Salvesta", exact: true });

/** The save bar's status line (SaveBar.tsx): on a page that also has a SaveStatus chip (Seaded), the bar's own, not the chip. */
export const saveBarStatus = (page: Page): Locator => page.locator("[data-save-bar] [data-save-status]");

/** Seaded's one SaveStatus (the header's chip, piece 3b Task 4): `data-save-kind` says its state (saved, dirty, saving, invalid, …). */
export const seadedStatus = (page: Page): Locator => page.locator("[data-seaded-head] [data-save-status]");

/**
 * A Seaded card's autosave (piece 3b, Task 4): runs `act` (fields typed and left, a box ticked) and waits for the save of `part` it makes on
 * api/admin/seaded/<part> — its answer, whose status the caller checks. A field left saves at once; a number commits only when it is left.
 */
export async function seadedAutosave(page: Page, part: string, act: () => Promise<unknown>) {
  const answer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/admin/seaded/${part}`, { timeout: 30_000 });
  await act();
  return answer;
}
