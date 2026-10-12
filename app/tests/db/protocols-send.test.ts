import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clientLoginTokens, clients, courses, protocols, registrations } from "@/db/schema";
import type { Env } from "@/server/notify";
import { saveProtocol, sendProtocol, sendProtocols, type SendDeps } from "@/server/protocols";
import { fakeKv, stubFetch } from "../fakes";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// "Saada" (spec §4, §6, §8, D3, D4; §10 DB): the send freezes the snapshot and a later edit leaves it; it creates the account and links the
// registration; the mail goes after the commit with a login that opens the protocol; re-send; and every refusal. The race of two sends at
// once runs on real Postgres (tests/e2e/protocols-race.spec.ts).

const SITE = "https://mslab.example";
const DAY_END = new Date("2026-10-12T15:00:00Z");
let db: Db;
let resend: ReturnType<typeof stubFetch>;
beforeEach(async () => {
  db = await makeTestDb();
  resend = stubFetch((url) => (url.includes("resend") ? Response.json({ id: "email_1" }) : Response.json({})));
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const env = (): Env => ({ KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test" });
function deps(now = DAY_END) {
  const tasks: (() => Promise<unknown>)[] = [];
  const d: SendDeps = { db, env: env(), siteUrl: SITE, now, later: (task) => void tasks.push(task) };
  return { d, queued: () => tasks.length, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
}
type SentMail = { to: string; subject: string; text: string; html: string };
const mails = () => resend.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as SentMail);
const write = (registrationId: number, version: number, note: string, generalNote = "Tubli töö") =>
  saveProtocol(db, { registrationId, version, titles: HEADINGS, notes: [note, "", "", ""], generalNote }, new Date("2026-10-12T09:00:00Z"));
const stored = async (registrationId: number) => (await db.select().from(protocols).where(eq(protocols.registrationId, registrationId)))[0];
const registration = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0];

async function setup() {
  const { course, session } = await protocolCourse(db);
  return { course, session, mari: await student(db, course, session, "Mari Maasikas") };
}

describe("sendProtocol", () => {
  test("the first send freezes the text, creates her account and links the registration; the mail goes after the commit, with a login that opens it", async () => {
    const { mari } = await setup();
    await write(mari.id, 0, "Kulmud said ühtlased");
    const { d, queued, flush } = deps();
    expect(await sendProtocol(d, { registrationId: mari.id, version: 1 })).toEqual({ kind: "sent", again: false, version: 1, sentAt: DAY_END.toISOString() });
    expect(await stored(mari.id)).toMatchObject({
      version: 1,
      sentAt: DAY_END,
      sentVersion: 1,
      sent: { stages: HEADINGS.map((title, i) => ({ title, note: i === 0 ? "Kulmud said ühtlased" : "" })), generalNote: "Tubli töö" },
    });
    const [account] = await db.select().from(clients);
    expect(account).toMatchObject({ email: "marimaasikas@example.com", locale: "et" });
    expect((await registration(mari.id)).clientId).toBe(account.id);
    // nothing is mailed inside the transaction: the mail is queued, and goes when the work after the answer runs
    expect(mails()).toEqual([]);
    expect(queued()).toBe(1);
    await flush();
    const [mail] = mails();
    expect([mail.to, mail.subject]).toEqual(["marimaasikas@example.com", "Sinu koolituse protokoll on valmis"]);
    expect(mail.text).toContain(`${SITE}/api/konto/verify?t=`);
    expect(mail.text).toContain(`&p=${mari.id}`);
    expect(mail.text).toContain(`${SITE}/konto/tagasiside#id=${mari.id}`);
    // the notes are never in a mail
    for (const body of [mail.text, mail.html]) for (const note of ["Kulmud said ühtlased", "Tubli töö"]) expect(body).not.toContain(note);
    expect(await db.select({ email: clientLoginTokens.email }).from(clientLoginTokens)).toEqual([{ email: "marimaasikas@example.com" }]);
  });

  test("the same version sent again (a second tap, another device) does nothing: already, no second mail", async () => {
    const { mari } = await setup();
    await write(mari.id, 0, "A");
    await sendProtocol(deps().d, { registrationId: mari.id, version: 1 });
    const again = deps(new Date("2026-10-12T15:01:00Z"));
    expect(await sendProtocol(again.d, { registrationId: mari.id, version: 1 })).toEqual({ kind: "already", version: 1, sentAt: DAY_END.toISOString() });
    expect(again.queued()).toBe(0);
    expect((await stored(mari.id)).sentAt).toEqual(DAY_END);
  });

  test("an edit after the send leaves the sent copy; 'Saada uuesti' freezes the new text and mails 'uuendatud' without the feedback line (D4)", async () => {
    const { mari } = await setup();
    await write(mari.id, 0, "Esimene");
    await sendProtocol(deps().d, { registrationId: mari.id, version: 1 });
    await write(mari.id, 1, "Esimene. Teine");
    expect(await stored(mari.id)).toMatchObject({ version: 2, sentVersion: 1, sent: { stages: expect.arrayContaining([{ title: "Ettevalmistus", note: "Esimene" }]) } });
    const later = new Date("2026-10-12T16:00:00Z");
    const { d, flush } = deps(later);
    expect(await sendProtocol(d, { registrationId: mari.id, version: 2 })).toEqual({ kind: "sent", again: true, version: 2, sentAt: later.toISOString() });
    expect(await stored(mari.id)).toMatchObject({ sentVersion: 2, sentAt: later, sent: { stages: expect.arrayContaining([{ title: "Ettevalmistus", note: "Esimene. Teine" }]) } });
    await flush();
    const [mail] = mails();
    expect(mail.subject).toBe("Sinu koolituse protokolli on uuendatud");
    expect(mail.text).not.toContain("tagasiside");
    expect(await db.select().from(clients)).toHaveLength(1); // the account made by the first send
  });

  test("the version the screen showed must be the stored one: stale, nothing changes", async () => {
    const { mari } = await setup();
    await write(mari.id, 0, "A");
    await write(mari.id, 1, "AB"); // another device saved meanwhile
    const { d, queued } = deps();
    expect(await sendProtocol(d, { registrationId: mari.id, version: 1 })).toEqual({ kind: "stale", version: 2 });
    expect([(await stored(mari.id)).sentAt, queued(), (await db.select().from(clients)).length]).toEqual([null, 0, 0]);
  });

  test("nothing written is empty and never sent: no protocol yet, or only blank text", async () => {
    const { course, session, mari } = await setup();
    expect(await sendProtocol(deps().d, { registrationId: mari.id, version: 1 })).toEqual({ kind: "empty" });
    const anu = await student(db, course, session, "Anu Aas");
    await write(anu.id, 0, "   ", " \n ");
    expect(await sendProtocol(deps().d, { registrationId: anu.id, version: 1 })).toEqual({ kind: "empty" });
    expect(await db.select().from(clients)).toEqual([]);
  });

  test("Review Focus 3: a registration cancelled before the send is never sent: no account, no mail", async () => {
    const { mari } = await setup();
    await write(mari.id, 0, "A");
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, mari.id));
    const { d, queued } = deps();
    expect(await sendProtocol(d, { registrationId: mari.id, version: 1 })).toEqual({ kind: "cancelled" });
    expect([(await stored(mari.id)).sentAt, queued(), (await db.select().from(clients)).length]).toEqual([null, 0, 0]);
  });

  test("she has an account already: the registration is linked to it, no second one; a linked registration stays as it is", async () => {
    const { course, session, mari } = await setup();
    const [own] = await db.insert(clients).values({ email: "marimaasikas@example.com", locale: "ru" }).returning();
    await write(mari.id, 0, "A");
    await sendProtocol(deps().d, { registrationId: mari.id, version: 1 });
    expect(await db.select({ id: clients.id }).from(clients)).toEqual([{ id: own.id }]);
    expect((await registration(mari.id)).clientId).toBe(own.id);
    const [other] = await db.insert(clients).values({ email: "teine@example.com" }).returning();
    const linked = await student(db, course, session, "Liis Lepp", { clientId: other.id });
    await write(linked.id, 0, "B");
    await sendProtocol(deps().d, { registrationId: linked.id, version: 1 });
    expect((await registration(linked.id)).clientId).toBe(other.id);
    expect(await db.select().from(clients)).toHaveLength(2);
  });

  test("a sample address is never mailed; the protocol is sent all the same", async () => {
    const { course, session } = await setup();
    const sample = await student(db, course, session, "Proov Naidis", { email: "proov.naidis@example.test" });
    await write(sample.id, 0, "A");
    const { d, flush } = deps();
    expect(await sendProtocol(d, { registrationId: sample.id, version: 1 })).toMatchObject({ kind: "sent" });
    await flush();
    expect(mails()).toEqual([]);
    expect(await db.select().from(clientLoginTokens)).toEqual([]);
  });

  test("a mail that fails never undoes the send", async () => {
    const { mari } = await setup();
    resend = stubFetch(() => new Response("down", { status: 500 }));
    await write(mari.id, 0, "A");
    const { d, flush } = deps();
    expect(await sendProtocol(d, { registrationId: mari.id, version: 1 })).toMatchObject({ kind: "sent" });
    await expect(flush()).resolves.toBeDefined();
    expect((await stored(mari.id)).sentVersion).toBe(1);
  });

  test("Review Focus 5: a Russian registration gets the Russian mail and the Russian pages", async () => {
    const { course, session } = await setup();
    const olga = await student(db, course, session, "Olga Ivanova", { locale: "ru" });
    await write(olga.id, 0, "Хорошо");
    const { d, flush } = deps();
    await sendProtocol(d, { registrationId: olga.id, version: 1 });
    await flush();
    const [mail] = mails();
    expect(mail.subject).toBe("Протокол вашего обучения готов");
    expect(mail.text).toContain("&l=ru");
    expect(mail.text).toContain(`${SITE}/ru/konto/tagasiside#id=${olga.id}`);
  });

  test("an e-course's registration, or none: notFound", async () => {
    const [ecourse] = await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" }, price: 9000 }).returning();
    const buyer = await student(db, ecourse, null, "Eva");
    expect(await sendProtocol(deps().d, { registrationId: buyer.id, version: 1 })).toEqual({ kind: "notFound" });
    expect(await sendProtocol(deps().d, { registrationId: 999_999, version: 1 })).toEqual({ kind: "notFound" });
  });
});

describe("sendProtocols ('Lukusta ja saada kõik')", () => {
  test("each one in its own transaction, in order; a refusal or a failure does not stop the others, and is reported by its id", async () => {
    const { course, session, mari } = await setup();
    const anu = await student(db, course, session, "Anu Aas");
    const eve = await student(db, course, session, "Eve Kask");
    await write(mari.id, 0, "Mari");
    await write(anu.id, 0, "Anu");
    await write(eve.id, 0, "Eve");
    const { d, queued } = deps();
    // the second student's transaction fails (a dropped connection, say)
    const target = db as unknown as { transaction: (fn: unknown) => Promise<unknown> };
    const real = target.transaction.bind(db);
    let n = 0;
    vi.spyOn(target, "transaction").mockImplementation((fn) => (++n === 2 ? Promise.reject(new Error("connection lost")) : real(fn)));
    const results = await sendProtocols(d, [
      { registrationId: mari.id, version: 1 },
      { registrationId: anu.id, version: 1 },
      { registrationId: 999_999, version: 1 },
      { registrationId: eve.id, version: 1 },
    ]);
    expect(results.map((r) => [r.registrationId, r.result.kind])).toEqual([[mari.id, "sent"], [anu.id, "failed"], [999_999, "notFound"], [eve.id, "sent"]]);
    expect(queued()).toBe(2);
    expect((await stored(anu.id)).sentAt).toBeNull();
  });
});
