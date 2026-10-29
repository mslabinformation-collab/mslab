import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { kvEntries, mailQuota, newsletterCampaigns, settings, subscribers } from "@/db/schema";
import { CAMPAIGN_ROOM_KEY } from "@/domain/newsletter-campaign";
import { adminEt } from "@/i18n/dict/admin";
import { PgKv } from "@/server/kv";
import { getCampaign, progressOf, readCampaign, saveCampaign, sendRefused, writeCampaign } from "@/server/newsletter-campaigns";
import { stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";

// Maria's letter actions on a real (PGlite) database (newsletter campaigns, Task 4; the sending half is the 20.10 design's, Task 3; piece 3b Task 6:
// the letter autosaves on its route, so „Uus kiri +“ and „Kustuta mustand“ are the actions of its own): „Uus kiri +“, „Kustuta mustand“,
// „Kopeeri“, and the sends („Saada kõigile“ in its two steps, „Peata saatmine“, „Saada proov“, the progress) through their actions: what they answer,
// that a change refreshes the open page and a refusal does not, and that a failure is logged by its class only. The admin session and the cache are
// stand-ins (the guard is tests/unit/admin-guards.test.ts's); Resend is never called: its HTTP API is stubbed (tests/fakes.ts stubFetch).

const state = vi.hoisted(() => ({ db: null as unknown }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));

const actions = await import("@/server/actions/admin-newsletter");

let db: Db;

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
});
beforeEach(async () => {
  await db.delete(newsletterCampaigns);
  await db.delete(subscribers);
  await db.delete(mailQuota);
  await db.delete(kvEntries);
  cache.refresh.mockReset();
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every line the actions logged, joined. */
const logged = () =>
  (["info", "error", "warn", "log"] as const)
    .flatMap((m) => (console[m] as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat())
    .map(String)
    .join("\n");

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

describe("the letters' actions: „Uus kiri +“, „Kustuta mustand“ and „Kopeeri“", () => {
  const saved = async () => {
    const r = await saveCampaign(db, null, CAMPAIGN, new Date());
    if (!r.ok || !("id" in r)) throw new Error(JSON.stringify(r));
    return r.id;
  };

  test("createDraftAction: the new draft „Uus kiri“ (ruling R-g) and its id; the page is refreshed", async () => {
    const r = await actions.createDraftAction();
    expect(r).toEqual({ ok: true, id: expect.any(Number) });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(newsletterCampaigns);
    expect(row).toMatchObject({ id: (r as { id: number }).id, name: "Uus kiri", subject: { et: "", ru: "" }, body: { et: "", ru: "" }, status: "draft" });
  });

  test("deleteDraftAction: a draft is deleted; a letter sent meanwhile is `sent`; one that is gone `notFound`; an id the page never sends `notFound` without a read", async () => {
    const id = await saved();
    expect(await actions.deleteDraftAction({ id })).toEqual({ ok: true });
    expect(cache.refresh).not.toHaveBeenCalled(); // (the editor moves to the list itself)
    expect(await db.select().from(newsletterCampaigns)).toEqual([]);
    expect(await actions.deleteDraftAction({ id })).toEqual({ ok: false, error: "notFound" });
    expect(cache.refresh).toHaveBeenCalledTimes(1); // (the page is behind: the letter is gone)
    const sent = await saved();
    await db.update(newsletterCampaigns).set({ status: "sent" }).where(eq(newsletterCampaigns.id, sent));
    cache.refresh.mockReset();
    expect(await actions.deleteDraftAction({ id: sent })).toEqual({ ok: false, error: "sent" });
    expect(cache.refresh).toHaveBeenCalledTimes(1); // (the page is behind: it shows the sent letter)
    expect(adminEt.newsletter.campaigns.errorsOf.sent).toBe("See kiri on juba saadetud.");
    for (const bad of [0, -1, 1.5, "7" as unknown as number]) expect(await actions.deleteDraftAction({ id: bad }), String(bad)).toEqual({ ok: false, error: "notFound" });
    expect(await db.select().from(newsletterCampaigns)).toHaveLength(1);
  });

  test("copyCampaignAction: the new draft's id, the page refreshed; a campaign that is gone is `notFound`", async () => {
    const id = await saved();
    const copied = await actions.copyCampaignAction({ id });
    expect(copied).toEqual({ ok: true, id: expect.any(Number) });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(await actions.copyCampaignAction({ id: id + 100 })).toEqual({ ok: false, error: "notFound" });
  });

  test("an id the page never sends to „Kopeeri“ is `notFound` without a read", async () => {
    for (const id of [0, -1, 1.5, "7" as unknown as number]) expect(await actions.copyCampaignAction({ id }), String(id)).toEqual({ ok: false, error: "notFound" });
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a throw: `server`, logged by its class only (never the message, which can hold an address)", async () => {
    state.db = new Proxy({}, {
      get() {
        throw new TypeError("boom: kati@example.com");
      },
    });
    try {
      expect(await actions.createDraftAction()).toEqual({ ok: false, error: "server" });
      expect(await actions.deleteDraftAction({ id: 1 })).toEqual({ ok: false, error: "server" });
      expect(await actions.copyCampaignAction({ id: 1 })).toEqual({ ok: false, error: "server" });
    } finally {
      state.db = db;
    }
    expect(logged()).toContain("TypeError");
    for (const secret of ["boom", "kati"]) expect(logged()).not.toContain(secret);
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("the sends' actions: „Saada kõigile“, „Peata saatmine“, „Saada proov“, the progress", () => {
  const SITE = "https://mslab.example";
  /** The environment of a send: SITE_URL, Maria's address, the key (Resend itself is stubbed). */
  const configured = (o: Record<string, string> = {}) => {
    for (const [name, value] of Object.entries({ SITE_URL: SITE, MAIL_FROM: "MS LAB <info@send.example.com>", MARIA_EMAIL: "maria@example.com", RESEND_API_KEY: "re_test", ...o })) vi.stubEnv(name, value);
  };
  /** Resend's HTTP API stubbed: accepted, or the answer given. */
  const resend = (respond: () => Response = () => Response.json({ id: "email_1" })) => {
    const f = stubFetch(respond);
    return { f, mails: () => f.calls.filter((c) => c.url === "https://api.resend.com/emails").map((c) => c.body as { to: string; subject: string; html: string }) };
  };
  const subscriber = (email: string, locale: "et" | "ru" = "et") =>
    db.insert(subscribers).values({ email, locale, token: `tok_${email.replace(/[^a-z0-9]/gi, "_")}_0123456789`, confirmedAt: new Date() });
  const saved = async () => {
    const r = await saveCampaign(db, null, CAMPAIGN, new Date());
    if (!r.ok || !("id" in r)) throw new Error(JSON.stringify(r));
    return r.id;
  };
  /** The letter's autosave version as the editor holds it (the page's read; piece 3b Task 6 review I2: the panel's read carries it). */
  const versionOf = async (id: number) => (await readCampaign(db, id))?.version ?? "k:none";
  /** „Saada kõigile“'s first step as the editor sends it: the letter and the version on its screen. */
  const prepare = async (id: number) => actions.prepareSendAction({ id, version: await versionOf(id) });
  /** „Saada proov“ as the editor sends it: the letter, the address and language chosen, and the version on its screen (ruling R-j). */
  const sendTest = async (id: number, to: "maria" | "me", locale: "et" | "ru") => actions.sendTestAction({ id, to, locale, version: await versionOf(id) });

  test("prepareSendAction: the confirmation's counts and the campaign's version; nothing sent, nothing refreshed; `empty`, `busy`, and an id the page never sends `notFound`", async () => {
    configured();
    const { f } = resend();
    const id = await saved();
    expect(await prepare(id)).toEqual({ ok: false, error: "empty" });
    await subscriber("kati@example.com");
    await subscriber("olga@example.com", "ru");
    const plan = await prepare(id);
    expect(plan).toEqual({ ok: true, et: 1, ru: 1, samples: 0, ruFallsBack: true, updatedAt: expect.any(String) });
    expect(f.calls).toHaveLength(0);
    expect(cache.refresh).not.toHaveBeenCalled();
    for (const bad of [0, -1, 1.5, "7" as unknown as number]) expect(await actions.prepareSendAction({ id: bad, version: "k:x" }), String(bad)).toEqual({ ok: false, error: "notFound" });
    const other = await saved();
    await db.update(newsletterCampaigns).set({ status: "sending" }).where(eq(newsletterCampaigns.id, other));
    expect(await prepare(id)).toEqual({ ok: false, error: "busy" });
    expect(adminEt.newsletter.campaigns.errorsOf.busy).toBe("Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.");
  });

  test("prepareSendAction carries the screen's version (review I2): a letter saved elsewhere since is `changed` (the page refreshed); without a version the page never sends, `notFound`", async () => {
    configured();
    const id = await saved();
    await subscriber("kati@example.com");
    const shown = await versionOf(id);
    // another tab or device autosaves the letter; this tab typed nothing
    expect(await writeCampaign(db, id, { subject: { et: "Teise vahekaardi teema", ru: "" } }, shown, new Date())).toMatchObject({ ok: true });
    expect(await actions.prepareSendAction({ id, version: shown })).toEqual({ ok: false, error: "changed" });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(adminEt.newsletter.campaigns.errorsOf.changed).toBe("Kirja või tellijate arvu muudeti vahepeal. Midagi ei saadetud: laadi leht uuesti, vaata kiri üle ja vajuta uuesti „Saada kõigile“.");
    expect(await actions.prepareSendAction({ id } as unknown as { id: number; version: string })).toEqual({ ok: false, error: "notFound" });
    expect(await prepare(id)).toMatchObject({ ok: true, et: 1, ru: 0 });
  });

  test("sendTestAction carries the screen's version too (ruling R-j): a letter saved elsewhere since is `changed` — nothing sent, the page refreshed (it is behind); the current version sends", async () => {
    configured();
    const r = resend();
    const id = await saved();
    const shown = await versionOf(id);
    // another tab or device autosaves the letter; this screen typed nothing
    expect(await writeCampaign(db, id, { subject: { et: "Teise vahekaardi teema", ru: "" } }, shown, new Date())).toMatchObject({ ok: true });
    expect(await actions.sendTestAction({ id, to: "maria", locale: "et", version: shown })).toEqual({ ok: false, error: "changed" });
    expect(r.mails()).toHaveLength(0);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    // a version that is missing, empty or no string (a page script older than the action) is `changed` too — never the wrong-address line — and refreshes the page
    for (const [n, bad] of [[2, undefined], [3, ""], [4, 7]] as const) {
      const input = { id, to: "maria", locale: "et", ...(bad === undefined ? {} : { version: bad }) } as unknown as { id: number; to: "maria"; locale: "et"; version: string };
      expect(await actions.sendTestAction(input), JSON.stringify(input)).toEqual({ ok: false, error: "changed" });
      expect(cache.refresh).toHaveBeenCalledTimes(n);
    }
    expect(r.mails()).toHaveLength(0);
    // the refreshed screen holds the stored version, and its test goes with the stored text; nothing more is refreshed
    expect(await sendTest(id, "maria", "et")).toEqual({ ok: true });
    expect(r.mails().map((m) => m.subject)).toEqual(["[Proov] Teise vahekaardi teema"]);
    expect(cache.refresh).toHaveBeenCalledTimes(4);
    // a letter that is gone is `notFound` whatever the version says, and nothing is refreshed for it (as before)
    expect(await actions.sendTestAction({ id: id + 100, to: "maria", locale: "et", version: shown })).toEqual({ ok: false, error: "notFound" });
    expect(await actions.sendTestAction({ id: id + 100, to: "maria", locale: "et", version: "" })).toEqual({ ok: false, error: "notFound" });
    expect(cache.refresh).toHaveBeenCalledTimes(4);
  });

  test("startSendAction: the press with what the confirmation showed — the first batch goes at once on SITE_URL's links, the page is refreshed; `changed` refreshes nothing", async () => {
    configured();
    const r = resend();
    const id = await saved();
    await subscriber("kati@example.com");
    const plan = await prepare(id);
    if (!plan.ok) throw new Error("no plan");
    expect(await actions.startSendAction({ id, et: plan.et + 1, ru: plan.ru, updatedAt: plan.updatedAt })).toEqual({ ok: false, error: "changed" });
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(r.mails()).toHaveLength(0);
    const sent = await actions.startSendAction({ id, et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt });
    expect(sent).toEqual({ ok: true, progress: { total: 1, sent: 1, waiting: 0, failed: 0, unknown: 0, skipped: 0 }, stopped: null });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(r.mails().map((m) => m.to)).toEqual(["kati@example.com"]);
    expect(r.mails()[0].html).toContain(`${SITE}/api/newsletter/loobu?t=`);
    // the second tab: `sent`, and its page is refreshed (it is behind)
    expect(await actions.startSendAction({ id, et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt })).toEqual({ ok: false, error: "sent" });
    expect(cache.refresh).toHaveBeenCalledTimes(2);
  });

  test("startSendAction: input the page never sends is `notFound` without a write", async () => {
    configured();
    const id = await saved();
    await subscriber("kati@example.com");
    const plan = await prepare(id);
    if (!plan.ok) throw new Error("no plan");
    for (const bad of [
      { id: 0, et: 1, ru: 0, updatedAt: plan.updatedAt },
      { id, et: -1, ru: 0, updatedAt: plan.updatedAt },
      { id, et: 1.5, ru: 0, updatedAt: plan.updatedAt },
      { id, et: 1, ru: 0, updatedAt: "eile" },
      { id, et: 1 } as unknown as { id: number; et: number; ru: number; updatedAt: string },
    ])
      expect(await actions.startSendAction(bad), JSON.stringify(bad)).toEqual({ ok: false, error: "notFound" });
    expect((await db.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id)))[0].status).toBe("draft");
  });

  test("stopSendAction: after a refusal of Resend the page's own reads (progressOf, sendRefused) show the line; „Peata saatmine“ skips the rest and refreshes the page", async () => {
    configured();
    resend(() => Response.json({ name: "invalid_api_key", message: "no", statusCode: 403 }, { status: 403 }));
    const id = await saved();
    await subscriber("kati@example.com");
    await subscriber("mari@example.com");
    const plan = await prepare(id);
    if (!plan.ok) throw new Error("no plan");
    expect(await actions.startSendAction({ id, et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt })).toEqual({ ok: true, progress: { total: 2, sent: 0, waiting: 2, failed: 0, unknown: 0, skipped: 0 }, stopped: "refused" });
    expect(adminEt.newsletter.campaigns.errorsOf.refused).toBe("Saatmine peatus: Resend keeldus. Kirjuta Dimile.");
    expect((await getCampaign(db, id))?.status).toBe("sending");
    expect(await sendRefused(new PgKv(db), id)).toBe(true);
    expect(await progressOf(db, id)).toEqual({ total: 2, sent: 0, waiting: 2, failed: 0, unknown: 0, skipped: 0 });
    cache.refresh.mockReset();
    expect(await actions.stopSendAction({ id })).toEqual({ ok: true, progress: { total: 2, sent: 0, waiting: 0, failed: 0, unknown: 0, skipped: 2 } });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect((await getCampaign(db, id))?.status).toBe("sent");
    expect(await progressOf(db, id)).toEqual({ total: 2, sent: 0, waiting: 0, failed: 0, unknown: 0, skipped: 2 });
    expect(await actions.stopSendAction({ id })).toEqual({ ok: false, error: "notSending" });
    expect(await actions.stopSendAction({ id: 0 })).toEqual({ ok: false, error: "notFound" });
  });

  test("sendTestAction: to MARIA_EMAIL („maria“) or the signed-in admin's own address („me“), never one the browser names; `address` without one; „[Proov]“; nothing refreshed", async () => {
    configured();
    const r = resend();
    const id = await saved();
    expect(await sendTest(id, "maria", "et")).toEqual({ ok: true });
    expect(await sendTest(id, "me", "ru")).toEqual({ ok: true });
    expect(r.mails().map((m) => [m.to, m.subject])).toEqual([
      ["maria@example.com", "[Proov] Sügispakkumine"],
      ["admin@example.test", "[Proov] Sügispakkumine"],
    ]);
    expect(r.mails()[0].html).toContain(`${SITE}/api/newsletter/loobu?proov=1`);
    const version = await versionOf(id);
    // (an address or a language the page never sends)
    for (const bad of [{ id, to: "kati@example.com", locale: "et", version }, { id, to: "maria", locale: "en", version }] as unknown as { id: number; to: "maria"; locale: "et"; version: string }[])
      expect(await actions.sendTestAction(bad), JSON.stringify(bad)).toEqual({ ok: false, error: "address" });
    expect(await actions.sendTestAction({ id: 0, to: "maria", locale: "et", version })).toEqual({ ok: false, error: "notFound" });
    vi.stubEnv("MARIA_EMAIL", "");
    expect(await sendTest(id, "maria", "et")).toEqual({ ok: false, error: "address" });
    expect(r.mails()).toHaveLength(2);
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a letter without its subject (saved so by the autosave, ruling R-g): „Saada proov“ and „Saada kõigile“ answer the fields by name, nothing sent, nothing refreshed", async () => {
    configured();
    const r = resend();
    const id = (await actions.createDraftAction()) as { id: number };
    cache.refresh.mockReset();
    await subscriber("kati@example.com");
    const refused = { ok: false, error: "invalid", fields: { "subject.et": "required", "body.et": "required" } };
    expect(await sendTest(id.id, "maria", "et")).toEqual(refused);
    expect(await prepare(id.id)).toEqual(refused);
    expect(r.mails()).toHaveLength(0);
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("sendTestAction: `mail` when Resend refuses it; `limited` after ten an hour", async () => {
    configured();
    const id = await saved();
    resend(() => Response.json({ name: "invalid_api_key", message: "no", statusCode: 403 }, { status: 403 }));
    expect(await sendTest(id, "maria", "et")).toEqual({ ok: false, error: "mail" });
    const r = resend();
    for (let i = 0; i < 10; i++) expect(await sendTest(id, "maria", "et"), String(i)).toEqual({ ok: true });
    expect(await sendTest(id, "maria", "et")).toEqual({ ok: false, error: "limited" });
    expect(r.mails()).toHaveLength(10);
    for (const code of ["limited", "mail", "address", "changed", "empty", "notSending"] as const) expect(adminEt.newsletter.campaigns.errorsOf[code], code).toMatch(/\S/);
  });

  test("the check Dim does, through the actions: with the room lowered the press sends up to it and answers `room` with the progress the line is made from; the page's reads and „Peata saatmine“ follow", async () => {
    configured();
    const r = resend();
    await db.insert(settings).values({ key: CAMPAIGN_ROOM_KEY, value: 2 });
    try {
      const id = await saved();
      for (const email of ["a@example.com", "b@example.com", "c@example.com"]) await subscriber(email);
      const plan = await prepare(id);
      if (!plan.ok) throw new Error("no plan");
      expect(await actions.startSendAction({ id, et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt })).toEqual({
        ok: true,
        progress: { total: 3, sent: 2, waiting: 1, failed: 0, unknown: 0, skipped: 0 },
        stopped: "room",
      });
      expect(r.mails().map((m) => m.to)).toEqual(["a@example.com", "b@example.com"]);
      expect(cache.refresh).toHaveBeenCalledTimes(1);
      // the page is made from the campaign's own state: still going out, nothing refused
      expect((await getCampaign(db, id))?.status).toBe("sending");
      expect(await sendRefused(new PgKv(db), id)).toBe(false);
      expect(await progressOf(db, id)).toEqual({ total: 3, sent: 2, waiting: 1, failed: 0, unknown: 0, skipped: 0 });
      // „Peata saatmine“: the third never goes, the campaign is sent with the two that did
      expect(await actions.stopSendAction({ id })).toEqual({ ok: true, progress: { total: 3, sent: 2, waiting: 0, failed: 0, unknown: 0, skipped: 1 } });
      const [row] = await db.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id));
      expect(row).toMatchObject({ status: "sent", recipients: { et: 2, ru: 0 } });
      expect(r.mails()).toHaveLength(2);
    } finally {
      await db.delete(settings).where(eq(settings.key, CAMPAIGN_ROOM_KEY));
    }
  });

  test("every code the send actions answer has its words in the editor's table (an unknown code would fall back to the general line)", () => {
    const codes = ["notFound", "sent", "busy", "empty", "changed", "notSending", "refused", "limited", "mail", "address", "server"] as const;
    for (const code of codes) expect(adminEt.newsletter.campaigns.errorsOf[code], code).toMatch(/\S/);
    expect(new Set(codes.map((c) => adminEt.newsletter.campaigns.errorsOf[c])).size).toBe(codes.length); // (no two codes say the same)
  });

  test("a throw in a send's action: `server`, logged by its class only", async () => {
    configured();
    state.db = new Proxy({}, {
      get() {
        throw new TypeError("boom: kati@example.com");
      },
    });
    try {
      expect(await actions.prepareSendAction({ id: 1, version: "k:x" })).toEqual({ ok: false, error: "server" });
      expect(await actions.startSendAction({ id: 1, et: 1, ru: 0, updatedAt: new Date().toISOString() })).toEqual({ ok: false, error: "server" });
      expect(await actions.stopSendAction({ id: 1 })).toEqual({ ok: false, error: "server" });
      expect(await actions.sendTestAction({ id: 1, to: "maria", locale: "et", version: "k:x" })).toEqual({ ok: false, error: "server" });
    } finally {
      state.db = db;
    }
    expect(logged()).toContain("TypeError");
    for (const secret of ["boom", "kati"]) expect(logged()).not.toContain(secret);
  });
});
