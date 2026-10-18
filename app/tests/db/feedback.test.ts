import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db, Tx } from "@/db/client";
import { clients, clientSessions, courseFeedback, courseSessions, registrations } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { loadDashboard } from "@/server/client-data";
import { submitFeedback } from "@/server/course-feedback";
import type { Env } from "@/server/notify";
import { saveProtocol, sendProtocol } from "@/server/protocols";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, stubFetch } from "../fakes";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// The course feedback form (spec §3, §7, §10): when it opens, the dashboard's card and "Ei soovi", the one submit per registration with its
// checks, and Maria's notice after the response.

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-12T16:00:00Z");
let db: Db;
let net: ReturnType<typeof stubFetch>;
/** Resend and Telegram "on" (the stubbed fetch answers them); a fresh rate-limit store each test (every test's client is id 1). */
let env: Env;
/** Everything the code under test logged (console.info and console.error: server/log.ts writes to those two), one line per call. */
let logged: () => string;
beforeEach(async () => {
  db = await makeTestDb();
  env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" };
  net = stubFetch((url) => (url.includes("telegram") ? Response.json({ ok: true }) : Response.json({ id: "email_1" })));
  const spies = (["info", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  logged = () => spies.flatMap((spy) => spy.mock.calls).map((args) => args.map(String).join(" ")).join("\n");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deps(now = NOW) {
  const tasks: (() => Promise<unknown>)[] = [];
  const d: AccountDeps = { db, env, now, siteUrl: SITE, later: (task) => void tasks.push(task), dev: false };
  return { d, queued: () => tasks.length, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
}
async function cookieOf(clientId: number): Promise<string> {
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return `__Host-mslab_client=${raw}`;
}
const call = async (d: AccountDeps, cookie: string, path: string, body?: unknown) =>
  (await handleAccountApi(
    new Request(`${SITE}/api/konto${path}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body) }),
    d,
  ))!;
const answer = async (res: Response) => [res.status, await res.json()];
const rows = () => db.select().from(courseFeedback);
const mails = () => net.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as { to: string; subject: string; text: string });

/** Mari's registration with a sent protocol (the form opens with it), her account and session. */
async function opened(locale: "et" | "ru" = "et") {
  const { course, session } = await protocolCourse(db);
  const mari = await student(db, course, session, "Mari Maasikas", { locale });
  await saveProtocol(db, { registrationId: mari.id, version: 0, titles: HEADINGS, notes: ["Hea", "", "", ""], generalNote: "" }, NOW);
  await sendProtocol({ db, env, siteUrl: SITE, now: NOW, later: () => {} }, { registrationId: mari.id, version: 1 });
  const [account] = await db.select().from(clients).where(eq(clients.email, "marimaasikas@example.com"));
  return { course, session, mari, account, cookie: await cookieOf(account.id) };
}

describe("the form opens", () => {
  test("with the sent protocol: GET names the course and says nothing is sent; the dashboard has its card", async () => {
    const { mari, account, cookie } = await opened();
    expect(await answer(await call(deps().d, cookie, `/tagasiside?id=${mari.id}`))).toEqual([200, { ok: true, course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } }, sent: false, shownName: "Mari M." }]);
    expect((await loadDashboard(db, account.id, NOW))!.feedback).toEqual([{ registrationId: mari.id, course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } } }]);
  });

  test("a group session that started before today opens it without a protocol (spec §3); one called off does not; one that starts today does not", async () => {
    const { course, session } = await protocolCourse(db);
    const [account] = await db.insert(clients).values({ email: "anu@example.com" }).returning();
    const anu = await student(db, course, session, "Anu", { clientId: account.id, email: "anu@example.com" });
    const cookie = await cookieOf(account.id);
    // the course day 12.10, asked at 16:00 the same day: not yet
    expect((await call(deps().d, cookie, `/tagasiside?id=${anu.id}`)).status).toBe(404);
    expect((await loadDashboard(db, account.id, NOW))!).not.toHaveProperty("feedback");
    const nextDay = new Date("2026-10-13T08:00:00Z");
    expect((await call(deps(nextDay).d, cookie, `/tagasiside?id=${anu.id}`)).status).toBe(200);
    await db.update(courseSessions).set({ status: "cancelled" }).where(eq(courseSessions.id, session.id));
    expect((await call(deps(nextDay).d, cookie, `/tagasiside?id=${anu.id}`)).status).toBe(404);
  });

  test("not hers, cancelled, or an id that is no id: 404", async () => {
    const { course, session, mari, cookie } = await opened();
    const other = await student(db, course, session, "Teine");
    for (const id of [String(other.id), "abc", "0"]) expect((await call(deps().d, cookie, `/tagasiside?id=${id}`)).status, id).toBe(404);
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, mari.id));
    expect((await call(deps().d, cookie, `/tagasiside?id=${mari.id}`)).status).toBe(404);
    expect((await call(deps().d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 9 } })).status).toBe(404);
  });
});

describe("the submit", () => {
  test("stores the answers as keys with the page's language, answers 200 and tells Maria after the response; a second one is 409; the card is gone", async () => {
    const { mari, account, cookie } = await opened();
    const { d, queued, flush } = deps();
    const answers = { score: 9, expectations: "met", ready: "mostly", message: "  Aitäh!  " };
    expect(await answer(await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers }))).toEqual([200, { ok: true }]);
    const [row] = await rows();
    expect(row).toMatchObject({ registrationId: mari.id, answers: { score: 9, expectations: "met", ready: "mostly", message: "Aitäh!" }, locale: "et", submittedAt: NOW, dismissedAt: null });
    expect(mails()).toEqual([]);
    expect(queued()).toBe(1);
    await flush();
    const [mail] = mails();
    expect([mail.to, mail.subject]).toEqual(["maria@example.test", "Uus tagasiside: Mari Maasikas, Kulmude lamineerimine, 9/10"]);
    expect(mail.text).toContain("Kas koolitus vastas sinu ootustele?\nVastas ootustele");
    expect(net.calls.some((c) => c.url.includes("telegram") && String((c.body as { text: string }).text).startsWith("Uus tagasiside: Mari Maasikas"))).toBe(true);
    expect(await answer(await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 3 } }))).toEqual([409, { ok: false, error: "sent" }]);
    expect(queued()).toBe(0); // the replay told nobody: Maria's notice goes out once only
    expect((await rows())[0].answers).toEqual({ score: 9, expectations: "met", ready: "mostly", message: "Aitäh!" });
    expect(await answer(await call(d, cookie, `/tagasiside?id=${mari.id}`))).toEqual([200, expect.objectContaining({ sent: true })]);
    expect((await loadDashboard(db, account.id, NOW))!).not.toHaveProperty("feedback");
  });

  test("the answers are checked: none is 'empty', an unknown key, a score of 11 or a text over 2000 names the key; nothing is stored", async () => {
    const { mari, cookie } = await opened();
    const post = (answers: unknown) => call(deps().d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers });
    expect(await answer(await post({}))).toEqual([400, { ok: false, error: "empty" }]);
    expect(await answer(await post({ score: 9, extra: 1 }))).toEqual([400, { ok: false, error: "answers" }]);
    expect(await answer(await post({ score: 11 }))).toEqual([400, { ok: false, error: "score" }]);
    expect(await answer(await post({ message: "x".repeat(2001) }))).toEqual([400, { ok: false, error: "message" }]);
    expect(await answer(await call(deps().d, cookie, "/tagasiside", { registrationId: mari.id, locale: "en", answers: { score: 9 } }))).toEqual([400, { ok: false, error: "locale" }]);
    expect(await rows()).toEqual([]);
  });

  test("Review Focus 5: a Russian answer is stored with its language, and Maria's notice is in her Estonian wording", async () => {
    const { mari, cookie } = await opened("ru");
    const { d, flush } = deps();
    await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "ru", answers: { trainer: "excellent", recommend: "Да, всем советую" } });
    expect((await rows())[0]).toMatchObject({ locale: "ru", answers: { trainer: "excellent", recommend: "Да, всем советую" } });
    await flush();
    const [mail] = mails();
    expect(mail.subject).toBe("Uus tagasiside: Mari Maasikas, Kulmude lamineerimine");
    expect(mail.text).toContain("Kuidas hindad koolitaja juhendamisoskust ja selgitusi?\nVäga professionaalne ja toetav");
    expect(mail.text).toContain("Kas soovitaksid seda koolitust ka teistele? Miks?\nДа, всем советую");
  });

  test("ten a client an hour, the submits and the 'Ei soovi's together (a body that fails its check is not counted); then 429", async () => {
    const { mari, cookie } = await opened();
    const { d } = deps();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 9 } })).status);
    expect(statuses).toEqual([200, ...Array(9).fill(409)]);
    expect(await answer(await call(d, cookie, "/tagasiside/peida", { registrationId: mari.id }))).toEqual([429, { ok: false, error: "rate" }]);
    expect(await answer(await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 9 } }))).toEqual([429, { ok: false, error: "rate" }]);
  });
});

describe("'Ei soovi'", () => {
  test("the card is gone for good, nothing is answered or told; the form still takes her answers later (the mail's link)", async () => {
    const { mari, account, cookie } = await opened();
    const { d, queued } = deps();
    expect(await answer(await call(d, cookie, "/tagasiside/peida", { registrationId: mari.id }))).toEqual([200, { ok: true }]);
    expect((await rows())[0]).toMatchObject({ answers: null, submittedAt: null, dismissedAt: NOW });
    expect(queued()).toBe(0);
    expect((await loadDashboard(db, account.id, NOW))!).not.toHaveProperty("feedback");
    expect(await answer(await call(d, cookie, "/tagasiside/peida", { registrationId: mari.id }))).toEqual([200, { ok: true }]); // twice: the same
    expect(queued()).toBe(0);
    expect((await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 8 } })).status).toBe(200);
    expect((await rows())[0]).toMatchObject({ answers: { score: 8 }, submittedAt: NOW, dismissedAt: NOW });
  });

  test("not hers, or not open: 404, nothing stored", async () => {
    const { course, session, cookie } = await opened();
    const other = await student(db, course, session, "Teine");
    expect(await answer(await call(deps().d, cookie, "/tagasiside/peida", { registrationId: other.id }))).toEqual([404, { ok: false, error: "registration" }]);
    expect(await rows()).toEqual([]);
  });
});

describe("another client's registration", () => {
  test("open for its own owner, but for her: the form, the submit and 'Ei soovi' are 404, nothing is stored or told", async () => {
    const { course, session, cookie } = await opened();
    const [other] = await db.insert(clients).values({ email: "teine@example.com" }).returning();
    const teine = await student(db, course, session, "Teine", { clientId: other.id, email: "teine@example.com" });
    const nextDay = new Date("2026-10-13T08:00:00Z"); // the course day is over: every group registration's form is open
    const { d, queued } = deps(nextDay);
    expect((await call(d, await cookieOf(other.id), `/tagasiside?id=${teine.id}`)).status).toBe(200); // it is open for its owner
    expect(await answer(await call(d, cookie, `/tagasiside?id=${teine.id}`))).toEqual([404, { ok: false }]);
    expect(await answer(await call(d, cookie, "/tagasiside", { registrationId: teine.id, locale: "et", answers: { score: 9 } }))).toEqual([404, { ok: false, error: "registration" }]);
    expect(await answer(await call(d, cookie, "/tagasiside/peida", { registrationId: teine.id }))).toEqual([404, { ok: false, error: "registration" }]);
    expect(await rows()).toEqual([]);
    expect(queued()).toBe(0);
  });
});

describe("what is logged", () => {
  test("registration ids only: no address, name or answer text, from the submit, the replay, the limit and Maria's notice", async () => {
    const { mari, cookie } = await opened();
    const { d, flush } = deps();
    const secret = "Salajane vastus 7731";
    await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 9, message: secret } });
    await flush();
    await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { message: secret } }); // the replay: 409
    for (let i = 0; i < 9; i++) await call(d, cookie, "/tagasiside/peida", { registrationId: mari.id });
    expect((await call(d, cookie, "/tagasiside/peida", { registrationId: mari.id })).status).toBe(429);
    const log = logged();
    expect(log).toContain(`[feedback] registration ${mari.id}: submitted`);
    expect(log).toContain(`[feedback] registration ${mari.id}: Maria notified`);
    expect(log).toContain("[account] feedback rate limited");
    for (const text of [secret, "Mari Maasikas", "Maasikas", "marimaasikas", "example.com", "maria@example.test", "re_test", "123:abc"]) expect(log, text).not.toContain(text);
  });

  test("a submit whose transaction does not commit stores nothing and is never logged as submitted", async () => {
    const { mari, account } = await opened();
    // the callback runs to its end, then the transaction fails: what the database does when the commit cannot be made
    const failing = new Proxy(db, {
      get: (target, prop) => (prop === "transaction" ? (work: (tx: Tx) => Promise<unknown>) => target.transaction(async (tx) => {
        await work(tx);
        throw new Error("commit failed");
      }) : Reflect.get(target, prop, target)),
    });
    await expect(submitFeedback(failing, { clientId: account.id, target: { registrationId: mari.id }, answers: { score: 9 }, locale: "et", consent: null }, NOW)).rejects.toThrow("commit failed");
    expect(await rows()).toEqual([]);
    expect(logged()).not.toContain("submitted");
  });
});

describe("who may ask", () => {
  test("without a session: 401 on all three; a post from another site: 403, nothing stored or sent", async () => {
    const { mari, cookie } = await opened();
    const { d, queued } = deps();
    const answers = { score: 9 };
    expect((await call(d, "", `/tagasiside?id=${mari.id}`)).status).toBe(401);
    expect((await call(d, "", "/tagasiside", { registrationId: mari.id, locale: "et", answers })).status).toBe(401);
    expect((await call(d, "", "/tagasiside/peida", { registrationId: mari.id })).status).toBe(401);
    for (const [path, body] of [["/tagasiside", { registrationId: mari.id, locale: "et", answers }], ["/tagasiside/peida", { registrationId: mari.id }]] as const) {
      const request = new Request(`${SITE}/api/konto${path}`, { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await handleAccountApi(request, d))!.status, path).toBe(403);
    }
    expect(await rows()).toEqual([]);
    expect(queued()).toBe(0);
  });

  test("a body that is not JSON, not an object, or has no registration id: 400, and the limit is not spent on it", async () => {
    const { mari, cookie } = await opened();
    const { d } = deps();
    for (const body of [{}, { registrationId: "7", locale: "et", answers: { score: 9 } }, { registrationId: 0, locale: "et", answers: { score: 9 } }]) {
      expect((await call(d, cookie, "/tagasiside", body)).status, JSON.stringify(body)).toBe(400);
      expect((await call(d, cookie, "/tagasiside/peida", body)).status, JSON.stringify(body)).toBe(400);
    }
    const garbage = await handleAccountApi(new Request(`${SITE}/api/konto/tagasiside`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "not json" }), d);
    expect(garbage!.status).toBe(400);
    // ten good submits are still all there to use
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await call(d, cookie, "/tagasiside", { registrationId: mari.id, locale: "et", answers: { score: 9 } })).status);
    expect(statuses).toEqual([200, ...Array(9).fill(409)]);
  });
});
