import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { mailQuota, newsletterCampaigns, newsletterDeliveries, subscribers } from "@/db/schema";
import { CAMPAIGN_DAILY_ROOM } from "@/domain/newsletter-campaign";
import { CRON_BUDGET_MS, STALE_CLAIM_MS, prepareSend, saveCampaign, startSend } from "@/server/newsletter-campaigns";
import type { MailOutcome } from "@/server/notify";
import { stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";

// The newsletter's daily job (vercel.json → GET /api/cron/uudiskiri, 04:00 UTC, an hour after the sweep; spec §3 "Where the batches run"): with
// Vercel's CRON_SECRET bearer it runs the one campaign that is going out (newsletter-campaigns.ts runDueCampaigns) for its own time, on SITE_URL's
// links whatever the request's address; without it, a 401 and nothing done. Resend is never called: its HTTP API is stubbed (tests/fakes.ts).

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import * as route from "@/app/api/cron/uudiskiri/route";

const SECRET = "cron-secret-for-tests-0123456789";
const SITE = "https://mslab.example";
const call = (authorization?: string) => route.GET(new Request("https://elsewhere.example/api/cron/uudiskiri", { headers: authorization ? { authorization } : {} }));

const DRAFT = { name: "Proov 3 pakkumine", subject: { et: "Sügispakkumine", ru: "" }, preheader: { et: "", ru: "" }, body: { et: "Esimene lõik.", ru: "" } };

let db: Db;
beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
});
beforeEach(async () => {
  await db.delete(newsletterCampaigns);
  await db.delete(subscribers);
  await db.delete(mailQuota);
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("SITE_URL", SITE);
  vi.stubEnv("MAIL_FROM", "MS LAB <info@send.example.com>");
  vi.stubEnv("MARIA_EMAIL", "maria@example.com");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  state.db = db;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every line logged, joined. */
const logged = () =>
  (["info", "error", "warn", "log"] as const)
    .flatMap((m) => (console[m] as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat())
    .map(String)
    .join("\n");

/** A campaign going out to `n` subscribers, none of them sent yet (its press found the day full). */
async function goingOut(n: number): Promise<number> {
  for (let i = 1; i <= n; i++) await db.insert(subscribers).values({ email: `k${i}@example.com`, locale: "et", token: `tok_k${i}_0123456789abcdefghij`, confirmedAt: new Date() });
  const saved = await saveCampaign(db, null, DRAFT, new Date());
  if (!saved.ok) throw new Error("not saved");
  const plan = await prepareSend(db, saved.id);
  if (!plan.ok) throw new Error("no plan");
  await db.insert(mailQuota).values({ day: `${new Date().toISOString().slice(0, 10)}:all`, sent: CAMPAIGN_DAILY_ROOM });
  const nothing = async (): Promise<MailOutcome> => ({ ok: true });
  const pressed = await startSend({ db, env: { KV: { get: async () => null, put: async () => {} }, MAIL_FROM: "x", MARIA_EMAIL: "", SITE_URL: SITE }, siteUrl: SITE, now: () => new Date(), deadline: Date.now() + 60_000, gapMs: 0, send: nothing }, saved.id, plan);
  expect(pressed).toMatchObject({ ok: true, stopped: "room", progress: { sent: 0, waiting: n } });
  await db.delete(mailQuota);
  return saved.id;
}

describe("GET /api/cron/uudiskiri", () => {
  test("401 and nothing done without Vercel's bearer: no header, a wrong secret, another scheme, or CRON_SECRET not set", async () => {
    const id = await goingOut(1);
    const f = stubFetch(() => Response.json({ id: "email_1" }));
    for (const auth of [undefined, "Bearer wrong", `Bearer ${SECRET}x`, `Basic ${SECRET}`, SECRET, `bearer ${SECRET}`, "Bearer "]) {
      const res = await call(auth);
      expect(res.status, String(auth)).toBe(401);
      expect(await res.json()).toEqual({ ok: false });
    }
    vi.stubEnv("CRON_SECRET", "");
    expect((await call(`Bearer ${SECRET}`)).status).toBe(401);
    expect((await call("Bearer ")).status).toBe(401);
    expect(f.calls).toHaveLength(0);
    expect((await db.select().from(newsletterDeliveries).where(eq(newsletterDeliveries.campaignId, id))).map((r) => r.status)).toEqual(["waiting"]);
  });

  test("no campaign going out: 200, nothing sent", async () => {
    await saveCampaign(db, null, DRAFT, new Date()); // a draft is never the job's
    const f = stubFetch(() => Response.json({ id: "email_1" }));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, campaignId: null });
    expect(f.calls).toHaveLength(0);
    expect(logged()).toContain("[cron] uudiskiri: no campaign is going out");
  });

  test("the one campaign going out: its waiting rows are sent (Resend stubbed) on SITE_URL's links, the counts answered; the campaign is sent", async () => {
    const id = await goingOut(3);
    const f = stubFetch(() => Response.json({ id: "email_1" }));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, campaignId: id, stopped: null, total: 3, sent: 3, waiting: 0, failed: 0, unknown: 0, skipped: 0 });
    const resend = f.calls.filter((c) => c.url === "https://api.resend.com/emails").map((c) => c.body as { to: string; html: string; headers: Record<string, string> });
    expect(resend.map((b) => b.to)).toEqual(["k1@example.com", "k2@example.com", "k3@example.com"]);
    for (const b of resend) {
      expect(b.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/mslab\.example\/api\/newsletter\/loobu\?t=tok_k\d_/);
      expect(b.html).not.toContain("elsewhere.example");
    }
    const rows = await db.select().from(newsletterDeliveries).where(eq(newsletterDeliveries.campaignId, id)).orderBy(asc(newsletterDeliveries.id));
    expect(rows.map((r) => r.status)).toEqual(["sent", "sent", "sent"]);
    expect((await db.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id)))[0]).toMatchObject({ status: "sent", recipients: { et: 3, ru: 0 } });
    expect(logged()).toContain(`[cron] uudiskiri: campaign ${id}: 3 sent of 3, 0 waiting, 0 failed, 0 unknown, 0 skipped`);
    expect(logged()).not.toMatch(/k\d@example|tok_k/);
    // a second run the same day: nothing left
    expect(await (await call(`Bearer ${SECRET}`)).json()).toEqual({ ok: true, campaignId: null });
  });

  test("Resend refuses (the key): the rows wait, the answer says `refused`", async () => {
    const id = await goingOut(2);
    stubFetch(() => Response.json({ name: "invalid_api_key", message: "API key is invalid", statusCode: 403 }, { status: 403 }));
    const res = await call(`Bearer ${SECRET}`);
    expect(await res.json()).toEqual({ ok: true, campaignId: id, stopped: "refused", total: 2, sent: 0, waiting: 2, failed: 0, unknown: 0, skipped: 0 });
  });

  test("a database that fails: 500 `{ ok: false }`, logged by the error's class only", async () => {
    state.db = new Proxy({}, {
      get() {
        throw new TypeError("boom k1@example.com");
      },
    });
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false });
    expect(logged()).toContain("TypeError");
    expect(logged()).not.toMatch(/boom|k1@/);
  });

  test("its own time limit: 300 s (Hobby's most), the batch's budget inside it; a stale claim is older than any run", () => {
    expect(route.maxDuration).toBe(300);
    expect(route.dynamic).toBe("force-dynamic");
    expect(CRON_BUDGET_MS).toBeLessThan(route.maxDuration * 1000);
    expect(STALE_CLAIM_MS).toBeGreaterThan(route.maxDuration * 1000);
  });

  test("vercel.json: the daily job at 04:00 UTC, an hour after the sweep (Vercel Hobby: daily crons, up to 100 a project)", () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons?: { path: string; schedule: string }[] };
    expect(config.crons).toContainEqual({ path: "/api/cron/uudiskiri", schedule: "0 4 * * *" });
  });
});
