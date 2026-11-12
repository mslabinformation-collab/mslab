import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, discountCodes, mailQuota, subscribers } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS, CONFIRMATION_MAIL_DAILY_CAP, LOGIN_MAIL_DAILY_CAP, NEWSLETTER_MAIL_DAILY_CAP } from "@/server/client-auth";
import { clientNewsletter, confirmNewsletter, newsletterState, sendWelcome } from "@/server/newsletter";
import type { Env } from "@/server/notify";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, stubFetch } from "../fakes";
import { capRows, countedMails, makeTestDb } from "./helpers";

// Phase 2c (spec 5), one step since 09.10: the welcome mail goes out to a newly subscribed address — the sign-up (actions.test.ts), "Saada mulle
// uudiskirja" in Minu andmed, or a confirmation link of the old flow (confirmNewsletter, which still sends it only when a welcome code is valid today) — once,
// in the address's language, with or without the code, and always with the unsubscribe link; never again for that address this year.
// Mails go to a stubbed Resend (addresses at example.com: a sample address, @example.test, is never mailed).

const NOW = new Date("2026-10-08T10:00:00Z");
let db: Db;
let kv: ReturnType<typeof fakeKv>;
const SITE = "https://mslab.example";
const env = (): Env => ({ KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test" });

beforeEach(async () => {
  db = await makeTestDb();
  kv = fakeKv();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const outbox = () => {
  const f = stubFetch(() => Response.json({ id: "email_1" }));
  return () => f.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as { to: string; subject: string; text: string });
};
/**
 * The newsletter's welcome code is the `welcome` row of discount_codes (F1 Task 11): none (`null`), or one with `over` laid on a 10% code TERE10
 * (the row's own days, dates and switch decide whether it is valid on NOW).
 */
const setWelcome = async (over: Partial<typeof discountCodes.$inferInsert> | null = {}) => {
  await db.delete(discountCodes).where(eq(discountCodes.welcome, true));
  if (over) await db.insert(discountCodes).values({ code: "TERE10", welcome: true, percent: 10, audience: "first", oncePerPerson: true, ...over });
};

/** confirmNewsletter with the work after the response collected; `run()` does it. */
function confirm(token: string, now = NOW) {
  const tasks: (() => Promise<unknown>)[] = [];
  const result = confirmNewsletter({ db, env: env(), now, siteUrl: SITE, later: (t) => void tasks.push(t) }, token);
  return { result, run: async () => Promise.all(tasks.splice(0).map((t) => t())) };
}

test("the first confirmation with a code set: the code for the confirmed page and one welcome mail in the subscriber's language; a repeat: neither", async () => {
  const mails = outbox();
  await setWelcome();
  await db.insert(subscribers).values({ email: "uus@example.com", locale: "ru", token: "t".repeat(43) });
  const first = confirm("t".repeat(43));
  expect(await first.result).toEqual({ outcome: "kinnitatud", locale: "ru", code: "TERE10" });
  await first.run();
  expect(mails().map((m) => [m.to, m.subject])).toEqual([["uus@example.com", "Добро пожаловать в MS LAB!"]]);
  expect(mails()[0].text).toContain("TERE10");
  expect(mails()[0].text).toContain(`${SITE}/api/newsletter/loobu?t=${"t".repeat(43)}`); // the unsubscribe link of the row, in the Russian line
  expect(mails()[0].text).toContain("отпишитесь здесь:");
  const again = confirm("t".repeat(43), new Date(NOW.getTime() + 60_000));
  expect(await again.result).toEqual({ outcome: "kinnitatud", locale: "ru", code: null });
  await again.run();
  expect(mails()).toHaveLength(1);
});

test("A12: with no active welcome code the confirm path keeps today's behaviour: confirmed, no code line, no mail; an unknown token: vigane", async () => {
  const mails = outbox();
  await setWelcome(null);
  await db.insert(subscribers).values({ email: "uus@example.com", token: "u".repeat(43) });
  const c = confirm("u".repeat(43));
  expect(await c.result).toEqual({ outcome: "kinnitatud", locale: "et", code: null });
  await c.run();
  expect(mails()).toEqual([]);
  expect(await confirm("x".repeat(43)).result).toEqual({ outcome: "vigane", locale: "et", code: null });
});

test("the confirmed page's fragment carries the code only while valid: the row's switch and dates decide, today in Estonia (R10: its scope and limit do not)", async () => {
  const mails = outbox();
  let n = 0;
  /** The first confirmation of a new address, with the welcome row as `over` has it (null: no row): the code the page would carry. */
  const codeOnPage = async (over: Partial<typeof discountCodes.$inferInsert> | null) => {
    await setWelcome(over);
    n += 1;
    const token = String(n).padStart(2, "0").repeat(22).slice(0, 43);
    await db.insert(subscribers).values({ email: `uus${n}@example.com`, token });
    const c = confirm(token);
    const { code } = await c.result;
    await c.run();
    return code;
  };
  expect(await codeOnPage({})).toBe("TERE10");
  expect(await codeOnPage({ code: "MAAILM", scope: "courses", maxUses: 1 })).toBe("MAAILM"); // R10: neither scope nor uses are looked at
  expect(await codeOnPage({ startsOn: "2026-10-08", endsOn: "2026-10-08" })).toBe("TERE10"); // the last day is inside
  expect(await codeOnPage({ active: false })).toBeNull();
  expect(await codeOnPage({ endsOn: "2026-10-07" })).toBeNull();
  expect(await codeOnPage({ startsOn: "2026-10-09" })).toBeNull();
  expect(await codeOnPage(null)).toBeNull();
  // a mail went to the three addresses with a valid code and to no one else
  expect(mails().map((m) => m.to)).toEqual(["uus1@example.com", "uus2@example.com", "uus3@example.com"]);
});

test("never twice for one address: switched off and on again (a new row), the welcome mail does not come again; the day's cap counts it", async () => {
  const mails = outbox();
  await setWelcome();
  await db.insert(subscribers).values({ email: "uus@example.com", token: "a".repeat(43) });
  const one = confirm("a".repeat(43));
  await one.result;
  await one.run();
  await db.delete(subscribers);
  await db.insert(subscribers).values({ email: "uus@example.com", token: "b".repeat(43) });
  const two = confirm("b".repeat(43));
  expect((await two.result).code).toBe("TERE10"); // the page still shows the code of a first confirmation
  await two.run();
  expect(mails()).toHaveLength(1);
  expect((await capRows(db))[0].sent).toBe(1);
  expect(await countedMails(db)).toBe(1); // the day's count of every mail has it, once
});

test("the newsletter's own daily cap reached: no welcome mail; the shared counter full (the logins', the registrations' confirmations') does not stop it", async () => {
  const mails = outbox();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await setWelcome();
  const today = NOW.toISOString().slice(0, 10);
  await db.insert(mailQuota).values({ day: `${today}:nl`, sent: NEWSLETTER_MAIL_DAILY_CAP });
  await db.insert(subscribers).values({ email: "uus@example.com", token: "c".repeat(43) });
  const c = confirm("c".repeat(43));
  await c.result;
  await c.run();
  expect(mails()).toEqual([]);
  expect(await db.select().from(mailQuota).where(eq(mailQuota.day, `${today}:nl`))).toEqual([{ day: `${today}:nl`, sent: NEWSLETTER_MAIL_DAILY_CAP }]); // no place taken past the cap
  // the other way round: the shared counter at its caps, the newsletter's own one open
  await db.delete(mailQuota);
  await db.insert(mailQuota).values({ day: today, sent: Math.max(CONFIRMATION_MAIL_DAILY_CAP, LOGIN_MAIL_DAILY_CAP) });
  await db.insert(subscribers).values({ email: "teine@example.com", token: "d".repeat(43) });
  const d = confirm("d".repeat(43));
  await d.result;
  await d.run();
  expect(mails().map((m) => m.to)).toEqual(["teine@example.com"]);
  expect(await db.select().from(mailQuota).where(eq(mailQuota.day, `${today}:nl`))).toEqual([{ day: `${today}:nl`, sent: 1 }]);
});

test("newsletterState and clientNewsletter: yes / pending / no, whatever the stored case", async () => {
  await db.insert(subscribers).values([{ email: "Yes@Example.com", token: "1", confirmedAt: NOW }, { email: "pending@example.com", token: "2" }]);
  expect(await newsletterState(db, "yes@example.com")).toBe("yes");
  expect(await newsletterState(db, "PENDING@example.com")).toBe("pending");
  expect(await newsletterState(db, "no@example.com")).toBe("no");
  const [kati] = await db.insert(clients).values({ email: "yes@example.com", locale: "ru" }).returning();
  expect(await clientNewsletter(db, kati.id)).toEqual({ email: "yes@example.com", locale: "ru", state: "yes" });
  expect(await clientNewsletter(db, 987654)).toBeNull();
});

test("Minu andmed: 'Soovin MS LABi sooduspakkumisi ja uudiskirju saada' on confirms at once and sends the welcome mail once; on again, or off and on, no second mail", async () => {
  const mails = outbox();
  await setWelcome();
  const [kati] = await db.insert(clients).values({ email: "kati@example.com" }).returning();
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: kati.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  const tasks: (() => Promise<unknown>)[] = [];
  const deps: AccountDeps = { db, env: env(), now: NOW, siteUrl: SITE, later: (t) => void tasks.push(t), dev: false };
  const post = async (on: boolean) => {
    const res = (await handleAccountApi(new Request("https://mslab.example/api/konto/uudiskiri", { method: "POST", headers: { cookie: `__Host-mslab_client=${raw}` }, body: JSON.stringify({ on }) }), deps))!;
    await Promise.all(tasks.splice(0).map((t) => t()));
    return res.status;
  };
  expect(await post(true)).toBe(200);
  expect(mails().map((m) => m.subject)).toEqual(["Tere tulemast MS LABi!"]);
  expect(await post(true)).toBe(200); // already on
  expect(await post(false)).toBe(200);
  expect(await post(true)).toBe(200); // a new row, confirmed at once: the KV mark stops a second welcome
  expect(mails()).toHaveLength(1);
  expect((await db.select().from(subscribers).where(eq(subscribers.email, "kati@example.com")))[0].confirmedAt).toEqual(NOW);
});

test("a welcome mail that Resend refuses leaves no 'once a year' mark: the next try for that address sends it; the cap slot stays spent", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let refuse = true;
  const f = stubFetch(() => (refuse ? Response.json({ name: "application_error", message: "down", statusCode: 500 }, { status: 500 }) : Response.json({ id: "email_1" })));
  const resend = () => f.calls.filter((c) => c.url.includes("resend"));
  await setWelcome();
  await db.insert(subscribers).values({ email: "uus@example.com", token: "r".repeat(43), confirmedAt: NOW });
  const deps = { db, env: env(), now: NOW, siteUrl: SITE };
  await sendWelcome(deps, { email: "uus@example.com", locale: "et" });
  expect(resend()).toHaveLength(1); // tried, refused
  expect([...kv.store.keys()].filter((k) => k.startsWith("rl:welcome:"))).toEqual([]); // nothing marks the address as welcomed
  refuse = false;
  await sendWelcome(deps, { email: "uus@example.com", locale: "et" });
  expect(resend()).toHaveLength(2); // sent now
  expect((resend()[1].body as { to: string }).to).toBe("uus@example.com");
  expect((await capRows(db)).map((r) => r.sent)).toEqual([2]); // the refused try's place is not given back
  expect(await countedMails(db)).toBe(1); // the day's count of every mail has only the one Resend took
  await sendWelcome(deps, { email: "uus@example.com", locale: "et" });
  expect(resend()).toHaveLength(2); // delivered: the mark holds for the year
  expect([...kv.store.keys()].filter((k) => k.startsWith("rl:welcome:"))).toHaveLength(1);
});

test("a store without a delete forgets the mark by a put that expires at once (and reads as no mark)", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { delete: _delete, ...noDelete } = kv;
  void _delete;
  kv = noDelete as unknown as ReturnType<typeof fakeKv>;
  let refuse = true;
  const f = stubFetch(() => (refuse ? Response.json({ name: "application_error", message: "down", statusCode: 500 }, { status: 500 }) : Response.json({ id: "email_1" })));
  await setWelcome();
  await db.insert(subscribers).values({ email: "uus@example.com", token: "r".repeat(43), confirmedAt: NOW });
  const deps = { db, env: env(), now: NOW, siteUrl: SITE };
  await sendWelcome(deps, { email: "uus@example.com", locale: "et" });
  refuse = false;
  await sendWelcome(deps, { email: "uus@example.com", locale: "et" });
  expect(f.calls.filter((c) => c.url.includes("resend"))).toHaveLength(2);
});

test("the welcome code cannot be read after the first confirmation: still 'kinnitatud' (it is true), no code for the page, the welcome task is scheduled and reads the row itself", async () => {
  const mails = outbox();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await setWelcome();
  await db.insert(subscribers).values({ email: "uus@example.com", locale: "et", token: "d".repeat(43) });
  await db.execute(sql`alter table discount_codes rename to discount_codes_away`);
  let c: ReturnType<typeof confirm>;
  try {
    c = confirm("d".repeat(43));
    expect(await c.result).toEqual({ outcome: "kinnitatud", locale: "et", code: null });
  } finally {
    await db.execute(sql`alter table discount_codes_away rename to discount_codes`);
  }
  expect((await db.select().from(subscribers))[0].confirmedAt).toEqual(NOW); // the confirmation itself stood
  await c.run(); // the row is back: the welcome mail goes out with the code
  expect(mails().map((m) => m.to)).toEqual(["uus@example.com"]);
  expect(mails()[0].text).toContain("TERE10");
  const lines = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
  expect(lines).toContain("welcome code unavailable after the confirmation");
  expect(lines).not.toContain("uus@example.com");
});

test("no code lines while the welcome code is paused or ended: the mail still goes out, with the unsubscribe line", async () => {
  const mails = outbox();
  const cases: [string, Partial<typeof discountCodes.$inferInsert> | null][] = [
    ["paused", { active: false }],
    ["ended", { endsOn: "2026-10-07" }],
    ["not yet started", { startsOn: "2026-10-09" }],
    ["no row", null],
  ];
  for (const [i, [why, over]] of cases.entries()) {
    await setWelcome(over);
    const email = `uus${i}@example.com`;
    await db.insert(subscribers).values({ email, locale: "et", token: `${"w".repeat(40)}${String(i).padStart(3, "0")}`, confirmedAt: NOW });
    await sendWelcome({ db, env: env(), now: NOW, siteUrl: `${SITE}/` }, { email, locale: "et" });
    const mail = mails().at(-1)!;
    expect(mail.to, why).toBe(email);
    expect(mail.subject, why).toBe("Tere tulemast MS LABi!");
    expect(mail.text, why).not.toContain("tervituskood");
    expect(mail.text, why).not.toContain("TERE10");
    expect(mail.text, why).not.toContain("Sooduskood");
    expect(mail.text, why).toContain(`Kui sa ei liitunud ise või ei soovi enam MS LABi kirju, loobu siit: ${SITE}/api/newsletter/loobu?t=${"w".repeat(40)}${String(i).padStart(3, "0")}`); // one slash, whatever the base ends with
  }
  expect(mails()).toHaveLength(cases.length);
});

test("sendWelcome for an address that has no row any more (it unsubscribed meanwhile): no mail, no place taken, no mark", async () => {
  const mails = outbox();
  await setWelcome();
  await sendWelcome({ db, env: env(), now: NOW, siteUrl: SITE }, { email: "uus@example.com", locale: "et" });
  expect(mails()).toEqual([]);
  expect(await capRows(db)).toEqual([]);
  expect([...kv.store.keys()].filter((k) => k.startsWith("rl:welcome:"))).toEqual([]);
});

test("sendWelcome logs no address, no token and no code", async () => {
  outbox();
  await setWelcome();
  await db.insert(subscribers).values({ email: "uus@example.com", token: "z".repeat(43), confirmedAt: NOW });
  await sendWelcome({ db, env: env(), now: NOW, siteUrl: SITE }, { email: "uus@example.com", locale: "et" });
  const logged = JSON.stringify((console.info as unknown as { mock: { calls: unknown[] } }).mock.calls);
  for (const secret of ["uus@example.com", "z".repeat(43), "TERE10"]) expect(logged).not.toContain(secret);
});

test("Minu andmed: switching the newsletter on with no welcome code sends the welcome mail without code lines, with the unsubscribe link of the new row", async () => {
  const mails = outbox();
  await setWelcome(null);
  const [kati] = await db.insert(clients).values({ email: "kati@example.com", locale: "ru" }).returning();
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: kati.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  const tasks: (() => Promise<unknown>)[] = [];
  const deps: AccountDeps = { db, env: env(), now: NOW, siteUrl: SITE, later: (t) => void tasks.push(t), dev: false };
  const res = (await handleAccountApi(new Request("https://mslab.example/api/konto/uudiskiri", { method: "POST", headers: { cookie: `__Host-mslab_client=${raw}` }, body: JSON.stringify({ on: true }) }), deps))!;
  await Promise.all(tasks.splice(0).map((t) => t()));
  expect(res.status).toBe(200);
  const [row] = await db.select().from(subscribers).where(eq(subscribers.email, "kati@example.com"));
  expect(row.confirmedAt).toEqual(NOW);
  expect(mails().map((m) => [m.to, m.subject])).toEqual([["kati@example.com", "Добро пожаловать в\u00a0MS LAB!"]]);
  expect(mails()[0].text).not.toContain("приветственный код");
  expect(mails()[0].text).toContain(`${SITE}/api/newsletter/loobu?t=${row.token}`);
});

test("the mail carries the code, the value and the days: all from the welcome row (percent or euros, its days in the language's number forms)", async () => {
  const mails = outbox();
  let n = 0;
  /** The welcome mail of a new address in `locale` with the welcome row as `over` has it: its text. */
  const welcome = async (over: Partial<typeof discountCodes.$inferInsert>, locale: "et" | "ru" = "et") => {
    await setWelcome(over);
    n += 1;
    const email = `uus${n}@example.com`;
    await db.insert(subscribers).values({ email, locale, token: `${"k".repeat(40)}${String(n).padStart(3, "0")}`, confirmedAt: NOW });
    await sendWelcome({ db, env: env(), now: NOW, siteUrl: SITE }, { email, locale });
    const mail = mails().at(-1)!;
    expect(mail.to).toBe(email);
    return mail.text;
  };
  const et = await welcome({ percent: 15, daysAfterSignup: 30 });
  expect(et).toContain("Sinu tervituskood:\n\nTERE10\n");
  expect(et).toContain("Kirjuta kood registreerimisel või ostukorvis lahtrisse „Sooduskood“.\nKood annab 15% soodustust sinu esimeselt koolituselt.\nKood kehtib 30 päeva.\n");
  expect(await welcome({ percent: null, amountCents: 1500, daysAfterSignup: 1 })).toContain("Kood annab 15 € soodustust sinu esimeselt koolituselt.\nKood kehtib 1 päev.\n");
  // no days on the row: no such line
  const noDays = await welcome({ daysAfterSignup: null });
  expect(noDays).toContain("Kood annab 10% soodustust");
  expect(noDays).not.toContain("Kood kehtib");
  expect(await welcome({ daysAfterSignup: 30 }, "ru")).toContain("Код даёт скидку 10% на ваш первый курс.\nКод действует 30 дней.\n");
  expect(await welcome({ daysAfterSignup: 1 }, "ru")).toContain("Код действует 1 день.");
  expect(await welcome({ daysAfterSignup: 2 }, "ru")).toContain("Код действует 2 дня.");
  expect(await welcome({ daysAfterSignup: 21 }, "ru")).toContain("Код действует 21 день.");
  expect(await welcome({ daysAfterSignup: 12 }, "ru")).toContain("Код действует 12 дней.");
  expect(await welcome({ daysAfterSignup: null }, "ru")).not.toContain("Код действует");
  // the old setting says nothing any more: its code, discount and days are not mailed
  await db.execute(sql`insert into settings (key, value) values ('newsletter', '{"welcomeCode":"VANA","discountPercent":40,"codeDays":7}') on conflict (key) do update set value = excluded.value`);
  const still = await welcome({ daysAfterSignup: 30 });
  for (const gone of ["VANA", "40%", "7 päeva"]) expect(still).not.toContain(gone);
  expect(still).toContain("TERE10");
});
