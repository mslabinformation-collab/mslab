import { asc, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { mailQuota, newsletterCampaigns, newsletterDeliveries, settings, subscribers } from "@/db/schema";
import { CAMPAIGN_DAILY_ROOM, CAMPAIGN_ROOM_KEY } from "@/domain/newsletter-campaign";
import { getDict } from "@/i18n/locales";
import { countSentMail, mailsSentToday } from "@/server/client-auth";
import { unsubscribeUrl } from "@/server/newsletter";
import {
  CRON_BUDGET_MS,
  PRESS_BUDGET_MS,
  SEND_GAP_MS,
  STALE_CLAIM_MS,
  TEST_SEND_LIMIT,
  prepareSend,
  progressOf,
  runBatch,
  runDueCampaigns,
  saveCampaign,
  sendRefused,
  sendTest,
  startSend,
  stopSend,
  type SendDeps,
} from "@/server/newsletter-campaigns";
import { NOTIFY_TIMEOUT_MS, RATE_LIMIT_RETRY_MS, sendMail, type Env, type Mail, type MailOutcome, type SendOptions } from "@/server/notify";
import { fakeKv, stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";

// The simple newsletter's sending on a real (PGlite) database (spec §3, §5; plan Task 3): the press („Saada kõigile“) writes one delivery for each
// confirmed subscriber and sends the first batch at once; a batch claims one row at a time (FOR UPDATE SKIP LOCKED), sends it as an ordinary mail
// with her own unsubscribe link and the List-Unsubscribe headers, and maps the outcome to exactly one status (at most once); it stops at the day's
// room (CAMPAIGN_DAILY_ROOM of every mail the site sent today), at its time limit, or when Resend refuses; the daily job continues it; „Peata
// saatmine“ skips the rest; „Saada proov“ is one counted mail. Resend is never called: the batches get a fake `send` (the seam of SendDeps) that
// counts an accepted mail as sendMailResult does, and the tests of the real sendMailResult stub its HTTP call (tests/fakes.ts stubFetch).

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-20T08:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let db: Db;
let kv: ReturnType<typeof fakeKv>;

const env = (): Env => ({ KV: kv, MAIL_FROM: "MS LAB <info@send.example.com>", MARIA_EMAIL: "maria@example.com", SITE_URL: SITE });

/** Maria's campaign: both languages, a picture and a button. */
const DRAFT = {
  name: "Proov 3 pakkumine",
  subject: { et: "Sügispakkumine", ru: "Осеннее предложение" },
  preheader: { et: "", ru: "" },
  imageKey: "img/0f8fad5b-d9cb-469f-a165-70867728950e.jpg",
  body: { et: "Esimene lõik.", ru: "Первый абзац." },
  code: "",
  buttonLabel: { et: "Vaata koolitusi", ru: "Смотреть курсы" },
  buttonHref: "/koolitused",
};
/** The same without its Russian subject and text: the Russian subscribers get the Estonian mail. */
const ET_ONLY = { ...DRAFT, subject: { et: "Sügispakkumine", ru: "" }, body: { et: "Esimene lõik.", ru: "" }, buttonLabel: { et: "Vaata koolitusi", ru: "" } };

async function campaign(raw: unknown = DRAFT): Promise<number> {
  const saved = await saveCampaign(db, null, raw, new Date());
  if (!saved.ok) throw new Error(JSON.stringify(saved));
  return saved.id;
}

/** A subscriber row: confirmed unless told, her token from her name (the shape of a real one). */
async function subscribe(email: string, locale: "et" | "ru" = "et", o: { confirmed?: boolean; token?: string } = {}) {
  const token = o.token ?? `tok_${email.replace(/[^a-z0-9]/gi, "_")}_0123456789abcdef`;
  const [row] = await db.insert(subscribers).values({ email, locale, token, confirmedAt: o.confirmed === false ? null : NOW }).returning();
  return row;
}

/** Several Estonian subscribers, k1@ … kn@. */
async function subscribeMany(n: number, locale: "et" | "ru" = "et", prefix = "k") {
  for (let i = 1; i <= n; i++) await subscribe(`${prefix}${i}@example.com`, locale);
}

type Answer = (mail: Mail, n: number) => MailOutcome | Promise<MailOutcome>;

/** The fake Resend of a batch: every mail it was given, in order, answered by `answer` (accepted unless told); an accepted one is counted on the day's counter as sendMailResult counts it. */
function fakeSend(answer: Answer = () => ({ ok: true })) {
  const mails: Mail[] = [];
  const send = vi.fn(async (_env: Env, mail: Mail, opts: SendOptions = {}): Promise<MailOutcome> => {
    mails.push(mail);
    const outcome = await answer(mail, mails.length);
    if (outcome.ok && opts.count) await countSentMail(opts.count);
    return outcome;
  });
  return { send, mails, to: () => mails.map((m) => m.to) };
}

/** The deps of a batch: the clock is the (faked) system time, the time limit an hour away unless told, no pause between sends unless told. */
const deps = (send: SendDeps["send"], o: Partial<SendDeps> = {}): SendDeps => ({
  db,
  env: env(),
  siteUrl: SITE,
  now: () => new Date(),
  deadline: Date.now() + HOUR,
  gapMs: 0,
  send,
  ...o,
});

/** A gate a fake send waits on: `open()` lets it go on. */
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((resolve) => (open = resolve));
  return { shut, open };
}

/** Waits (polling the database) until `check` holds; the batches run alongside. */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`never: ${what}`);
}

const rowsOf = (id: number) => db.select().from(newsletterDeliveries).where(eq(newsletterDeliveries.campaignId, id)).orderBy(asc(newsletterDeliveries.id));
const statuses = async (id: number) => Object.fromEntries((await rowsOf(id)).map((r) => [r.email, r.status]));
const campaignRow = async (id: number) => (await db.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, id)))[0];
const claimedCount = async (id: number) => (await rowsOf(id)).filter((r) => r.status === "claimed").length;
/** Today's count of every mail the site sent: `n` already (the site's own mails) before a test's campaign. */
const daySent = (n: number, at = new Date()) => db.insert(mailQuota).values({ day: `${at.toISOString().slice(0, 10)}:all`, sent: n });

/** Prepares and presses „Saada kõigile“ on campaign `id` with what the confirmation showed. */
async function press(id: number, d: SendDeps) {
  const plan = await prepareSend(db, id);
  if (!plan.ok) throw new Error(JSON.stringify(plan));
  return startSend(d, id, { et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt });
}

beforeAll(async () => {
  db = await makeTestDb();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await db.delete(newsletterCampaigns); // (the deliveries go with them)
  await db.delete(subscribers);
  await db.delete(mailQuota);
  kv = fakeKv();
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every line logged, joined. */
const logged = () =>
  (["info", "error", "warn", "log"] as const)
    .flatMap((m) => (console[m] as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat())
    .map(String)
    .join("\n");

describe("prepareSend: what the confirmation shows", () => {
  test("the confirmed subscribers by language, at this moment; not an unconfirmed row, a sample address (@example.test) or a second row of one address", async () => {
    const id = await campaign(ET_ONLY);
    await subscribe("kati@example.com");
    await subscribe("Mari@Example.com");
    await subscribe("olga@example.com", "ru");
    await subscribe("ootab@example.com", "et", { confirmed: false });
    await subscribe("naidis@example.test");
    await subscribe("MARI@example.com", "ru"); // a legacy row of the same address in other letters: one mail for the address
    const plan = await prepareSend(db, id);
    expect(plan).toEqual({ ok: true, et: 2, ru: 1, ruFallsBack: true, updatedAt: (await campaignRow(id)).updatedAt.toISOString() });
    expect(await rowsOf(id)).toEqual([]); // nothing written,
    expect((await campaignRow(id)).status).toBe("draft"); // nothing changed
    expect(await prepareSend(db, await campaign(DRAFT))).toMatchObject({ ok: true, ruFallsBack: false });
  });

  test("`notFound`, `sent` (sent, or being sent), `empty` (no confirmed subscriber), `busy` (another campaign is going out)", async () => {
    expect(await prepareSend(db, 999_999)).toEqual({ ok: false, error: "notFound" });
    const id = await campaign();
    expect(await prepareSend(db, id)).toEqual({ ok: false, error: "empty" });
    await subscribe("ootab@example.com", "et", { confirmed: false });
    await subscribe("naidis@example.test");
    expect(await prepareSend(db, id)).toEqual({ ok: false, error: "empty" });
    await subscribe("kati@example.com");
    for (const status of ["sent", "sending"] as const) {
      await db.update(newsletterCampaigns).set({ status }).where(eq(newsletterCampaigns.id, id));
      expect(await prepareSend(db, id), status).toEqual({ ok: false, error: "sent" });
    }
    // `id` is `sending` now: any other draft is busy
    expect(await prepareSend(db, await campaign())).toEqual({ ok: false, error: "busy" });
  });
});

describe("startSend: the press", () => {
  test("one delivery for each confirmed subscriber, then the first batch at once: each her own mail in her language, her own link and the List-Unsubscribe headers, counted", async () => {
    const id = await campaign();
    const kati = await subscribe("Kati@Example.com");
    const olga = await subscribe("olga@example.com", "ru");
    await subscribe("ootab@example.com", "et", { confirmed: false });
    await subscribe("naidis@example.test");
    const resend = fakeSend();
    const result = await press(id, deps(resend.send));
    expect(result).toEqual({ ok: true, progress: { total: 2, sent: 2, waiting: 0, failed: 0, unknown: 0, skipped: 0 }, stopped: null });
    expect(resend.to()).toEqual(["kati@example.com", "olga@example.com"]);
    const [et, ru] = resend.mails;
    expect(et.subject).toBe("Sügispakkumine");
    expect(ru.subject).toBe("Осеннее предложение");
    for (const [mail, sub] of [[et, kati], [ru, olga]] as const) {
      const link = unsubscribeUrl(SITE, sub.token);
      expect(mail.headers).toEqual({ "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
      expect(mail.html).toContain(`href="${link}"`);
      expect(mail.text).toContain(link);
      expect(mail.html).toContain(`${SITE}/media/img/`); // the picture on SITE_URL
      expect(mail.subject).not.toContain("[Proov]");
    }
    expect(ru.html).toContain(getDict("ru").mail.campaign.unsubscribe);
    const rows = await rowsOf(id);
    expect(rows.map((r) => [r.email, r.locale, r.token, r.status])).toEqual([
      ["kati@example.com", "et", kati.token, "sent"],
      ["olga@example.com", "ru", olga.token, "sent"],
    ]);
    for (const r of rows) expect(r.sentAt).toEqual(NOW);
    expect(await campaignRow(id)).toMatchObject({ status: "sent", sentAt: NOW, recipients: { et: 1, ru: 1 } });
    expect(await mailsSentToday(db)).toBe(2);
    expect(logged()).not.toMatch(/kati|olga|tok_/i); // ids and counts only
  });

  test("`changed`: the confirmed counts or the campaign moved since the confirmation — nothing written, nothing sent, still a draft", async () => {
    const id = await campaign();
    await subscribe("kati@example.com");
    const leaves = await subscribe("olga@example.com", "ru");
    const plan = await prepareSend(db, id);
    if (!plan.ok) throw new Error("no plan");
    const confirmed = { et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt };
    const resend = fakeSend();
    const nothing = async () => {
      expect(await rowsOf(id)).toEqual([]);
      expect(resend.send).not.toHaveBeenCalled();
      expect((await campaignRow(id)).status).toBe("draft");
    };
    // a sign-up after the confirmation
    const late = await subscribe("hilja@example.com");
    expect(await startSend(deps(resend.send), id, confirmed)).toEqual({ ok: false, error: "changed" });
    await nothing();
    // the same number, but another one left: the counts by language moved
    await db.delete(subscribers).where(eq(subscribers.id, leaves.id));
    expect(await startSend(deps(resend.send), id, confirmed)).toEqual({ ok: false, error: "changed" });
    await db.delete(subscribers).where(eq(subscribers.id, late.id));
    await subscribe("olga@example.com", "ru");
    // the campaign saved again in another tab
    vi.setSystemTime(NOW.getTime() + 60_000);
    expect(await saveCampaign(db, id, { ...DRAFT, name: "Muudetud" }, new Date())).toEqual({ ok: true, id });
    expect(await startSend(deps(resend.send), id, confirmed)).toEqual({ ok: false, error: "changed" });
    expect(await startSend(deps(resend.send), id, { ...confirmed, updatedAt: "not a time" })).toEqual({ ok: false, error: "changed" });
    await nothing();
    // what the page shows now goes
    expect(await press(id, deps(resend.send))).toMatchObject({ ok: true, stopped: null });
    expect(resend.to()).toEqual(["kati@example.com", "olga@example.com"]);
  });

  test("`notFound`, `sent` (sent or being sent: nothing is written twice), `empty`", async () => {
    const resend = fakeSend();
    const confirmed = { et: 1, ru: 0, updatedAt: NOW.toISOString() };
    expect(await startSend(deps(resend.send), 999_999, confirmed)).toEqual({ ok: false, error: "notFound" });
    const id = await campaign();
    expect(await startSend(deps(resend.send), id, { ...confirmed, et: 0, updatedAt: (await campaignRow(id)).updatedAt.toISOString() })).toEqual({ ok: false, error: "empty" });
    await subscribe("kati@example.com");
    await press(id, deps(resend.send));
    expect(await startSend(deps(resend.send), id, { ...confirmed, updatedAt: (await campaignRow(id)).updatedAt.toISOString() })).toEqual({ ok: false, error: "sent" });
    expect(resend.to()).toEqual(["kati@example.com"]);
    expect(await rowsOf(id)).toHaveLength(1);
  });

  test("Review Focus 2: two tabs press at once — one sends, the other is `sent`; each subscriber one row and one mail", async () => {
    const id = await campaign();
    await subscribeMany(5);
    const plan = await prepareSend(db, id);
    if (!plan.ok) throw new Error("no plan");
    const confirmed = { et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt };
    const resend = fakeSend();
    const results = await Promise.all([startSend(deps(resend.send), id, confirmed), startSend(deps(resend.send), id, confirmed)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "sent" }]);
    expect(resend.to().sort()).toEqual(["k1@example.com", "k2@example.com", "k3@example.com", "k4@example.com", "k5@example.com"]);
    expect(await rowsOf(id)).toHaveLength(5);
  });

  test("one campaign at a time: while one is going out another is `busy` (prepared or pressed); once it is sent, the next goes", async () => {
    await subscribeMany(3);
    await daySent(CAMPAIGN_DAILY_ROOM - 1); // room for one mail today
    const first = await campaign();
    const resend = fakeSend();
    expect(await press(first, deps(resend.send))).toMatchObject({ ok: true, stopped: "room", progress: { sent: 1, waiting: 2 } });
    const second = await campaign();
    expect(await prepareSend(db, second)).toEqual({ ok: false, error: "busy" });
    expect(await startSend(deps(resend.send), second, { et: 3, ru: 0, updatedAt: (await campaignRow(second)).updatedAt.toISOString() })).toEqual({ ok: false, error: "busy" });
    expect(await rowsOf(second)).toEqual([]);
    // the next day the first goes out to the end, and the second may go
    vi.setSystemTime(NOW.getTime() + DAY);
    expect(await runDueCampaigns(deps(resend.send))).toMatchObject({ campaignId: first, progress: { sent: 3, waiting: 0 } });
    expect(await press(second, deps(resend.send))).toMatchObject({ ok: true, progress: { sent: 3 } });
  });

  test("two presses of two campaigns at once: one goes out, the other is `busy` (one lock for every press)", async () => {
    await subscribeMany(2);
    const [a, b] = [await campaign(), await campaign()];
    const [pa, pb] = [await prepareSend(db, a), await prepareSend(db, b)];
    if (!pa.ok || !pb.ok) throw new Error("no plan");
    const resend = fakeSend();
    const results = await Promise.all([
      startSend(deps(resend.send), a, { et: pa.et, ru: pa.ru, updatedAt: pa.updatedAt }),
      startSend(deps(resend.send), b, { et: pb.et, ru: pb.ru, updatedAt: pb.updatedAt }),
    ]);
    expect(results.map((r) => (r.ok ? "ok" : r.error)).sort()).toEqual(["busy", "ok"]);
    expect(resend.mails).toHaveLength(2);
  });
});

describe("runBatch: each outcome is one status (at most once)", () => {
  /** A campaign whose press wrote these subscribers' rows and sent nothing (the day had no room), the day then given room again. */
  async function written(emails: [string, "et" | "ru"][], raw: unknown = DRAFT): Promise<number> {
    for (const [email, locale] of emails) await subscribe(email, locale);
    const id = await campaign(raw);
    await daySent(CAMPAIGN_DAILY_ROOM);
    expect(await press(id, deps(fakeSend().send))).toMatchObject({ ok: true, stopped: "room", progress: { sent: 0, waiting: emails.length } });
    await db.delete(mailQuota);
    return id;
  }

  test("accepted → `sent`, the address refused → `failed`, no answer → `unknown`: the batch goes on; nothing is tried twice", async () => {
    const id = await written([["ok@example.com", "et"], ["vigane@example.com", "et"], ["vastuseta@example.com", "et"], ["teine@example.com", "et"]]);
    const kinds: Record<string, MailOutcome> = { "vigane@example.com": { ok: false, kind: "address" }, "vastuseta@example.com": { ok: false, kind: "unknown" } };
    const resend = fakeSend((mail) => kinds[mail.to] ?? { ok: true });
    expect(await runBatch(deps(resend.send), id)).toEqual({ progress: { total: 4, sent: 2, waiting: 0, failed: 1, unknown: 1, skipped: 0 }, stopped: null });
    expect(await statuses(id)).toEqual({ "ok@example.com": "sent", "vigane@example.com": "failed", "vastuseta@example.com": "unknown", "teine@example.com": "sent" });
    expect((await rowsOf(id)).filter((r) => r.sentAt !== null).map((r) => r.email)).toEqual(["ok@example.com", "teine@example.com"]);
    expect(await mailsSentToday(db)).toBe(2); // only the accepted ones are counted
    expect(await campaignRow(id)).toMatchObject({ status: "sent", recipients: { et: 2, ru: 0 } });
    expect(await runBatch(deps(resend.send), id)).toMatchObject({ stopped: null });
    expect(resend.mails).toHaveLength(4); // the failed and the unknown ones are never sent again
  });

  test("Resend's daily or monthly limit → the row back to `waiting`, the batch stops (`room`); the next day goes on from it", async () => {
    const id = await written([["a@example.com", "et"], ["b@example.com", "et"], ["c@example.com", "et"]]);
    const resend = fakeSend((_mail, n) => (n === 2 ? { ok: false, kind: "quota" } : { ok: true }));
    expect(await runBatch(deps(resend.send), id)).toEqual({ progress: { total: 3, sent: 1, waiting: 2, failed: 0, unknown: 0, skipped: 0 }, stopped: "room" });
    expect(resend.to()).toEqual(["a@example.com", "b@example.com"]); // nothing after the limit is tried
    const b = (await rowsOf(id)).find((r) => r.email === "b@example.com")!;
    expect([b.status, b.claimedAt, b.sentAt]).toEqual(["waiting", null, null]);
    expect((await campaignRow(id)).status).toBe("sending");
    vi.setSystemTime(NOW.getTime() + DAY);
    expect(await runDueCampaigns(deps(resend.send))).toMatchObject({ campaignId: id, progress: { sent: 3, waiting: 0 }, stopped: null });
    expect(resend.to()).toEqual(["a@example.com", "b@example.com", "b@example.com", "c@example.com"]); // b: refused once, then sent once
  });

  test("any other refusal → back to `waiting`, the batch stops (`refused`) and the mark says so until a mail of the campaign goes", async () => {
    const id = await written([["a@example.com", "et"], ["b@example.com", "et"]]);
    const refusing = fakeSend(() => ({ ok: false, kind: "refused" }));
    expect(await runBatch(deps(refusing.send), id)).toEqual({ progress: { total: 2, sent: 0, waiting: 2, failed: 0, unknown: 0, skipped: 0 }, stopped: "refused" });
    expect(refusing.mails).toHaveLength(1);
    expect(await statuses(id)).toEqual({ "a@example.com": "waiting", "b@example.com": "waiting" });
    expect(await sendRefused(kv, id)).toBe(true);
    // the next run (the key put right) sends them, and the mark goes with the first mail that went
    const resend = fakeSend();
    expect(await runDueCampaigns(deps(resend.send))).toMatchObject({ progress: { sent: 2 }, stopped: null });
    expect(await sendRefused(kv, id)).toBe(false);
    expect(logged()).not.toMatch(/a@example|b@example/);
  });

  test("three answers in a row that say nothing (Resend is down): the batch stops (`refused`), those three are `unknown`, the rest wait", async () => {
    const id = await written([1, 2, 3, 4, 5].map((i) => [`k${i}@example.com`, "et"] as [string, "et"]));
    const down = fakeSend(() => ({ ok: false, kind: "unknown" }));
    expect(await runBatch(deps(down.send), id)).toEqual({ progress: { total: 5, sent: 0, waiting: 2, failed: 0, unknown: 3, skipped: 0 }, stopped: "refused" });
    expect(down.mails).toHaveLength(3);
    expect(await sendRefused(kv, id)).toBe(true);
  });

  test("an unknown answer between accepted ones does not stop the batch", async () => {
    const id = await written([1, 2, 3, 4].map((i) => [`m${i}@example.com`, "et"] as [string, "et"]));
    const flaky = fakeSend((_m, n) => (n % 2 === 0 ? { ok: false, kind: "unknown" } : { ok: true }));
    expect(await runBatch(deps(flaky.send), id)).toMatchObject({ progress: { sent: 2, unknown: 2, waiting: 0 }, stopped: null });
    expect(await sendRefused(kv, id)).toBe(false);
  });

  test("a send that throws is `unknown`, never sent again", async () => {
    const id = await written([["a@example.com", "et"], ["b@example.com", "et"]]);
    const resend = fakeSend((_m, n) => {
      if (n === 1) throw new TypeError("boom a@example.com");
      return { ok: true };
    });
    expect(await runBatch(deps(resend.send), id)).toMatchObject({ progress: { sent: 1, unknown: 1, waiting: 0 }, stopped: null });
    expect(await statuses(id)).toEqual({ "a@example.com": "unknown", "b@example.com": "sent" });
    expect(logged()).toContain("TypeError");
    expect(logged()).not.toMatch(/boom|a@example/);
  });

  test("through the real sendMailResult (Resend's HTTP stubbed): the outcomes of its answers, the headers in the request, only the accepted mail counted", async () => {
    const id = await written([["ok@example.com", "et"], ["vigane@example.com", "et"], ["viga500@example.com", "et"], ["limiit@example.com", "et"], ["hiljem@example.com", "et"]]);
    const answers: Record<string, () => Response> = {
      "vigane@example.com": () => Response.json({ name: "validation_error", message: "Invalid `to` field.", statusCode: 422 }, { status: 422 }),
      "viga500@example.com": () => Response.json({ name: "internal_server_error", message: "no", statusCode: 500 }, { status: 500 }),
      "limiit@example.com": () => Response.json({ name: "daily_quota_exceeded", message: "no", statusCode: 429 }, { status: 429 }),
    };
    const f = stubFetch((_url, init) => (answers[(JSON.parse(String(init?.body)) as { to: string }).to] ?? (() => Response.json({ id: "email_1" })))());
    const real = deps(undefined, { env: { ...env(), RESEND_API_KEY: "re_test" } });
    expect(await runBatch(real, id)).toEqual({ progress: { total: 5, sent: 1, waiting: 2, failed: 1, unknown: 1, skipped: 0 }, stopped: "room" });
    expect(await statuses(id)).toEqual({ "ok@example.com": "sent", "vigane@example.com": "failed", "viga500@example.com": "unknown", "limiit@example.com": "waiting", "hiljem@example.com": "waiting" });
    const sub = (await db.select().from(subscribers).where(eq(subscribers.email, "ok@example.com")))[0];
    expect((f.calls[0].body as { headers: unknown }).headers).toEqual({ "List-Unsubscribe": `<${unsubscribeUrl(SITE, sub.token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect((f.calls[0].body as { reply_to: unknown }).reply_to).toBe("maria@example.com"); // a subscriber who answers reaches Maria
    expect(await mailsSentToday(db)).toBe(1);
  });
});

describe("runBatch: consent and language", () => {
  test("a subscriber gone before her turn is `skipped`; one who left and signed up again gets it with her new link; nobody who came after the press", async () => {
    await subscribe("jaab@example.com");
    const leaves = await subscribe("lahkub@example.com");
    const returns = await subscribe("tuleb@example.com");
    const id = await campaign();
    await daySent(CAMPAIGN_DAILY_ROOM);
    await press(id, deps(fakeSend().send));
    await db.delete(mailQuota);
    await db.delete(subscribers).where(eq(subscribers.id, leaves.id)); // the unsubscribe link, or the one-click POST
    await db.delete(subscribers).where(eq(subscribers.id, returns.id));
    const again = await subscribe("Tuleb@example.com", "et", { token: "tok_new_signup_0123456789abcdef" });
    await subscribe("hilja@example.com"); // after the press: the next campaign's
    const resend = fakeSend();
    expect(await runBatch(deps(resend.send), id)).toEqual({ progress: { total: 3, sent: 2, waiting: 0, failed: 0, unknown: 0, skipped: 1 }, stopped: null });
    expect(await statuses(id)).toEqual({ "jaab@example.com": "sent", "lahkub@example.com": "skipped", "tuleb@example.com": "sent" });
    expect(resend.to()).toEqual(["jaab@example.com", "tuleb@example.com"]);
    expect(resend.mails[1].headers?.["List-Unsubscribe"]).toBe(`<${unsubscribeUrl(SITE, again.token)}>`);
    expect(resend.mails[1].html).not.toContain(returns.token);
    expect(await campaignRow(id)).toMatchObject({ status: "sent", recipients: { et: 2, ru: 0 } });
  });

  test("Review Focus 5: without the Russian text a Russian subscriber gets the Estonian subject and text under her own Russian footer and link", async () => {
    const olga = await subscribe("olga@example.com", "ru");
    await subscribe("kati@example.com", "et");
    const id = await campaign(ET_ONLY);
    const resend = fakeSend();
    await press(id, deps(resend.send));
    const ru = resend.mails.find((m) => m.to === "olga@example.com")!;
    const et = resend.mails.find((m) => m.to === "kati@example.com")!;
    expect(ru.subject).toBe("Sügispakkumine");
    expect(ru.html).toContain("Esimene lõik.");
    expect(ru.html).toContain(getDict("ru").mail.campaign.reason);
    expect(ru.html).toContain(getDict("ru").mail.campaign.unsubscribe);
    expect(ru.html).not.toContain(getDict("et").mail.campaign.reason);
    expect(ru.html).toContain(`href="${unsubscribeUrl(SITE, olga.token)}"`);
    expect(et.html).toContain(getDict("et").mail.campaign.reason);
  });
});

describe("runBatch: the room, the time, the pace", () => {
  test("Review Focus 3: the site's own mails filled the day before the press — the campaign sends nothing, the rest goes the next day; the site's mails are never stopped by it", async () => {
    await subscribeMany(3);
    await daySent(CAMPAIGN_DAILY_ROOM);
    const id = await campaign();
    const resend = fakeSend();
    expect(await press(id, deps(resend.send))).toEqual({ ok: true, progress: { total: 3, sent: 0, waiting: 3, failed: 0, unknown: 0, skipped: 0 }, stopped: "room" });
    expect(resend.send).not.toHaveBeenCalled();
    expect((await campaignRow(id)).status).toBe("sending");
    // a site mail (a login, a confirmation …) still goes and is counted, past the room
    stubFetch(() => Response.json({ id: "email_1" }));
    expect(await sendMail({ ...env(), RESEND_API_KEY: "re_test" }, { to: "opilane@example.com", subject: "Kood", text: "123456" }, { count: db })).toBe(true);
    expect(await mailsSentToday(db)).toBe(CAMPAIGN_DAILY_ROOM + 1);
    // the cron the next day
    vi.setSystemTime(NOW.getTime() + DAY);
    expect(await runDueCampaigns(deps(resend.send))).toEqual({ campaignId: id, progress: { total: 3, sent: 3, waiting: 0, failed: 0, unknown: 0, skipped: 0 }, stopped: null });
    expect(await mailsSentToday(db)).toBe(3);
  });

  test("the room left today: a campaign larger than it sends up to CAMPAIGN_DAILY_ROOM of the day's mails and continues the next day", async () => {
    await subscribeMany(5);
    await daySent(CAMPAIGN_DAILY_ROOM - 3);
    const id = await campaign();
    const resend = fakeSend();
    expect(await press(id, deps(resend.send))).toMatchObject({ ok: true, progress: { sent: 3, waiting: 2 }, stopped: "room" });
    expect(await mailsSentToday(db)).toBe(CAMPAIGN_DAILY_ROOM);
    expect(await runBatch(deps(resend.send), id)).toMatchObject({ progress: { sent: 3, waiting: 2 }, stopped: "room" }); // the same day: nothing more
    vi.setSystemTime(NOW.getTime() + DAY);
    expect(await runBatch(deps(resend.send), id)).toMatchObject({ progress: { sent: 5, waiting: 0 }, stopped: null });
    expect(resend.to()).toEqual(["k1@example.com", "k2@example.com", "k3@example.com", "k4@example.com", "k5@example.com"]);
    expect(await campaignRow(id)).toMatchObject({ status: "sent", sentAt: new Date(NOW.getTime() + DAY), recipients: { et: 5, ru: 0 } });
  });

  test("the time limit: no new mail after the deadline (`time`); the rest waits for the daily job", async () => {
    await subscribeMany(4);
    const id = await campaign();
    const slow = fakeSend(() => {
      vi.setSystemTime(Date.now() + 25_000); // each mail takes 25 s of the run's clock
      return { ok: true };
    });
    expect(await press(id, deps(slow.send, { deadline: Date.now() + 60_000 }))).toMatchObject({ ok: true, progress: { sent: 3, waiting: 1 }, stopped: "time" });
    expect(await runDueCampaigns(deps(slow.send))).toMatchObject({ progress: { sent: 4, waiting: 0 }, stopped: null });
  });

  test(`a pause of SEND_GAP_MS (${SEND_GAP_MS} ms) between two sends unless told otherwise; none before the first`, async () => {
    vi.useRealTimers();
    await subscribeMany(2);
    const id = await campaign();
    const times: number[] = [];
    const resend = fakeSend(() => {
      times.push(performance.now());
      return { ok: true };
    });
    expect(await press(id, deps(resend.send, { gapMs: undefined, deadline: Date.now() + HOUR }))).toMatchObject({ ok: true, progress: { sent: 2 } });
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(SEND_GAP_MS - 5);
  });

  test("the time limits fit their functions: the press's within the page's 120 s, the daily job's within its 300 s, a send begun at the end included; a stale claim is older than both", () => {
    const oneSend = NOTIFY_TIMEOUT_MS + RATE_LIMIT_RETRY_MS + NOTIFY_TIMEOUT_MS; // a call, a 429, the one retry
    expect(PRESS_BUDGET_MS).toBe(60_000);
    expect(PRESS_BUDGET_MS + SEND_GAP_MS + oneSend).toBeLessThan(120_000 - 30_000);
    expect(CRON_BUDGET_MS + SEND_GAP_MS + oneSend).toBeLessThan(300_000 - 10_000);
    expect(STALE_CLAIM_MS).toBe(6 * 60_000);
    expect(STALE_CLAIM_MS).toBeGreaterThan(300_000);
  });
});

// The lowered room: the settings row `newsletter_daily_room` (domain/newsletter-campaign.ts CAMPAIGN_ROOM_KEY), read only when it is there. It is how
// Dim checks "a campaign larger than the day's room continues the next day" on staging without 70 subscribers (testplan.json): he sets it by hand in
// the database for the check and deletes it after. It caps the mails ONE campaign sends in a UTC day (so the check needs no arithmetic with the day's
// other mails, or with the campaigns Dim sent earlier the same day), on top of the day's count of every mail; it can only make the room smaller.
// Maria never sees it.
describe("runBatch: the lowered room (the settings row newsletter_daily_room)", () => {
  const lower = (value: unknown) => db.insert(settings).values({ key: CAMPAIGN_ROOM_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  const unlower = () => db.delete(settings).where(eq(settings.key, CAMPAIGN_ROOM_KEY));
  afterEach(unlower);

  test("the check Dim does: room 2, three subscribers — two mails go in the press and the campaign goes on; the row deleted, the next run sends the third", async () => {
    await subscribeMany(3);
    await lower(2);
    const id = await campaign();
    const resend = fakeSend();
    expect(await press(id, deps(resend.send))).toMatchObject({ ok: true, progress: { total: 3, sent: 2, waiting: 1 }, stopped: "room" });
    expect(resend.to()).toEqual(["k1@example.com", "k2@example.com"]);
    expect((await campaignRow(id)).status).toBe("sending");
    // the row left behind is visible in the logs: every batch says the room it works under (a count, no address)
    expect(logged()).toContain("[newsletter] room override 2");
    // the same day, the row still there: nothing more
    expect(await runDueCampaigns(deps(resend.send))).toMatchObject({ campaignId: id, progress: { sent: 2, waiting: 1 }, stopped: "room" });
    expect(resend.mails).toHaveLength(2);
    // the row deleted: the daily job sends the third and the campaign is sent
    await unlower();
    expect(await runDueCampaigns(deps(resend.send))).toMatchObject({ campaignId: id, progress: { sent: 3, waiting: 0 }, stopped: null });
    expect(resend.to()).toEqual(["k1@example.com", "k2@example.com", "k3@example.com"]);
    expect(await campaignRow(id)).toMatchObject({ status: "sent", recipients: { et: 3, ru: 0 } });
  });

  test("it caps the campaign's own mails of the day, not the day's count: the site's other mails do not use it up", async () => {
    await subscribeMany(4);
    await daySent(10); // ten mails of the site today
    await lower(2);
    const resend = fakeSend();
    expect(await press(await campaign(), deps(resend.send))).toMatchObject({ ok: true, progress: { sent: 2, waiting: 2 }, stopped: "room" });
    expect(await mailsSentToday(db)).toBe(12);
  });

  test("the next day it starts again: the day before's campaign mails are not counted", async () => {
    await subscribeMany(5);
    await lower(2);
    const id = await campaign();
    const resend = fakeSend();
    expect(await press(id, deps(resend.send))).toMatchObject({ progress: { sent: 2, waiting: 3 }, stopped: "room" });
    vi.setSystemTime(NOW.getTime() + DAY);
    expect(await runDueCampaigns(deps(resend.send))).toMatchObject({ progress: { sent: 4, waiting: 1 }, stopped: "room" });
    vi.setSystemTime(NOW.getTime() + 2 * DAY);
    expect(await runDueCampaigns(deps(resend.send))).toMatchObject({ progress: { sent: 5, waiting: 0 }, stopped: null });
  });

  test("each campaign has the room to itself: an earlier campaign's mails and a test mail the same day do not use it up (the check needs no arithmetic)", async () => {
    await subscribeMany(3);
    await lower(2);
    const resend = fakeSend();
    const first = await campaign();
    expect(await press(first, deps(resend.send))).toMatchObject({ progress: { sent: 2, waiting: 1 }, stopped: "room" });
    expect(await sendTest(deps(resend.send), first, "maria@example.com", "et")).toEqual({ ok: true }); // (a test is no campaign mail)
    await stopSend(db, first, new Date()); // (the first is ended, as Dim does in the next check)
    // the second campaign, the same day: two more go, whatever the first sent
    const second = await campaign();
    expect(await press(second, deps(resend.send))).toMatchObject({ progress: { sent: 2, waiting: 1 }, stopped: "room" });
    expect(resend.mails.filter((m) => m.subject === "Sügispakkumine")).toHaveLength(4); // (the test mail's subject starts with „[Proov]“)
    // and the room is still the campaign's: the same day the job sends it nothing more
    expect(await runDueCampaigns(deps(resend.send))).toMatchObject({ campaignId: second, progress: { sent: 2, waiting: 1 }, stopped: "room" });
  });

  test("it only lowers the room: a larger number changes nothing, the day's 70 still holds; 0 and below is one", async () => {
    await subscribeMany(3);
    await lower(1_000);
    await daySent(CAMPAIGN_DAILY_ROOM - 2);
    const resend = fakeSend();
    expect(await press(await campaign(), deps(resend.send))).toMatchObject({ progress: { sent: 2, waiting: 1 }, stopped: "room" });
    await db.delete(mailQuota);
    await db.delete(newsletterCampaigns);
    await db.delete(subscribers);
    await subscribeMany(3);
    await lower(0);
    expect(await press(await campaign(), deps(fakeSend().send))).toMatchObject({ progress: { sent: 1, waiting: 2 }, stopped: "room" });
  });

  test("a value that is no number is ignored (and said in the log, without the value): the room is the room", async () => {
    await subscribeMany(3);
    await lower("kaks");
    const resend = fakeSend();
    expect(await press(await campaign(), deps(resend.send))).toMatchObject({ progress: { sent: 3, waiting: 0 }, stopped: null });
    expect(logged()).toContain("newsletter_daily_room");
    expect(logged()).not.toContain("kaks");
    expect(logged()).not.toContain("room override"); // (no number, no override)
  });

  test("with no row nothing is logged about a room and the batch is as before: the room is CAMPAIGN_DAILY_ROOM", async () => {
    await subscribeMany(2);
    const resend = fakeSend();
    expect(await press(await campaign(), deps(resend.send))).toMatchObject({ progress: { sent: 2, waiting: 0 }, stopped: null });
    expect(logged()).not.toContain("newsletter_daily_room");
    expect(logged()).not.toContain("room override");
  });
});

describe("Review Focus 1 and 2: runners that die, runners at once", () => {
  test("Review Focus 1: a runner dies after Resend accepted, before `sent` was written — the row stays `claimed`, is never sent again, and turns `unknown` once stale", async () => {
    await subscribeMany(3);
    const id = await campaign();
    const plan = await prepareSend(db, id);
    if (!plan.ok) throw new Error("no plan");
    // the first runner's Resend took the mail and the runner never came back (the function was killed)
    const dead = fakeSend(() => new Promise<MailOutcome>(() => {}));
    void startSend(deps(dead.send), id, { et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt });
    await until(async () => (await claimedCount(id)) === 1, "the first row claimed");
    // a run within the stale time: the claim is left alone, the others go, the campaign is not done
    vi.setSystemTime(NOW.getTime() + STALE_CLAIM_MS - 60_000);
    const resend = fakeSend();
    expect(await runDueCampaigns(deps(resend.send))).toEqual({ campaignId: id, progress: { total: 3, sent: 2, waiting: 1, failed: 0, unknown: 0, skipped: 0 }, stopped: null });
    expect(resend.to()).toEqual(["k2@example.com", "k3@example.com"]);
    expect(await statuses(id)).toMatchObject({ "k1@example.com": "claimed" });
    expect((await campaignRow(id)).status).toBe("sending");
    // the next run after the stale time: `unknown`, never sent again; the campaign is done
    vi.setSystemTime(NOW.getTime() + STALE_CLAIM_MS + 1);
    expect(await runDueCampaigns(deps(resend.send))).toEqual({ campaignId: id, progress: { total: 3, sent: 2, waiting: 0, failed: 0, unknown: 1, skipped: 0 }, stopped: null });
    expect(dead.to()).toEqual(["k1@example.com"]);
    expect(resend.to()).toEqual(["k2@example.com", "k3@example.com"]);
    expect(await campaignRow(id)).toMatchObject({ status: "sent", recipients: { et: 2, ru: 0 } });
  });

  test("Review Focus 2: the press and the daily job at once — every row is sent once and the counts add up", async () => {
    await subscribeMany(8);
    await subscribeMany(4, "ru", "r");
    const id = await campaign();
    const plan = await prepareSend(db, id);
    if (!plan.ok) throw new Error("no plan");
    const g = gate();
    // the press: its first mail waits for the gate, then each mail yields to the other runner
    const pressed = fakeSend(async (_m, n) => {
      if (n === 1) await g.shut;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { ok: true };
    });
    const running = startSend(deps(pressed.send), id, { et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt });
    await until(async () => (await claimedCount(id)) === 1, "the press's first row claimed");
    const cron = fakeSend(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { ok: true };
    });
    const daily = runDueCampaigns(deps(cron.send));
    await until(async () => cron.mails.length >= 2, "the daily job sending");
    g.open();
    const [p, d] = await Promise.all([running, daily]);
    const all = [...pressed.to(), ...cron.to()].sort();
    expect(all).toHaveLength(12);
    expect(new Set(all).size).toBe(12); // nobody twice
    expect(pressed.mails.length).toBeGreaterThan(0);
    expect(cron.mails.length).toBeGreaterThan(0);
    expect(await progressOf(db, id)).toEqual({ total: 12, sent: 12, waiting: 0, failed: 0, unknown: 0, skipped: 0 });
    expect(await mailsSentToday(db)).toBe(12);
    expect(await campaignRow(id)).toMatchObject({ status: "sent", recipients: { et: 8, ru: 4 } });
    expect(p).toMatchObject({ ok: true, stopped: null });
    expect(d).toMatchObject({ campaignId: id, stopped: null });
  });
});

describe("stopSend: „Peata saatmine“", () => {
  test("Review Focus 5: during a running batch — the waiting rows are `skipped`, the claimed one finishes, nothing is sent after it, the campaign is sent with its counts", async () => {
    await subscribeMany(5);
    const id = await campaign();
    const plan = await prepareSend(db, id);
    if (!plan.ok) throw new Error("no plan");
    const g = gate();
    const resend = fakeSend(async (_m, n) => {
      if (n === 2) await g.shut;
      return { ok: true };
    });
    const running = startSend(deps(resend.send), id, { et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt });
    await until(async () => resend.mails.length === 2, "the second mail on its way");
    vi.setSystemTime(NOW.getTime() + 1_000);
    expect(await stopSend(db, id, new Date())).toEqual({ ok: true, progress: { total: 5, sent: 1, waiting: 1, failed: 0, unknown: 0, skipped: 3 } });
    expect(await campaignRow(id)).toMatchObject({ status: "sent", sentAt: new Date(NOW.getTime() + 1_000), recipients: { et: 1, ru: 0 } });
    g.open();
    expect(await running).toEqual({ ok: true, progress: { total: 5, sent: 2, waiting: 0, failed: 0, unknown: 0, skipped: 3 }, stopped: null });
    expect(resend.to()).toEqual(["k1@example.com", "k2@example.com"]);
    expect(await campaignRow(id)).toMatchObject({ status: "sent", sentAt: new Date(NOW.getTime() + 1_000), recipients: { et: 2, ru: 0 } }); // the claimed one counted when it settled
    // nothing waiting is ever sent afterwards
    expect(await runDueCampaigns(deps(resend.send))).toEqual({ campaignId: null, progress: null, stopped: null });
    expect(await runBatch(deps(resend.send), id)).toMatchObject({ progress: { sent: 2, skipped: 3 }, stopped: null });
    expect(resend.mails).toHaveLength(2);
    expect(await stopSend(db, id, new Date())).toEqual({ ok: false, error: "notSending" });
  });

  test("`notFound`; `notSending` for a draft or a sent campaign", async () => {
    expect(await stopSend(db, 999_999, NOW)).toEqual({ ok: false, error: "notFound" });
    const id = await campaign();
    expect(await stopSend(db, id, NOW)).toEqual({ ok: false, error: "notSending" });
    await db.update(newsletterCampaigns).set({ status: "sent" }).where(eq(newsletterCampaigns.id, id));
    expect(await stopSend(db, id, NOW)).toEqual({ ok: false, error: "notSending" });
  });

  test("a campaign stopped while a dead runner held a claim: the daily job turns the stale claim `unknown` all the same", async () => {
    await subscribeMany(2);
    const id = await campaign();
    const plan = await prepareSend(db, id);
    if (!plan.ok) throw new Error("no plan");
    void startSend(deps(fakeSend(() => new Promise<MailOutcome>(() => {})).send), id, { et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt });
    await until(async () => (await claimedCount(id)) === 1, "a row claimed");
    expect(await stopSend(db, id, new Date())).toMatchObject({ ok: true, progress: { waiting: 1, skipped: 1 } });
    vi.setSystemTime(NOW.getTime() + STALE_CLAIM_MS + 1);
    expect(await runDueCampaigns(deps(fakeSend().send))).toEqual({ campaignId: null, progress: null, stopped: null });
    expect(await progressOf(db, id)).toEqual({ total: 2, sent: 0, waiting: 0, failed: 0, unknown: 1, skipped: 1 });
  });

  // The final review's M4: "Peata saatmine" must never leave a `waiting` row under a campaign that is `sent`. A row already claimed finishes as it is, but when
  // Resend then refuses it (its limit, or any refusal) the mail did not go, and the old code put it back to `waiting`: a row that never goes under a sent campaign
  // (and, in a second runner's loop, a row that would still be claimed and sent after the stop). Now the outcome `waiting` is written only while the campaign is
  // still going out, under the lock the stop takes; after a stop that row is `skipped`, as the stop skipped the rest.
  for (const kind of ["quota", "refused"] as const) {
    test(`M4: the stop lands while a mail is on its way and Resend then answers ${kind}: that row is \`skipped\`, no row waits under the sent campaign, nothing more goes`, async () => {
      await subscribeMany(5);
      const id = await campaign();
      const plan = await prepareSend(db, id);
      if (!plan.ok) throw new Error("no plan");
      const g = gate();
      const resend = fakeSend(async (_m, n) => {
        if (n === 1) await g.shut;
        return { ok: false, kind };
      });
      const running = startSend(deps(resend.send), id, { et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt });
      await until(async () => resend.mails.length === 1, "the first mail on its way");
      expect(await stopSend(db, id, new Date())).toEqual({ ok: true, progress: { total: 5, sent: 0, waiting: 1, failed: 0, unknown: 0, skipped: 4 } }); // (the claimed row counts as waiting)
      g.open();
      expect(await running).toEqual({ ok: true, progress: { total: 5, sent: 0, waiting: 0, failed: 0, unknown: 0, skipped: 5 }, stopped: null });
      expect(Object.values(await statuses(id))).toEqual(Array(5).fill("skipped"));
      expect(await campaignRow(id)).toMatchObject({ status: "sent", recipients: { et: 0, ru: 0 } });
      expect(await sendRefused(kv, id), "a refusal after the stop is no news to the page").toBe(false);
      expect(await runDueCampaigns(deps(resend.send))).toEqual({ campaignId: null, progress: null, stopped: null });
      expect(resend.mails).toHaveLength(1);
    });
  }

  test("M4: a refusal while the campaign still goes out puts the row back to `waiting` as before; the stop that comes after skips it with the others", async () => {
    await subscribeMany(3);
    const id = await campaign();
    const resend = fakeSend(() => ({ ok: false, kind: "quota" }));
    expect(await press(id, deps(resend.send))).toMatchObject({ ok: true, stopped: "room", progress: { total: 3, sent: 0, waiting: 3 } });
    expect(await statuses(id)).toEqual({ "k1@example.com": "waiting", "k2@example.com": "waiting", "k3@example.com": "waiting" });
    expect(await stopSend(db, id, new Date())).toEqual({ ok: true, progress: { total: 3, sent: 0, waiting: 0, failed: 0, unknown: 0, skipped: 3 } });
  });

  test("M4: a batch whose campaign was stopped meanwhile claims nothing more (the campaign is `sending` at every claim), even where a row still waits", async () => {
    await subscribeMany(3);
    const id = await campaign();
    const plan = await prepareSend(db, id);
    if (!plan.ok) throw new Error("no plan");
    const g = gate();
    const resend = fakeSend(async (_m, n) => {
      if (n === 1) await g.shut;
      return { ok: true };
    });
    const running = startSend(deps(resend.send), id, { et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt });
    await until(async () => resend.mails.length === 1, "the first mail on its way");
    // the campaign is sent while two rows still wait (a damaged state: the stop itself skips them; this is what the claim must not go on with)
    await db.update(newsletterCampaigns).set({ status: "sent", sentAt: new Date() }).where(eq(newsletterCampaigns.id, id));
    g.open();
    expect(await running).toMatchObject({ ok: true });
    expect(resend.to(), "the first row finished; the two that wait were not claimed").toEqual(["k1@example.com"]);
    expect(await statuses(id)).toEqual({ "k1@example.com": "sent", "k2@example.com": "waiting", "k3@example.com": "waiting" });
  });
});

describe("sendTest: „Saada proov“", () => {
  test("one ordinary mail to the address given: „[Proov]“ before the subject, the test page behind its link and headers, counted; no delivery, no change", async () => {
    const id = await campaign();
    const kati = await subscribe("kati@example.com");
    const resend = fakeSend();
    expect(await sendTest(deps(resend.send), id, "maria@example.com", "et")).toEqual({ ok: true });
    expect(await sendTest(deps(resend.send), id, "maria@example.com", "ru")).toEqual({ ok: true });
    const [et, ru] = resend.mails;
    const proov = `${SITE}/api/newsletter/loobu?proov=1`;
    expect(resend.to()).toEqual(["maria@example.com", "maria@example.com"]);
    expect(et.subject).toBe("[Proov] Sügispakkumine");
    expect(ru.subject).toBe("[Proov] Осеннее предложение");
    for (const mail of [et, ru]) {
      expect(mail.html).toContain(`href="${proov}"`);
      expect(mail.headers).toEqual({ "List-Unsubscribe": `<${proov}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
      expect(mail.html).not.toContain(kati.token);
    }
    expect(ru.html).toContain(getDict("ru").mail.campaign.unsubscribe);
    expect(await mailsSentToday(db)).toBe(2);
    expect(await rowsOf(id)).toEqual([]);
    expect((await campaignRow(id)).status).toBe("draft");
    expect(logged()).not.toContain("maria@example.com");
  });

  test(`at most TEST_SEND_LIMIT (${TEST_SEND_LIMIT}) an hour (\`limited\`, nothing sent); one that did not go is not counted; the next hour again; \`notFound\`; \`mail\` when it did not go`, async () => {
    const id = await campaign();
    const refused = fakeSend(() => ({ ok: false, kind: "refused" }));
    expect(await sendTest(deps(refused.send), id, "maria@example.com", "et")).toEqual({ ok: false, error: "mail" });
    const resend = fakeSend();
    for (let i = 0; i < TEST_SEND_LIMIT; i++) expect(await sendTest(deps(resend.send), id, "maria@example.com", "et"), String(i)).toEqual({ ok: true });
    expect(await sendTest(deps(resend.send), id, "maria@example.com", "et")).toEqual({ ok: false, error: "limited" });
    expect(resend.mails).toHaveLength(TEST_SEND_LIMIT);
    vi.setSystemTime(NOW.getTime() + HOUR);
    expect(await sendTest(deps(resend.send), id, "maria@example.com", "et")).toEqual({ ok: true });
    expect(await sendTest(deps(resend.send), 999_999, "maria@example.com", "et")).toEqual({ ok: false, error: "notFound" });
    // a test of a campaign that is going out, or sent, is still possible (Maria can still write and test)
    await db.update(newsletterCampaigns).set({ status: "sent" }).where(eq(newsletterCampaigns.id, id));
    expect(await sendTest(deps(resend.send), id, "maria@example.com", "et")).toEqual({ ok: true });
  });
});

describe("runDueCampaigns: the daily job", () => {
  test("nothing being sent: nothing done; drafts and sent campaigns are never touched", async () => {
    await subscribeMany(2);
    await campaign();
    const resend = fakeSend();
    expect(await runDueCampaigns(deps(resend.send))).toEqual({ campaignId: null, progress: null, stopped: null });
    expect(resend.send).not.toHaveBeenCalled();
    expect(await db.select().from(newsletterDeliveries)).toEqual([]);
  });

  test("progressOf: a campaign without deliveries is all zeros", async () => {
    expect(await progressOf(db, await campaign())).toEqual({ total: 0, sent: 0, waiting: 0, failed: 0, unknown: 0, skipped: 0 });
  });
});
