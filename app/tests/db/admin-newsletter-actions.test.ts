import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { kvEntries, mailQuota, newsletterCampaigns, subscribers } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";
import { stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";

// Maria's campaign actions on a real (PGlite) database (newsletter campaigns, Task 4; the sending half is the 20.10 design's, Task 3): „Salvesta“,
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

describe("the campaigns' actions: save and copy", () => {
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
      expect(await actions.saveCampaignAction({ id: null, draft: CAMPAIGN })).toEqual({ ok: false, error: "server" });
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
    const r = await actions.saveCampaignAction({ id: null, draft: CAMPAIGN });
    if (!r.ok || !("id" in r)) throw new Error(JSON.stringify(r));
    cache.refresh.mockReset();
    return r.id;
  };

  test("prepareSendAction: the confirmation's counts and the campaign's version; nothing sent, nothing refreshed; `empty`, `busy`, and an id the page never sends `notFound`", async () => {
    configured();
    const { f } = resend();
    const id = await saved();
    expect(await actions.prepareSendAction({ id })).toEqual({ ok: false, error: "empty" });
    await subscriber("kati@example.com");
    await subscriber("olga@example.com", "ru");
    const plan = await actions.prepareSendAction({ id });
    expect(plan).toEqual({ ok: true, et: 1, ru: 1, ruFallsBack: true, updatedAt: expect.any(String) });
    expect(f.calls).toHaveLength(0);
    expect(cache.refresh).not.toHaveBeenCalled();
    for (const bad of [0, -1, 1.5, "7" as unknown as number]) expect(await actions.prepareSendAction({ id: bad }), String(bad)).toEqual({ ok: false, error: "notFound" });
    const other = await saved();
    await db.update(newsletterCampaigns).set({ status: "sending" }).where(eq(newsletterCampaigns.id, other));
    expect(await actions.prepareSendAction({ id })).toEqual({ ok: false, error: "busy" });
    expect(adminEt.newsletter.campaigns.errorsOf.busy).toBe("Eelmine kampaania on veel pooleli — see läheb välja, kui eelmine on saadetud.");
  });

  test("startSendAction: the press with what the confirmation showed — the first batch goes at once on SITE_URL's links, the page is refreshed; `changed` refreshes nothing", async () => {
    configured();
    const r = resend();
    const id = await saved();
    await subscriber("kati@example.com");
    const plan = await actions.prepareSendAction({ id });
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
    const plan = await actions.prepareSendAction({ id });
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

  test("progressAction and stopSendAction: the line while it goes out, a refusal of Resend said; „Peata saatmine“ skips the rest and refreshes the page", async () => {
    configured();
    resend(() => Response.json({ name: "invalid_api_key", message: "no", statusCode: 403 }, { status: 403 }));
    const id = await saved();
    await subscriber("kati@example.com");
    await subscriber("mari@example.com");
    const plan = await actions.prepareSendAction({ id });
    if (!plan.ok) throw new Error("no plan");
    expect(await actions.startSendAction({ id, et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt })).toEqual({ ok: true, progress: { total: 2, sent: 0, waiting: 2, failed: 0, unknown: 0, skipped: 0 }, stopped: "refused" });
    expect(adminEt.newsletter.campaigns.errorsOf.refused).toBe("Saatmine peatus: Resend keeldus. Kirjuta Dimile.");
    expect(await actions.progressAction({ id })).toEqual({ ok: true, status: "sending", refused: true, progress: { total: 2, sent: 0, waiting: 2, failed: 0, unknown: 0, skipped: 0 } });
    cache.refresh.mockReset();
    expect(await actions.stopSendAction({ id })).toEqual({ ok: true, progress: { total: 2, sent: 0, waiting: 0, failed: 0, unknown: 0, skipped: 2 } });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(await actions.progressAction({ id })).toEqual({ ok: true, status: "sent", refused: false, progress: { total: 2, sent: 0, waiting: 0, failed: 0, unknown: 0, skipped: 2 } });
    expect(await actions.stopSendAction({ id })).toEqual({ ok: false, error: "notSending" });
    expect(await actions.stopSendAction({ id: 0 })).toEqual({ ok: false, error: "notFound" });
    expect(await actions.progressAction({ id: id + 100 })).toEqual({ ok: false, error: "notFound" });
    expect(await actions.progressAction({ id: 0 })).toEqual({ ok: false, error: "notFound" });
  });

  test("sendTestAction: to MARIA_EMAIL („maria“) or the signed-in admin's own address („me“), never one the browser names; `address` without one; „[Proov]“; nothing refreshed", async () => {
    configured();
    const r = resend();
    const id = await saved();
    expect(await actions.sendTestAction({ id, to: "maria", locale: "et" })).toEqual({ ok: true });
    expect(await actions.sendTestAction({ id, to: "me", locale: "ru" })).toEqual({ ok: true });
    expect(r.mails().map((m) => [m.to, m.subject])).toEqual([
      ["maria@example.com", "[Proov] Sügispakkumine"],
      ["admin@example.test", "[Proov] Sügispakkumine"],
    ]);
    expect(r.mails()[0].html).toContain(`${SITE}/api/newsletter/loobu?proov=1`);
    for (const bad of [{ id, to: "kati@example.com", locale: "et" }, { id, to: "maria", locale: "en" }] as unknown as { id: number; to: "maria"; locale: "et" }[])
      expect(await actions.sendTestAction(bad), JSON.stringify(bad)).toEqual({ ok: false, error: "address" });
    expect(await actions.sendTestAction({ id: 0, to: "maria", locale: "et" })).toEqual({ ok: false, error: "notFound" });
    vi.stubEnv("MARIA_EMAIL", "");
    expect(await actions.sendTestAction({ id, to: "maria", locale: "et" })).toEqual({ ok: false, error: "address" });
    expect(r.mails()).toHaveLength(2);
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("sendTestAction: `mail` when Resend refuses it; `limited` after ten an hour", async () => {
    configured();
    const id = await saved();
    resend(() => Response.json({ name: "invalid_api_key", message: "no", statusCode: 403 }, { status: 403 }));
    expect(await actions.sendTestAction({ id, to: "maria", locale: "et" })).toEqual({ ok: false, error: "mail" });
    const r = resend();
    for (let i = 0; i < 10; i++) expect(await actions.sendTestAction({ id, to: "maria", locale: "et" }), String(i)).toEqual({ ok: true });
    expect(await actions.sendTestAction({ id, to: "maria", locale: "et" })).toEqual({ ok: false, error: "limited" });
    expect(r.mails()).toHaveLength(10);
    for (const code of ["limited", "mail", "address", "changed", "empty", "notSending"] as const) expect(adminEt.newsletter.campaigns.errorsOf[code], code).toMatch(/\S/);
  });

  test("a throw in a send's action: `server`, logged by its class only", async () => {
    configured();
    state.db = new Proxy({}, {
      get() {
        throw new TypeError("boom: kati@example.com");
      },
    });
    try {
      expect(await actions.prepareSendAction({ id: 1 })).toEqual({ ok: false, error: "server" });
      expect(await actions.startSendAction({ id: 1, et: 1, ru: 0, updatedAt: new Date().toISOString() })).toEqual({ ok: false, error: "server" });
      expect(await actions.stopSendAction({ id: 1 })).toEqual({ ok: false, error: "server" });
      expect(await actions.sendTestAction({ id: 1, to: "maria", locale: "et" })).toEqual({ ok: false, error: "server" });
      expect(await actions.progressAction({ id: 1 })).toEqual({ ok: false, error: "server" });
    } finally {
      state.db = db;
    }
    expect(logged()).toContain("TypeError");
    for (const secret of ["boom", "kati"]) expect(logged()).not.toContain(secret);
  });
});
