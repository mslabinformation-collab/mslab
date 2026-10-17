import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { revalidationTargets, type PublicChange } from "@/server/cache-targets";

// Task 17: which cached public pages each change makes stale (server/cache-targets.ts), and how they are revalidated
// (server/public-cache.ts).

const SITE = "/[locale]/(site)";
const paths = (change: PublicChange) => revalidationTargets(change).map((t) => `${t.path}${t.type ? ` (${t.type})` : ""}`);

describe("the revalidation map", () => {
  test("courses: catalogue and every course page, home, calendar, carts", () => {
    expect(paths({ kind: "courses" })).toEqual([`${SITE}/koolitused (layout)`, `${SITE} (page)`, `${SITE}/koolituskalender (page)`, `${SITE}/ostukorv (layout)`]);
  });

  test("sessions (and a session's start): calendar, course pages and catalogue cards, home", () => {
    expect(paths({ kind: "sessions" })).toEqual([`${SITE}/koolitused (layout)`, `${SITE} (page)`, `${SITE}/koolituskalender (page)`]);
  });

  test("seats: that course's page in both languages and the calendar; every course page when the course is not known", () => {
    expect(paths({ kind: "seats", course: "kulmude-lami" })).toEqual(["/et/koolitused/kulmude-lami", "/ru/koolitused/kulmude-lami", `${SITE}/koolituskalender (page)`]);
    expect(paths({ kind: "seats" })).toEqual([`${SITE}/koolitused/[slug] (page)`, `${SITE}/koolituskalender (page)`]);
    expect(paths({ kind: "seats", course: "../x" })).toEqual([`${SITE}/koolitused/[slug] (page)`, `${SITE}/koolituskalender (page)`]);
  });

  test("home, campaign, practice, posts", () => {
    expect(paths({ kind: "home" })).toEqual([`${SITE} (page)`]);
    expect(paths({ kind: "campaign" })).toEqual([`${SITE} (page)`]);
    expect(paths({ kind: "practice" })).toEqual([`${SITE} (page)`, `${SITE}/praktika (page)`]);
    expect(paths({ kind: "posts" })).toEqual([`${SITE}/uudised (layout)`, `${SITE} (page)`]);
  });

  test("trainer: the card (name in the footer) is on every page; the bio on home and course pages; the rest on /koolitaja", () => {
    expect(paths({ kind: "trainer", parts: ["trainer", "works"] })).toEqual([`${SITE} (layout)`]);
    expect(paths({ kind: "trainer", parts: ["bio"] })).toEqual([`${SITE}/koolitaja (page)`, `${SITE} (page)`, `${SITE}/koolitused/[slug] (page)`]);
    expect(paths({ kind: "trainer", parts: ["works", "center_story", "trainer_journey"] })).toEqual([`${SITE}/koolitaja (page)`]);
    expect(paths({ kind: "trainer", parts: [] })).toEqual([]);
  });

  test("settings: contact and newsletter are in the footer of every page; privacy and terms their own pages, terms the course pages too (the contact contract's text until Maria writes hers: contracts, D2)", () => {
    expect(paths({ kind: "settings", parts: ["contact"] })).toEqual([`${SITE} (layout)`]);
    expect(paths({ kind: "settings", parts: ["newsletter", "terms"] })).toEqual([`${SITE} (layout)`]);
    expect(paths({ kind: "settings", parts: ["privacy", "terms"] })).toEqual([`${SITE}/privaatsus (page)`, `${SITE}/tingimused (page)`, `${SITE}/koolitused/[slug] (page)`]);
    expect(paths({ kind: "settings", parts: [] })).toEqual([]);
  });

  test("settings: the e-course terms (course_terms) are the e-course contract every cart shows inline (contracts, D1): saving them revalidates the carts", () => {
    expect(paths({ kind: "settings", parts: ["course_terms"] })).toEqual([`${SITE}/ostukorv (layout)`]);
    // saved together with another part, that part's pages too
    expect(paths({ kind: "settings", parts: ["course_terms", "privacy"] })).toEqual([`${SITE}/privaatsus (page)`, `${SITE}/ostukorv (layout)`]);
    expect(paths({ kind: "settings", parts: ["course_terms", "contact"] })).toEqual([`${SITE} (layout)`]);
  });

  test("settings: Maria's contact contract (contract_contact, Seaded → Lepingud) is the course pages' registration form's contract: saving it revalidates the course pages, once, so a form that refuses a stale version does not show the refusal again for minutes (contracts Task 5)", () => {
    expect(paths({ kind: "settings", parts: ["contract_contact"] })).toEqual([`${SITE}/koolitused/[slug] (page)`]);
    // with "terms" (the same pages) they are listed once, and each other part keeps its own pages
    expect(paths({ kind: "settings", parts: ["contract_contact", "terms"] })).toEqual([`${SITE}/tingimused (page)`, `${SITE}/koolitused/[slug] (page)`]);
    expect(paths({ kind: "settings", parts: ["course_terms", "contract_contact", "privacy"] })).toEqual([`${SITE}/privaatsus (page)`, `${SITE}/koolitused/[slug] (page)`, `${SITE}/ostukorv (layout)`]);
    // the footer's parts revalidate every page already, so the course pages are not named again
    expect(paths({ kind: "settings", parts: ["contract_contact", "contact"] })).toEqual([`${SITE} (layout)`]);
    // the e-course contract is the carts', not the course pages'
    expect(paths({ kind: "settings", parts: ["course_terms"] })).not.toContain(`${SITE}/koolitused/[slug] (page)`);
  });

  test("settings: the prepayment instructions are account-only (the unpaid cards' JSON), so saving them revalidates no public page", () => {
    expect(revalidationTargets({ kind: "settings", parts: ["prepayment"] })).toEqual([]);
    expect(paths({ kind: "settings", parts: ["prepayment", "course_terms"] })).toEqual([`${SITE}/ostukorv (layout)`]);
    expect(paths({ kind: "settings", parts: ["prepayment", "terms"] })).toEqual([`${SITE}/tingimused (page)`, `${SITE}/koolitused/[slug] (page)`]);
    expect(paths({ kind: "settings", parts: ["prepayment", "newsletter"] })).toEqual([`${SITE} (layout)`]);
  });

  test("every route named is a real route of app/[locale]/(site)", () => {
    const all: PublicChange[] = [
      { kind: "courses" },
      { kind: "sessions" },
      { kind: "seats" },
      { kind: "home" },
      { kind: "campaign" },
      { kind: "practice" },
      { kind: "posts" },
      { kind: "trainer", parts: ["bio", "works"] },
      { kind: "trainer", parts: ["trainer"] },
      { kind: "settings", parts: ["privacy", "terms"] },
      { kind: "settings", parts: ["course_terms"] },
      { kind: "settings", parts: ["contract_contact"] },
    ];
    const routes = all.flatMap(revalidationTargets).filter((t) => t.path.startsWith("/["));
    for (const t of routes) {
      const dir = join(process.cwd(), "src/app", t.path);
      expect(existsSync(t.type === "page" ? join(dir, "page.tsx") : dir), `${t.path} ${t.type}`).toBe(true);
    }
  });
});

// revalidatePublic hands each target to Next.js's own revalidatePath(), run here as in a server action: inside a work
// store, where it records the tags it expires.

describe("revalidatePublic", () => {
  // as Next.js's server sets it up before loading next/cache and its request stores
  (globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
  type Pending = { tag: string; profile?: unknown };
  type Store = { pendingRevalidatedTags?: Pending[]; pathWasRevalidated?: unknown };

  /** Runs `fn` with a work store like a server action's; returns what revalidatePath() recorded in it. */
  async function inAction(fn: () => void): Promise<Store> {
    const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
    const store = { route: "/admin/x", page: "/admin/x/page", incrementalCache: {}, cacheLifeProfiles: {} };
    workAsyncStorage.run(store as unknown as Parameters<typeof workAsyncStorage.run>[0], fn);
    return store as Store;
  }

  afterEach(() => vi.restoreAllMocks());

  test("an admin save: Next.js expires the pages' tags at once (no stale copy served), and re-renders the open page", async () => {
    const { revalidatePublic } = await import("@/server/public-cache");
    const store = await inAction(() => revalidatePublic({ kind: "practice" }));
    expect(store.pendingRevalidatedTags).toEqual([
      { tag: "_N_T_/[locale]/(site)/page", profile: undefined, revalidatedAt: expect.any(Number) },
      { tag: "_N_T_/[locale]/(site)/praktika/page", profile: undefined, revalidatedAt: expect.any(Number) },
    ]);
    expect(store.pathWasRevalidated, "the action's answer carries the re-rendered page").toBeTruthy();
  });

  test("a public form (seats): that course's page in both languages and the calendar", async () => {
    const { revalidatePublic } = await import("@/server/public-cache");
    const store = await inAction(() => revalidatePublic({ kind: "seats", course: "kulmude-lami" }));
    expect(store.pendingRevalidatedTags?.map((p) => p.tag)).toEqual(["_N_T_/et/koolitused/kulmude-lami", "_N_T_/ru/koolitused/kulmude-lami", "_N_T_/[locale]/(site)/koolituskalender/page"]);
  });

  test("every target of every change is one revalidatePath() accepts: no warning (a route pattern without its type does nothing)", async () => {
    const { revalidatePublic } = await import("@/server/public-cache");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const changes: PublicChange[] = [
      { kind: "courses" },
      { kind: "sessions" },
      { kind: "seats", course: "kulmude-lami" },
      { kind: "seats" },
      { kind: "home" },
      { kind: "campaign" },
      { kind: "practice" },
      { kind: "posts" },
      { kind: "trainer", parts: ["trainer"] },
      { kind: "trainer", parts: ["bio", "works"] },
      { kind: "settings", parts: ["contact"] },
      { kind: "settings", parts: ["privacy", "terms"] },
      { kind: "settings", parts: ["contract_contact"] },
    ];
    for (const change of changes) {
      const store = await inAction(() => revalidatePublic(change));
      expect(store.pendingRevalidatedTags?.length, JSON.stringify(change)).toBe(revalidationTargets(change).length);
      expect(new Set(store.pendingRevalidatedTags?.map((p) => p.profile)), JSON.stringify(change)).toEqual(new Set([undefined]));
    }
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test("a change that shows nowhere revalidates nothing", async () => {
    const { revalidatePublic } = await import("@/server/public-cache");
    const store = await inAction(() => revalidatePublic({ kind: "settings", parts: [] }));
    expect(store.pendingRevalidatedTags ?? []).toEqual([]);
    const prepayment = await inAction(() => revalidatePublic({ kind: "settings", parts: ["prepayment"] }));
    expect(prepayment.pendingRevalidatedTags ?? []).toEqual([]);
  });

  test("a failing revalidation is logged (route names only), never thrown at the person whose change is stored", async () => {
    const { revalidatePublic } = await import("@/server/public-cache");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // outside a request Next.js has no work store: revalidatePath() throws
    expect(() => revalidatePublic({ kind: "practice" })).not.toThrow();
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      "[public-cache] revalidating /[locale]/(site) failed: Error",
      "[public-cache] revalidating /[locale]/(site)/praktika failed: Error",
    ]);
  });
});
