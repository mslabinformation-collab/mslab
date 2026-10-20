import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db, Q } from "@/db/client";
import { mailQuota } from "@/db/schema";
import { countSentMail, mailsSentToday, reserveLoginMail, reserveNewsletterMail, sweepClientRows } from "@/server/client-auth";
import { notifyMaria, sendMail, type Env } from "@/server/notify";
import { fakeKv, stubFetch } from "../fakes";
import { makeTestDb } from "./helpers";

// The day's mail counter (the simple newsletter, spec §3 and §4): one `mail_quota` row "<UTC day>:all" counts every mail the site sends in a day,
// the same UTC day the other counters and Resend's own daily limit use. sendMail adds to it when Resend accepted a mail and the caller gave it the
// database; a campaign sends only while it is below its room. The count is best effort: it never throws and never changes what sendMail answers.

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rows = async () => Object.fromEntries((await db.select().from(mailQuota)).map((r) => [r.day, r.sent]));
const DAY = new Date("2026-10-20T10:00:00Z");

test("a day with no mail counts 0, and the counter writes nothing to read it", async () => {
  expect(await mailsSentToday(db, DAY)).toBe(0);
  expect(await rows()).toEqual({});
});

test("every counted mail adds one to the row '<day>:all'; the first creates it (an upsert)", async () => {
  await countSentMail(db, DAY);
  expect(await rows()).toEqual({ "2026-10-20:all": 1 });
  await countSentMail(db, DAY);
  await countSentMail(db, DAY);
  expect(await rows()).toEqual({ "2026-10-20:all": 3 });
  expect(await mailsSentToday(db, DAY)).toBe(3);
});

test("the day is the UTC date: the last millisecond of a day and the first of the next are two days, whatever the offset of the clock", async () => {
  await countSentMail(db, new Date("2026-10-20T23:59:59.999Z"));
  await countSentMail(db, new Date("2026-10-21T00:00:00.000Z"));
  await countSentMail(db, new Date("2026-10-20T23:30:00-05:00")); // = 21 October 04:30 UTC
  expect(await rows()).toEqual({ "2026-10-20:all": 1, "2026-10-21:all": 2 });
  expect(await mailsSentToday(db, new Date("2026-10-20T00:00:00Z"))).toBe(1);
  expect(await mailsSentToday(db, new Date("2026-10-21T23:59:59Z"))).toBe(2);
  expect(await mailsSentToday(db, new Date("2026-10-22T00:00:00Z"))).toBe(0);
});

test("the other counters are not this one: the logins' '<day>' and the newsletter's '<day>:nl' rows neither add to it nor are added to", async () => {
  await reserveLoginMail(db, DAY);
  await reserveLoginMail(db, DAY);
  await reserveNewsletterMail(db, DAY);
  expect(await mailsSentToday(db, DAY)).toBe(0);
  await countSentMail(db, DAY);
  expect(await rows()).toEqual({ "2026-10-20": 2, "2026-10-20:nl": 1, "2026-10-20:all": 1 });
  expect(await mailsSentToday(db, DAY)).toBe(1);
});

test("mails counted at the same moment are all counted (the increment is one statement, not a read and a write)", async () => {
  await Promise.all(Array.from({ length: 12 }, () => countSentMail(db, DAY)));
  expect(await mailsSentToday(db, DAY)).toBe(12);
});

test("countSentMail never throws: a database that fails, throws at once or rejects is logged by class, never by message, and the caller goes on", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const rejects = { insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.reject(new Error("no connection for kati@example.test")) }) }) } as unknown as Q;
  const throwsAtOnce = { insert: () => { throw new Error("no connection for kati@example.test"); } } as unknown as Q;
  await expect(countSentMail(rejects, DAY)).resolves.toBeUndefined();
  await expect(countSentMail(throwsAtOnce, DAY)).resolves.toBeUndefined();
  expect(error).toHaveBeenCalledTimes(2);
  expect(error.mock.calls.flat().join(" ")).not.toContain("kati@example.test");
});

test("the daily sweep removes the '<day>:all' rows of days more than a week back with the other counters' rows, and keeps the recent ones", async () => {
  await db.insert(mailQuota).values([
    { day: "2026-10-01:all", sent: 40 }, { day: "2026-10-01", sent: 3 }, { day: "2026-10-01:nl", sent: 1 }, { day: "2026-10-18:all", sent: 20 }, { day: "2026-10-20:all", sent: 5 },
  ]);
  expect(await sweepClientRows(db, new Date("2026-10-20T04:00:00Z"))).toMatchObject({ mailDays: 3 });
  expect(await rows()).toEqual({ "2026-10-18:all": 20, "2026-10-20:all": 5 });
});

// sendMail: the count (an optional third argument gives it the database; without it nothing is counted, as before)

const env = (extra: Partial<Env> = {}): Env => ({
  KV: fakeKv(),
  MAIL_FROM: "MS LAB <info@send.mslab.example>",
  MARIA_EMAIL: "maria@example.test",
  SITE_URL: "https://mslab.example",
  RESEND_API_KEY: "re_test",
  ...extra,
});
const mail = { to: "kati@example.test", subject: "S", text: "T" };
const accepted = () => Response.json({ id: "email_1" });
const refused = () => Response.json({ name: "validation_error", message: "Invalid to address.", statusCode: 422 }, { status: 422 });

test("sendMail counts a mail Resend accepted, on today's UTC day, and only when it is given the database", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T23:59:59Z"));
  stubFetch(accepted);
  expect(await sendMail(env(), mail, { count: db })).toBe(true);
  expect(await rows()).toEqual({ "2026-10-20:all": 1 });
  vi.setSystemTime(new Date("2026-10-21T00:00:01Z"));
  expect(await sendMail(env(), mail, { count: db })).toBe(true);
  expect(await sendMail(env(), mail)).toBe(true); // no database given: sent, not counted
  expect(await sendMail(env(), mail, {})).toBe(true);
  expect(await rows()).toEqual({ "2026-10-20:all": 1, "2026-10-21:all": 1 });
});

test("sendMail does not count a mail that was not accepted: a refusal, a failed request, a missing key; and answers false as before", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubFetch(refused);
  expect(await sendMail(env(), mail, { count: db })).toBe(false);
  stubFetch(() => {
    throw new Error("network down");
  });
  expect(await sendMail(env(), mail, { count: db })).toBe(false);
  const f = stubFetch(accepted);
  expect(await sendMail(env({ RESEND_API_KEY: undefined }), mail, { count: db })).toBe(false);
  expect(f.calls).toHaveLength(0);
  expect(await rows()).toEqual({});
});

test("a send Resend asked to wait for and then accepted is one mail, counted once", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  let n = 0;
  const f = stubFetch(() => (++n === 1 ? Response.json({ name: "rate_limit_exceeded", message: "slow down", statusCode: 429 }, { status: 429 }) : accepted()));
  const sent = sendMail(env(), mail, { count: db });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await sent).toBe(true);
  expect(f.calls).toHaveLength(2);
  expect(Object.values(await rows())).toEqual([1]);
});

test("the count is best effort: a database that fails does not turn an accepted mail into a failure, and the log keeps no address", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  stubFetch(accepted);
  const broken = { insert: () => { throw new Error("no connection for kati@example.test"); } } as unknown as Q;
  expect(await sendMail(env(), mail, { count: broken })).toBe(true);
  expect(error.mock.calls.flat().join(" ")).not.toContain("kati@example.test");
});

test("notifyMaria's mail is counted when it is given the database (the Telegram ping is not a mail and is not counted)", async () => {
  stubFetch((url) => (url.startsWith("https://api.telegram.org/") ? Response.json({ ok: true }) : accepted()));
  const key = env({ TELEGRAM_BOT_TOKEN: "tg", TELEGRAM_CHAT_ID: "42" });
  expect(await notifyMaria(key, "Teema", "Tekst", { count: db })).toEqual({ mail: true, telegram: true });
  expect(await rows()).toEqual({ [`${new Date().toISOString().slice(0, 10)}:all`]: 1 });
  expect(await notifyMaria(key, "Teema", "Tekst")).toEqual({ mail: true, telegram: true }); // not given: not counted
  expect(Object.values(await rows())).toEqual([1]);
});
