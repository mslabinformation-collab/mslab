import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { mailSuppressions, newsletterCampaigns, settings, subscribers } from "@/db/schema";
import type { Env } from "@/server/notify";
import { ensureSegments, SEGMENT_NAMES, SYNC_LEASE_SETTING, type MarketingDeps } from "@/server/resend-marketing";
import { fakeKv, stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";
import { DOWN, fakeResend, type FakeResend } from "./resend-fake";

// Maria's „Sünkrooni Resendiga“ on a real (PGlite) database and Resend as an in-memory fake (newsletter campaigns, Task 3; spec D2, D8, §5): what the
// action answers (the full sync's report as it is, or one of four refusals), that a sync that ran refreshes the open page and one that did not does
// not, that the key which can only send is told apart from Resend being down (ledger note for Task 3: the real SDK's answer to a restricted key is
// tried here too, with a stubbed fetch), that a failure is logged by its class and ids only, and that the deps carry SITE_URL (never the request's
// address) and the interactive time budget. The admin session, the cache and the request are stand-ins (the guard is tests/unit/admin-guards.test.ts's).

const state = vi.hoisted(() => ({ db: null as unknown, fake: null as unknown, budgets: [] as (number | undefined)[] }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => cache);
// (the sync must never read the request: a read fails loudly)
vi.mock("next/headers", () => ({
  headers: async () => {
    throw new Error("the newsletter sync read the request's headers");
  },
}));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
// the real deps builder, with the in-memory Resend and no pause between calls put into its deps (state.fake null: the real SDK, on a stubbed fetch)
vi.mock("@/server/send-deps", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/send-deps")>();
  return {
    ...real,
    adminMarketingDeps: (budgetMs?: number) => {
      state.budgets.push(budgetMs);
      const fake = state.fake as FakeResend | null;
      return { ...real.adminMarketingDeps(budgetMs), ...(fake ? { resend: fake.r, gapMs: 0 } : {}) };
    },
  };
});

const actions = await import("@/server/actions/admin-newsletter");
const { ADMIN_SYNC_BUDGET_MS, adminMarketingDeps } = await import("@/server/send-deps");
const { adminEt } = await import("@/i18n/dict/admin");

const SITE = "https://mslab.example";
const NOW = new Date();
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let db: Db;
let fake: FakeResend;

let n = 0;
/** A confirmed subscriber (an hour before now) unless told otherwise. */
async function sub(email: string, o: Partial<typeof subscribers.$inferInsert> = {}) {
  const [row] = await db
    .insert(subscribers)
    .values({ email, locale: "et", token: `tok${++n}`, consentAt: at(-60), confirmedAt: at(-60), ...o })
    .returning();
  return row;
}
const rowOf = async (email: string) => (await db.select().from(subscribers).where(eq(subscribers.email, email)))[0];

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
});
beforeEach(async () => {
  await db.delete(subscribers);
  await db.delete(mailSuppressions);
  await db.delete(settings);
  fake = fakeResend();
  state.fake = fake;
  state.budgets.length = 0;
  cache.refresh.mockReset();
  vi.stubEnv("SITE_URL", SITE);
  vi.stubEnv("RESEND_MARKETING_KEY", "re_marketing_test");
  vi.stubEnv("RESEND_API_KEY", "");
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every line the sync logged, joined. */
const logged = () =>
  (["info", "error", "warn", "log"] as const)
    .flatMap((m) => (console[m] as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat())
    .map(String)
    .join("\n");

/** The deps the sync would run on, for the setup that has to be done before a press (the segments and the property). */
const setup = (): MarketingDeps => {
  const env: Env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example.test>", MARIA_EMAIL: "maria@example.com", SITE_URL: SITE, RESEND_MARKETING_KEY: "re_marketing_test" };
  return { db, env, siteUrl: SITE, now: NOW, resend: fake.r, gapMs: 0 };
};

describe("fullSyncAction: without the newsletter's key", () => {
  test("`notConfigured`: Resend is not asked, nothing is stored or refreshed, and nothing is logged as a failure", async () => {
    vi.stubEnv("RESEND_MARKETING_KEY", "");
    await sub("kati@example.com");
    expect(await actions.fullSyncAction()).toEqual({ error: "notConfigured" });
    expect(fake.calls).toEqual([]);
    expect((await rowOf("kati@example.com")).syncedAt).toBeNull();
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  test("RESEND_API_KEY alone is a key too (the marketing key falls back to it)", async () => {
    vi.stubEnv("RESEND_MARKETING_KEY", "");
    vi.stubEnv("RESEND_API_KEY", "re_send_only_name");
    await sub("kati@example.com");
    expect(await actions.fullSyncAction()).toMatchObject({ added: 1, finished: true });
  });
});

describe("fullSyncAction: a sync that ran", () => {
  test("answers the full sync's report as it is, and the open page is refreshed once", async () => {
    await ensureSegments(setup());
    const et = fake.segment(SEGMENT_NAMES.et)!;
    // Mari unsubscribed in Resend (her row goes, her contact with it); Anu is synced and Resend suppresses her address; Kati is new
    const mari = fake.add("mari@example.com", { unsubscribed: true, segments: [et] });
    await sub("mari@example.com", { syncedAt: at(-30), resendContactId: mari.id });
    const anu = fake.add("anu@example.com", { segments: [et] });
    await sub("anu@example.com", { syncedAt: at(-30), resendContactId: anu.id });
    fake.suppressions.push({ id: "sup_1", email: "anu@example.com", origin: "bounce", source_id: null, created_at: "2026-10-18T10:00:00.000Z" });
    await sub("kati@example.com");

    const report = await actions.fullSyncAction();
    expect(report).toEqual({
      contacts: 2,
      added: 1,
      updated: 0,
      removed: 1,
      unsubscribedPulled: 1,
      suppressed: 1,
      unsynced: 0,
      failed: 0,
      limitReached: false,
      finished: true,
    });
    expect(await rowOf("mari@example.com")).toBeUndefined();
    expect((await rowOf("kati@example.com")).syncedAt).toBeInstanceOf(Date);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("the contact limit is in the report (`limitReached`, the rows left out in `unsynced`); the page is refreshed", async () => {
    await ensureSegments(setup());
    for (let i = 0; i < 1000; i++) fake.add(`other${i}@example.com`); // Maria's other contacts fill the plan
    await sub("kati@example.com");
    expect(await actions.fullSyncAction()).toMatchObject({ added: 0, unsynced: 1, limitReached: true, contacts: 1000 });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("the interactive time budget: the deps carry ADMIN_SYNC_BUDGET_MS, and a sync that runs out of it is `finished: false` (the rest waits), still refreshed", async () => {
    expect(ADMIN_SYNC_BUDGET_MS).toBe(25_000);
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) await sub(email);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fake.onCall = (name) => {
      if (name === "contacts.create") vi.setSystemTime(Date.now() + 20_000);
    };
    const report = await actions.fullSyncAction();
    expect(state.budgets).toEqual([ADMIN_SYNC_BUDGET_MS]);
    expect(report).toMatchObject({ added: 2, unsynced: 1, finished: false });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("fullSyncAction: Resend refuses or does not answer", () => {
  test("Resend down: `unavailable`; no row is touched, the page is not refreshed, the log has the call and the status and no address", async () => {
    await sub("kati@example.com");
    fake.fail.set("segments.list", DOWN);
    expect(await actions.fullSyncAction()).toEqual({ error: "unavailable" });
    expect((await rowOf("kati@example.com")).syncedAt).toBeNull();
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(logged()).toContain("[newsletter-sync]");
    expect(logged()).toContain("status 500");
    expect(logged()).not.toContain("@");
  });

  test("a network failure (the call throws) is `unavailable` too", async () => {
    await sub("kati@example.com");
    fake.fail.set("segments.list", () => {
      throw new Error("socket hang up for kati@example.com");
    });
    expect(await actions.fullSyncAction()).toEqual({ error: "unavailable" });
    expect(logged()).not.toContain("kati");
  });

  test.each([
    ["a key that may only send (401 restricted_api_key)", { name: "restricted_api_key", statusCode: 401, message: "This API key is restricted to only send emails" }],
    ["a key Resend does not know (403 invalid_api_key)", { name: "invalid_api_key", statusCode: 403, message: "API key is invalid" }],
    ["a refusal by status alone (401, an unnamed error)", { name: "unauthorized", statusCode: 401, message: "no" }],
    ["a refusal by status alone (403, an unnamed error)", { name: "forbidden", statusCode: 403, message: "no" }],
  ])("%s: `permission`, in whichever call it first shows", async (_name, error) => {
    await sub("kati@example.com");
    for (const call of ["segments.list", "contacts.list"]) {
      fake.fail.clear();
      fake.calls.length = 0;
      // (the segments are made once: after they are stored the first Resend call is the contacts' list)
      fake.fail.set(call, error);
      if (call === "contacts.list") await ensureSegments(setup());
      expect(await actions.fullSyncAction(), call).toEqual({ error: "permission" });
    }
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(logged()).not.toContain("@");
  });

  test("403 validation_error is not about the key (it is how Resend words other refusals): `unavailable`", async () => {
    await sub("kati@example.com");
    fake.fail.set("segments.list", { name: "validation_error", statusCode: 403, message: "something else" });
    expect(await actions.fullSyncAction()).toEqual({ error: "unavailable" });
  });

  test("the real SDK, as Resend answers a key that can only send (401, `restricted_api_key`): `permission`, never the generic text", async () => {
    state.fake = null; // the real client on a stubbed fetch; the first call fails, so no pause is waited for
    await sub("kati@example.com");
    const f = stubFetch(() => Response.json({ statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" }, { status: 401 }));
    const answer = await actions.fullSyncAction();
    expect(answer).toEqual({ error: "permission" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toContain("api.resend.com");
    expect(f.calls[0].headers.get("authorization")).toBe("Bearer re_marketing_test");
    expect(adminEt.newsletter.sync.errors.permission).toBe("Resendi võtmel pole õigusi kontakte hallata — vaja on täisõigustega võtit.");
    expect(adminEt.newsletter.sync.errors.permission).not.toBe(adminEt.newsletter.sync.errors.unavailable);
    expect(logged()).toContain("restricted_api_key");
  });

  test("the real SDK on a 403 `invalid_api_key`: `permission`; on a 500 and on no answer at all: `unavailable`", async () => {
    state.fake = null;
    await sub("kati@example.com");
    stubFetch(() => Response.json({ statusCode: 403, name: "invalid_api_key", message: "API key is invalid" }, { status: 403 }));
    expect(await actions.fullSyncAction()).toEqual({ error: "permission" });
    stubFetch(() => Response.json({ statusCode: 500, name: "internal_server_error", message: "oops" }, { status: 500 }));
    expect(await actions.fullSyncAction()).toEqual({ error: "unavailable" });
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await actions.fullSyncAction()).toEqual({ error: "unavailable" });
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("fullSyncAction: another full sync is running (rulings R9, R11)", () => {
  const lease = async () => (await db.select().from(settings).where(eq(settings.key, SYNC_LEASE_SETTING)))[0];

  test("a lease another holds: `busy`; Resend is not asked, no row is touched, the page is not refreshed, and it is not logged as a failure", async () => {
    await sub("kati@example.com");
    const other = { holder: "the-cron", until: Date.now() + 60_000 };
    await db.insert(settings).values({ key: SYNC_LEASE_SETTING, value: other });
    expect(await actions.fullSyncAction()).toEqual({ error: "busy" });
    expect(fake.calls).toEqual([]);
    expect((await rowOf("kati@example.com")).syncedAt).toBeNull();
    expect((await lease()).value).toEqual(other);
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(logged()).toContain("already running");
    expect(adminEt.newsletter.sync.errors.busy).toBe("Sünkroonimine juba käib — proovi hetke pärast uuesti.");
  });

  test("two presses at once (two tabs): one report and one `busy`; afterwards the lease is gone and the next press runs", async () => {
    await sub("kati@example.com");
    const answers = await Promise.all([actions.fullSyncAction(), actions.fullSyncAction()]);
    expect(answers.filter((a) => "error" in a)).toEqual([{ error: "busy" }]);
    expect(answers.filter((a) => !("error" in a))).toHaveLength(1);
    expect(fake.calls.filter((c) => c === "contacts.create")).toHaveLength(1);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(await lease()).toBeUndefined();
    expect(await actions.fullSyncAction()).toMatchObject({ finished: true });
  });

  test("the lease of a sync that died (its `until` has passed) does not stop the press", async () => {
    await sub("kati@example.com");
    await db.insert(settings).values({ key: SYNC_LEASE_SETTING, value: { holder: "died", until: Date.now() - 5000 } });
    expect(await actions.fullSyncAction()).toMatchObject({ added: 1, finished: true });
    expect(await lease()).toBeUndefined();
  });

  test("a sync that failed (Resend down, a key that can only send) leaves no lease behind: the press after it is not `busy`", async () => {
    await sub("kati@example.com");
    fake.fail.set("segments.list", DOWN);
    expect(await actions.fullSyncAction()).toEqual({ error: "unavailable" });
    expect(await lease()).toBeUndefined();
    fake.fail.set("segments.list", { name: "restricted_api_key", statusCode: 401, message: "This API key is restricted to only send emails" });
    expect(await actions.fullSyncAction()).toEqual({ error: "permission" });
    expect(await lease()).toBeUndefined();
  });
});

describe("fullSyncAction: a throw that is not Resend's", () => {
  test("`server`: logged by the class only (never the message, which can hold an address); the page is not refreshed", async () => {
    state.db = new Proxy({}, {
      get() {
        throw new TypeError("boom: kati@example.com");
      },
    });
    try {
      expect(await actions.fullSyncAction()).toEqual({ error: "server" });
    } finally {
      state.db = db;
    }
    expect(logged()).toContain("TypeError");
    for (const secret of ["boom", "kati", "@"]) expect(logged()).not.toContain(secret);
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("the deps of Maria's sync (server/send-deps.ts adminMarketingDeps)", () => {
  test("the links in the contacts are SITE_URL's, never the request's address: the request's headers are not even read", () => {
    const deps = adminMarketingDeps(ADMIN_SYNC_BUDGET_MS);
    expect(deps.siteUrl).toBe(SITE);
    expect(deps.env.SITE_URL).toBe(SITE);
    expect(deps.budgetMs).toBe(25_000);
    expect(deps.env.RESEND_MARKETING_KEY).toBe("re_marketing_test");
    expect(deps.now).toBeInstanceOf(Date);
    expect(adminMarketingDeps()).not.toHaveProperty("budgetMs"); // (the page's count has no budget)
  });

  test("a contact made by the button carries the unsubscribe link on SITE_URL", async () => {
    const row = await sub("kati@example.com");
    expect(await actions.fullSyncAction()).toMatchObject({ added: 1 });
    expect(fake.of("kati@example.com")?.properties).toEqual({ unsubscribe_url: `${SITE}/api/newsletter/loobu?t=${row.token}` });
  });
});

// ---------- the campaigns' actions (newsletter campaigns, Task 4) ----------

const CAMPAIGN = {
  name: "Oktoobri pakkumine",
  subject: { et: "Sügispakkumine", ru: "" },
  preheader: { et: "", ru: "" },
  imageKey: "",
  body: { et: "Esimene lõik.", ru: "" },
  code: "",
  buttonLabel: { et: "", ru: "" },
  buttonHref: "",
};

describe("the campaigns' actions: save, copy, test, prepare and send", () => {
  beforeEach(async () => {
    await db.delete(newsletterCampaigns);
    vi.stubEnv("MARIA_EMAIL", "maria@example.com");
  });
  const saved = async () => {
    const r = await actions.saveCampaignAction({ id: null, draft: CAMPAIGN });
    if (!r.ok || !("id" in r)) throw new Error(JSON.stringify(r));
    cache.refresh.mockReset();
    return r.id;
  };

  test("saveCampaignAction: a new draft (`id: null`) and the same again in place; the page is refreshed; refused fields come back by name", async () => {
    const r = await actions.saveCampaignAction({ id: null, draft: CAMPAIGN });
    expect(r).toEqual({ ok: true, id: expect.any(Number) });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    const id = (r as { id: number }).id;
    expect(await actions.saveCampaignAction({ id, draft: { ...CAMPAIGN, name: "Uus nimi" } })).toEqual({ ok: true, id });
    expect((await db.select().from(newsletterCampaigns)).map((c) => c.name)).toEqual(["Uus nimi"]);
    cache.refresh.mockReset();
    expect(await actions.saveCampaignAction({ id, draft: { ...CAMPAIGN, name: "" } })).toEqual({ ok: false, fields: { name: "required" } });
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("saveCampaignAction: an id the page never sends is refused without a write; a sent campaign is `sent`, one that is gone `notFound`", async () => {
    for (const id of [0, -1, 1.5, "7" as unknown as number]) expect(await actions.saveCampaignAction({ id, draft: CAMPAIGN }), String(id)).toEqual({ ok: false, error: "notFound" });
    const id = await saved();
    await db.update(newsletterCampaigns).set({ status: "sent" }).where(eq(newsletterCampaigns.id, id));
    expect(await actions.saveCampaignAction({ id, draft: CAMPAIGN })).toEqual({ ok: false, error: "sent" });
    expect(await actions.saveCampaignAction({ id: id + 100, draft: CAMPAIGN })).toEqual({ ok: false, error: "notFound" });
  });

  test("copyCampaignAction: the new draft's id, the page refreshed; a campaign that is gone is `notFound`", async () => {
    const id = await saved();
    const copied = await actions.copyCampaignAction({ id });
    expect(copied).toEqual({ ok: true, id: expect.any(Number) });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(await actions.copyCampaignAction({ id: id + 100 })).toEqual({ ok: false, error: "notFound" });
  });

  test("sendTestAction: `maria` is MARIA_EMAIL, `me` the signed-in admin's own address; nothing else is ever an address", async () => {
    const id = await saved();
    expect(await actions.sendTestAction({ id, to: "maria", locale: "et" })).toEqual({ ok: true, realLink: false });
    expect(fake.broadcasts.at(-1)!.delivered.map((d) => d.email)).toEqual(["maria@example.com"]);
    expect(await actions.sendTestAction({ id, to: "me", locale: "ru" })).toEqual({ ok: true, realLink: false });
    expect(fake.broadcasts.at(-1)!.delivered.map((d) => d.email)).toEqual(["admin@example.test"]);
    expect(fake.broadcasts.at(-1)!.args.subject).toBe("[Proov] Sügispakkumine");
    for (const to of ["someone@example.com", "", null]) expect(await actions.sendTestAction({ id, to: to as "me", locale: "et" }), String(to)).toEqual({ ok: false, error: "address" });
    expect(await actions.sendTestAction({ id, to: "me", locale: "de" as "et" })).toEqual({ ok: false, error: "address" });
    vi.stubEnv("MARIA_EMAIL", "");
    expect(await actions.sendTestAction({ id, to: "maria", locale: "et" })).toEqual({ ok: false, error: "address" });
    expect(fake.broadcasts).toHaveLength(2);
  });

  test("sendTestAction without the key: `notConfigured`; a campaign that is gone: `notFound`", async () => {
    const id = await saved();
    expect(await actions.sendTestAction({ id: id + 100, to: "maria", locale: "et" })).toEqual({ ok: false, error: "notFound" });
    vi.stubEnv("RESEND_MARKETING_KEY", "");
    expect(await actions.sendTestAction({ id, to: "maria", locale: "et" })).toEqual({ ok: false, error: "notConfigured" });
    expect(fake.calls).toEqual([]);
  });

  test("prepareSendAction and sendCampaignAction: the sync with the interactive budget, then the plan; the send, and the page refreshed", async () => {
    const id = await saved();
    await sub("kati@example.com");
    const prepared = await actions.prepareSendAction({ id });
    expect(prepared).toMatchObject({ ok: true, plan: { et: 1, ru: 0, ruFallsBack: true, left: 0 } });
    expect(state.budgets.at(-1)).toBe(ADMIN_SYNC_BUDGET_MS);
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(fake.broadcasts).toEqual([]);
    expect(await actions.sendCampaignAction({ id })).toEqual({ ok: true, recipients: { et: 1, ru: 0 }, missing: [], left: 0 });
    expect(state.budgets.at(-1)).toBe(ADMIN_SYNC_BUDGET_MS);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(fake.broadcasts).toHaveLength(1);
    expect(fake.broadcasts[0].args.html).toContain(`src="${SITE}/brand/logo.png"`);
    expect(await actions.sendCampaignAction({ id })).toEqual({ ok: false, error: "sent" });
    expect(cache.refresh).toHaveBeenCalledTimes(2); // (a refusal of a campaign that changed meanwhile refreshes too: its row shows the new state)
  });

  test("the send refused before anything changed (another sync running) does not refresh; an id the page never sends is `notFound`", async () => {
    const id = await saved();
    await sub("kati@example.com");
    await db.insert(settings).values({ key: SYNC_LEASE_SETTING, value: { holder: "the-cron", until: Date.now() + 60_000 } });
    expect(await actions.sendCampaignAction({ id })).toEqual({ ok: false, error: "busy" });
    expect(await actions.prepareSendAction({ id })).toEqual({ ok: false, error: "busy" });
    expect(cache.refresh).not.toHaveBeenCalled();
    for (const bad of [0, -3, "1" as unknown as number]) {
      expect(await actions.sendCampaignAction({ id: bad })).toEqual({ ok: false, error: "notFound" });
      expect(await actions.prepareSendAction({ id: bad })).toEqual({ ok: false, error: "notFound" });
      expect(await actions.copyCampaignAction({ id: bad })).toEqual({ ok: false, error: "notFound" });
      expect(await actions.sendTestAction({ id: bad, to: "me", locale: "et" })).toEqual({ ok: false, error: "notFound" });
    }
  });

  test("a throw that is not Resend's: `server`, logged by its class only", async () => {
    state.db = new Proxy({}, {
      get() {
        throw new TypeError("boom: kati@example.com");
      },
    });
    try {
      expect(await actions.saveCampaignAction({ id: null, draft: CAMPAIGN })).toEqual({ ok: false, error: "server" });
      expect(await actions.sendCampaignAction({ id: 1 })).toEqual({ ok: false, error: "server" });
      expect(await actions.sendTestAction({ id: 1, to: "me", locale: "et" })).toEqual({ ok: false, error: "server" });
    } finally {
      state.db = db;
    }
    expect(logged()).toContain("TypeError");
    for (const secret of ["boom", "kati"]) expect(logged()).not.toContain(secret);
  });
});
