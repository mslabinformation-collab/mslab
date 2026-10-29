import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { settings } from "@/db/schema";
import type { AnswersDoc, StoredAnswer, TestPlan } from "@/domain/testplan";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { ownFaultCount, pageView, pingText, readAnswers, saveAnswers, testplanBuildAt, testplanCard, toPageAnswers } from "@/server/testplan";
import { makeTestDb } from "./helpers";

// The test page's server side (phase 4, piece 1, spec D4, D6, D10, §5): the answers are one `settings` row, merged under its lock;
// a Viga earns its Telegram texts. The plan is a small fixture (below), so these tests do not depend on the real checks. The database is PGlite.

const FIXTURE = vi.hoisted(() => {
  const item = (id: string, who: string, title: string, over: Record<string, unknown> = {}) => ({
    id, area: "avalik", who, device: "any", title, steps: ["Tee seda."], expect: ["Näed seda."], why: "Sest.", risk: "med", writes: false, ...over,
  });
  return {
    version: 1,
    marked: "2026-10-16T00:00:00.000Z",
    areas: [{ id: "avalik", name: "Avalik leht" }],
    items: [
      item("maria-1", "maria", "Avaleht telefonis"),
      item("maria-2", "maria", "Kursuse leht"),
      item("dim-1", "dim", "Maksed"),
      item("koos-1", "koos", "Ühine kirjade kontroll"),
    ],
  };
});
vi.mock("@/data/testplan.json", () => ({ default: FIXTURE }));

const PLAN = FIXTURE as unknown as TestPlan;
const MARIA = "maria@example.test";
const DIM = "dim@example.test";
/** The automatic tester (Dim 25.10): its answers are kept apart, in the doc's `auto`. */
const AUTO = "auto@example.test";
const NAMES = `${MARIA}=Maria Sosnina,${DIM}=Dim,${AUTO}=Automaattest`;
const T1 = new Date("2026-10-17T10:00:00.000Z");
const T2 = new Date("2026-10-17T10:05:00.000Z");
const T3 = new Date("2026-10-17T10:10:00.000Z");

const body = (answers: Record<string, { status: string; note?: string; clientAt?: string }>) => ({
  answers: Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, { note: "", ...a }])),
});
const doc = (answers: Record<string, StoredAnswer> = {}): AnswersDoc => ({ v: 1, answers });
const answer = (status: StoredAnswer["status"], over: Partial<StoredAnswer> = {}): StoredAnswer => ({ status, note: "", at: T1.toISOString(), by: MARIA, ...over });
/** The row as the database holds it (null: no row). */
const rowOf = async (db: Db) => (await db.select().from(settings).where(eq(settings.key, "testplan_answers")))[0]?.value ?? null;

let db: Db;
/** A fresh migrated database for each test of the describe it is called in (a PGlite start costs a second or two: the pure tests have none). */
const freshDb = () =>
  beforeEach(async () => {
    db = await makeTestDb();
  });
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const AT_LIMIT = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`id-${i}`, { status: "ok", note: "" }]));

describe("saveAnswers", () => {
  freshDb();
  test("a first save creates the row; readAnswers returns it, and `by` is the e-mail passed in, `at` the server's now", async () => {
    expect(await rowOf(db)).toBeNull();
    expect(await readAnswers(db)).toEqual(doc()); // reading creates nothing
    expect(await rowOf(db)).toBeNull();

    // (Dim 22.10: the first note on an OK is announced, so the row records it as sent)
    const saved = await saveAnswers(db, MARIA, body({ "maria-1": { status: "ok", note: "  hea  " } }), T1, NAMES);
    expect(saved).toEqual({ ok: true, doc: doc({ "maria-1": answer("ok", { note: "hea", notePinged: true }) }), pings: [{ id: "maria-1", kind: "note" }] });
    expect(await readAnswers(db)).toEqual(doc({ "maria-1": answer("ok", { note: "hea", notePinged: true }) }));
    expect(await rowOf(db)).toEqual({ v: 1, answers: { "maria-1": { status: "ok", note: "hea", at: T1.toISOString(), by: MARIA, notePinged: true } } });
  });

  test("two saves at once, of different checks, both survive", async () => {
    const [a, b] = await Promise.all([
      saveAnswers(db, MARIA, body({ "maria-1": { status: "ok" } }), T1, NAMES),
      saveAnswers(db, DIM, body({ "dim-1": { status: "skip", note: "hiljem" } }), T2, NAMES),
    ]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    const stored = await readAnswers(db);
    expect(Object.keys(stored.answers).sort()).toEqual(["dim-1", "maria-1"]);
    expect(stored.answers["maria-1"].by).toBe(MARIA);
    expect(stored.answers["dim-1"]).toMatchObject({ status: "skip", note: "hiljem", by: DIM });
  });

  test("the lock: the row is inserted if missing (on conflict do nothing), then locked (select … for update), then written, in that order", async () => {
    // PGlite has one connection, so two saves cannot overlap here and the test above proves the merge, not the lock. This reads the queries.
    const log: string[] = [];
    const logged: Db = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string) => void log.push(query) } });
    await migrate(logged, { migrationsFolder: "./drizzle" });
    log.length = 0; // the migrations are not of interest

    await saveAnswers(logged, MARIA, body({ "maria-1": { status: "bad", note: "katki" } }), T1, NAMES);
    const at = (pattern: RegExp) => log.findIndex((q) => pattern.test(q));
    const insert = at(/^insert into "settings"[\s\S]*on conflict do nothing/i);
    const lock = at(/^select [\s\S]* from "settings" [\s\S]*for update/i);
    const write = at(/^update "settings"/);
    expect({ insert: insert >= 0, lock: lock >= 0, write: write >= 0 }).toEqual({ insert: true, lock: true, write: true });
    expect(insert).toBeLessThan(lock);
    expect(lock).toBeLessThan(write);
    // a second save takes the lock on the row that is there and writes on top of it
    log.length = 0;
    await saveAnswers(logged, DIM, body({ "dim-1": { status: "ok" } }), T2, NAMES);
    expect(log.some((q) => /^select [\s\S]* from "settings" [\s\S]*for update/i.test(q))).toBe(true);
    expect(Object.keys((await readAnswers(logged)).answers).sort()).toEqual(["dim-1", "maria-1"]);
  });

  test("the insert, the lock and the write are one transaction: a write that fails leaves no row behind", async () => {
    await db.execute(sql.raw(`create function testplan_refuse() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`));
    await db.execute(sql.raw(`create trigger testplan_refuse before update on settings for each row execute function testplan_refuse()`));
    await expect(saveAnswers(db, MARIA, body({ "maria-1": { status: "ok" } }), T1, NAMES)).rejects.toThrow();
    expect(await rowOf(db)).toBeNull();
    expect(vi.mocked(console.info)).not.toHaveBeenCalled(); // and no log line for a save that did not happen
  });

  test("the same check saved twice: the second save, with the later now, wins (status, note, at, by)", async () => {
    await saveAnswers(db, MARIA, body({ "maria-1": { status: "bad", note: "katki" } }), T1, NAMES);
    await saveAnswers(db, DIM, body({ "maria-1": { status: "ok", note: "korras" } }), T2, NAMES);
    // (the OK's first note was announced: Dim 22.10)
    expect((await readAnswers(db)).answers["maria-1"]).toEqual({ status: "ok", note: "korras", at: T2.toISOString(), by: DIM, notePinged: true });
  });

  test("an id outside the plan is not stored (the rest of the save is), and answers kept for ids outside the plan are left alone", async () => {
    await db.insert(settings).values({ key: "testplan_answers", value: doc({ vana: answer("ok") }) });
    const saved = await saveAnswers(db, MARIA, body({ ghost: { status: "bad", note: "x" }, "maria-1": { status: "ok" } }), T2, NAMES);
    expect(saved.ok).toBe(true);
    const stored = await readAnswers(db);
    expect(Object.keys(stored.answers).sort()).toEqual(["maria-1", "vana"]);
    expect(saved.ok && saved.pings).toEqual([]);
  });

  test("the body: `clientAt` is ignored (the server stamps `at`), `by` is the session's, a long note is cut at 1000 characters", async () => {
    const crafted = { answers: { "maria-1": { status: "ok", note: "x".repeat(1500), clientAt: "2001-01-01T00:00:00.000Z", at: "2001-01-01T00:00:00.000Z", by: "someone@example.test" } } };
    await saveAnswers(db, DIM, crafted, T1, NAMES);
    const stored = (await readAnswers(db)).answers["maria-1"];
    expect(stored).toMatchObject({ status: "ok", at: T1.toISOString(), by: DIM });
    expect(Array.from(stored.note)).toHaveLength(1000);
  });

  test("300 ids are fine, and no answers at all is a save of nothing (the stored answers come back as they are)", async () => {
    expect((await saveAnswers(db, MARIA, { answers: AT_LIMIT }, T1, NAMES)).ok).toBe(true);
    expect(await saveAnswers(db, MARIA, { answers: {} }, T2, NAMES)).toEqual({ ok: true, doc: doc(), pings: [] });
  });

  test("the log line of a save carries counts only", async () => {
    await saveAnswers(db, MARIA, body({ "maria-1": { status: "bad", note: "hirmus saladus" }, "maria-2": { status: "ok" }, ghost: { status: "ok" } }), T1, NAMES);
    const lines = vi.mocked(console.info).mock.calls.flat().map(String);
    expect(lines).toEqual(["[testplan] saved 2 answers, 1 messages"]);
  });
});


const TOO_MANY = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`id-${i}`, { status: "ok", note: "" }]));
describe("saveAnswers: a bad body", () => {
  // one database for all of them: none may leave a row behind
  beforeAll(async () => {
    db = await makeTestDb();
  });

  test.each([
    { name: "null", value: null },
    { name: "a list", value: [] },
    { name: "text", value: "answers" },
    { name: "no answers", value: {} },
    { name: "answers a list", value: { answers: [] } },
    { name: "answers null", value: { answers: null } },
    { name: "answers text", value: { answers: "x" } },
    { name: "an answer that is null", value: { answers: { "maria-1": null } } },
    { name: "an answer that is a list", value: { answers: { "maria-1": [] } } },
    { name: "an unknown status", value: { answers: { "maria-1": { status: "maybe", note: "" } } } },
    { name: "no status", value: { answers: { "maria-1": { note: "" } } } },
    { name: "no note", value: { answers: { "maria-1": { status: "ok" } } } },
    { name: "a note that is no text", value: { answers: { "maria-1": { status: "ok", note: 5 } } } },
    { name: "one good answer and one bad: nothing is saved", value: { answers: { "maria-1": { status: "ok", note: "" }, "maria-2": { status: "nope", note: "" } } } },
    { name: "more than 300 ids", value: { answers: TOO_MANY } },
  ])("is invalid and stores nothing: $name", async ({ value }) => {
    expect(await saveAnswers(db, MARIA, value, T1, NAMES)).toEqual({ ok: false, error: "invalid" });
    expect(await rowOf(db)).toBeNull();
  });
});

describe("the Telegram sequence of a failure, through saveAnswers", () => {
  freshDb();
  const stored = async (id: string) => (await readAnswers(db)).answers[id];

  test("Viga without a note → [bad]; then a note → [note]; then another note → []", async () => {
    const first = await saveAnswers(db, MARIA, body({ "maria-1": { status: "bad" } }), T1, NAMES);
    expect(first.ok && first.pings).toEqual([{ id: "maria-1", kind: "bad" }]);
    expect(await stored("maria-1")).toEqual({ status: "bad", note: "", at: T1.toISOString(), by: MARIA, pinged: T1.toISOString() });

    const second = await saveAnswers(db, MARIA, body({ "maria-1": { status: "bad", note: "nupp ei tööta" } }), T2, NAMES);
    expect(second.ok && second.pings).toEqual([{ id: "maria-1", kind: "note" }]);
    expect(await stored("maria-1")).toEqual({ status: "bad", note: "nupp ei tööta", at: T2.toISOString(), by: MARIA, pinged: T1.toISOString(), notePinged: true });

    const third = await saveAnswers(db, MARIA, body({ "maria-1": { status: "bad", note: "nupp ei tööta telefonis" } }), T3, NAMES);
    expect(third.ok && third.pings).toEqual([]);
    expect(await stored("maria-1")).toEqual({ status: "bad", note: "nupp ei tööta telefonis", at: T3.toISOString(), by: MARIA, pinged: T1.toISOString(), notePinged: true });
  });

  test("Viga that already has a note → [bad] only (its text carries the note), then nothing more", async () => {
    const first = await saveAnswers(db, MARIA, body({ "maria-1": { status: "bad", note: "katki" } }), T1, NAMES);
    expect(first.ok && first.pings).toEqual([{ id: "maria-1", kind: "bad" }]);
    expect(await stored("maria-1")).toMatchObject({ pinged: T1.toISOString(), notePinged: true });
    const again = await saveAnswers(db, MARIA, body({ "maria-1": { status: "bad", note: "katki ikka" } }), T2, NAMES);
    expect(again.ok && again.pings).toEqual([]);
  });

  test("OK and Jäta vahele without a note send nothing; a Viga after an OK is a new failure and sends its own", async () => {
    const ok = await saveAnswers(db, MARIA, body({ "maria-1": { status: "ok" }, "maria-2": { status: "skip" } }), T1, NAMES);
    expect(ok.ok && ok.pings).toEqual([]);
    const bad = await saveAnswers(db, MARIA, body({ "maria-1": { status: "bad" } }), T2, NAMES);
    expect(bad.ok && bad.pings).toEqual([{ id: "maria-1", kind: "bad" }]);
  });

  test("the first note on an OK or a Jäta vahele is one message, once (Dim 22.10)", async () => {
    await saveAnswers(db, MARIA, body({ "maria-1": { status: "ok" }, "maria-2": { status: "skip" } }), T1, NAMES);
    const noted = await saveAnswers(db, MARIA, body({ "maria-1": { status: "ok", note: "korras" }, "maria-2": { status: "skip", note: "hiljem" } }), T2, NAMES);
    expect(noted.ok && noted.pings).toEqual([{ id: "maria-1", kind: "note" }, { id: "maria-2", kind: "note" }]);
    expect(await stored("maria-1")).toEqual({ status: "ok", note: "korras", at: T2.toISOString(), by: MARIA, notePinged: true });
    const more = await saveAnswers(db, MARIA, body({ "maria-1": { status: "ok", note: "korras, tahvlis ka" }, "maria-2": { status: "skip", note: "hiljem, kui saab" } }), T3, NAMES);
    expect(more.ok && more.pings).toEqual([]);
    expect(await stored("maria-2")).toEqual({ status: "skip", note: "hiljem, kui saab", at: T3.toISOString(), by: MARIA, notePinged: true });
  });

  test("a Viga that is taken back (OK) and comes again is a new failure and earns its first message again", async () => {
    await saveAnswers(db, MARIA, body({ "maria-1": { status: "bad", note: "katki" } }), T1, NAMES);
    await saveAnswers(db, MARIA, body({ "maria-1": { status: "ok" } }), T2, NAMES);
    const again = await saveAnswers(db, MARIA, body({ "maria-1": { status: "bad" } }), T3, NAMES);
    expect(again.ok && again.pings).toEqual([{ id: "maria-1", kind: "bad" }]);
    expect(await stored("maria-1")).toEqual({ status: "bad", note: "", at: T3.toISOString(), by: MARIA, pinged: T3.toISOString() });
  });
});

describe("pingText", () => {
  const BASE = "https://mslab.ee";
  const bad = (note: string, by = MARIA) => doc({ "maria-1": answer("bad", { note, by }) });

  test("tg.bad: the check's title, the answerer's first name, the note and the link to the check", () => {
    expect(pingText({ id: "maria-1", kind: "bad" }, PLAN, bad("nupp ei tööta"), NAMES, BASE)).toBe(
      "Testimine — Viga: Avaleht telefonis (Maria)\nnupp ei tööta\nhttps://mslab.ee/admin/testimine#maria-1",
    );
  });

  test("tg.bad without a note says so (tg.noNote)", () => {
    const text = pingText({ id: "maria-1", kind: "bad" }, PLAN, bad(""), NAMES, BASE);
    expect(text).toBe(fill(adminEt.testplan.tg.bad, { title: "Avaleht telefonis", name: "Maria", note: adminEt.testplan.tg.noNote, url: "https://mslab.ee/admin/testimine#maria-1" }));
    expect(text).toContain("(märkust veel pole)");
  });

  test("tg.bad for a Viga that carries the answer before it's note (oldNote): that note is not the failure's, so tg.noNote", () => {
    expect(pingText({ id: "maria-1", kind: "bad", oldNote: true }, PLAN, bad("Tahvlis korras"), NAMES, BASE)).toBe(
      "Testimine — Viga: Avaleht telefonis (Maria)\n(märkust veel pole)\nhttps://mslab.ee/admin/testimine#maria-1",
    );
  });

  test("tg.note: the first note of a failure, with the answer shown", () => {
    expect(pingText({ id: "maria-1", kind: "note" }, PLAN, bad("nupp ei tööta"), NAMES, BASE)).toBe(
      "Testimine — Märkus: Avaleht telefonis (Maria) · Viga\nnupp ei tööta\nhttps://mslab.ee/admin/testimine#maria-1",
    );
  });

  test("tg.note: the first note of an OK and of a Jäta vahele, in the same format, the answer in the button's words (Dim 22.10)", () => {
    const stored = (status: StoredAnswer["status"], note: string) => doc({ "maria-1": answer(status, { note }) });
    // (admin UX pass piece 4c, R-i: an `ok` is the button „Läbitud“ now, S4-45, and its first note says so)
    expect(pingText({ id: "maria-1", kind: "note" }, PLAN, stored("ok", "Telefonis korras"), NAMES, BASE)).toBe(
      "Testimine — Märkus: Avaleht telefonis (Maria) · Läbitud\nTelefonis korras\nhttps://mslab.ee/admin/testimine#maria-1",
    );
    // (a `skip` stored before the button went, piece 4c: the data stays, and its first note still names it)
    expect(pingText({ id: "maria-1", kind: "note" }, PLAN, stored("skip", "Hiljem"), NAMES, BASE)).toBe(
      "Testimine — Märkus: Avaleht telefonis (Maria) · Jäta vahele\nHiljem\nhttps://mslab.ee/admin/testimine#maria-1",
    );
  });

  test("tg.note for an id the doc does not hold has no answer to show (and no dangling separator)", () => {
    expect(pingText({ id: "ghost", kind: "note" }, PLAN, doc(), NAMES, BASE)).toBe("Testimine — Märkus: ghost (admin)\n(märkust veel pole)\nhttps://mslab.ee/admin/testimine#ghost");
  });

  test("the note is cut at its first 300 code points (an emoji is one), and a shorter note is whole", () => {
    const long = `${"a".repeat(299)}😀${"b".repeat(50)}`;
    const text = pingText({ id: "maria-1", kind: "note" }, PLAN, bad(long), NAMES, BASE);
    expect(text).toContain(`${"a".repeat(299)}😀\n`);
    expect(text).not.toContain("bbb");
    expect(pingText({ id: "maria-1", kind: "note" }, PLAN, bad("a".repeat(300)), NAMES, BASE)).toContain(`${"a".repeat(300)}\n`);
  });

  test("the name is the first word of the answerer's name in ADMIN_NAMES; without one, \"admin\"; the e-mail address is never in the text", () => {
    expect(pingText({ id: "maria-1", kind: "bad" }, PLAN, bad("x", DIM), NAMES, BASE)).toContain("(Dim)");
    for (const names of [undefined, "", "other@example.test=Kati"]) {
      const text = pingText({ id: "maria-1", kind: "bad" }, PLAN, bad("x"), names, BASE);
      expect(text).toContain("(admin)");
      expect(text).not.toContain("@");
    }
    expect(pingText({ id: "maria-1", kind: "bad" }, PLAN, bad("x"), NAMES, BASE)).not.toContain("@");
  });

  test("a ping for an id the plan or the doc does not hold still makes a text (the id as the title, no note)", () => {
    expect(pingText({ id: "ghost", kind: "bad" }, PLAN, doc(), NAMES, BASE)).toBe("Testimine — Viga: ghost (admin)\n(märkust veel pole)\nhttps://mslab.ee/admin/testimine#ghost");
  });
});

describe("toPageAnswers", () => {
  test("never carries `by`; gives `byName` (the first name) for the configured address, \"admin\" for any other", () => {
    const stored = doc({
      "maria-1": answer("ok", { by: MARIA, note: "hea" }),
      "dim-1": answer("bad", { by: "stranger@example.test", pinged: T1.toISOString(), notePinged: true }),
    });
    const page = toPageAnswers(stored, PLAN, NAMES);
    expect(page).toEqual({
      "maria-1": { status: "ok", note: "hea", at: T1.toISOString(), byName: "Maria" },
      "dim-1": { status: "bad", note: "", at: T1.toISOString(), byName: "admin" },
    });
    const wire = JSON.stringify(page);
    expect(wire).not.toContain("@");
    expect(wire).not.toContain("pinged");
    expect(wire).not.toContain('"by"');
  });

  test("plan ids only: an answer kept for an id the plan no longer has is not sent", () => {
    const page = toPageAnswers(doc({ vana: answer("ok"), "maria-1": answer("ok") }), PLAN, NAMES);
    expect(Object.keys(page)).toEqual(["maria-1"]);
  });

  test("an id that is a member of Object.prototype is no answer", () => {
    const plan: TestPlan = { ...PLAN, items: [{ ...PLAN.items[0], id: "constructor" }] };
    expect(toPageAnswers(doc(), plan, NAMES)).toEqual({});
    expect(Object.keys(toPageAnswers(doc({ constructor: answer("ok") }), plan, NAMES))).toEqual(["constructor"]);
  });
});

describe("testplanCard", () => {
  freshDb();
  const save = (email: string, answers: Record<string, { status: string }>, now = T1) => saveAnswers(db, email, body(answers), now, NAMES);

  test("for Maria it counts her checks and the shared ones; Dim's are not hers", async () => {
    expect(await testplanCard(db, MARIA, NAMES)).toEqual({ open: 3, bad: 0 }); // maria-1, maria-2, koos-1
    await save(MARIA, { "maria-1": { status: "ok" }, "dim-1": { status: "bad" } });
    expect(await testplanCard(db, MARIA, NAMES)).toEqual({ open: 2, bad: 0 }); // dim-1's Viga is Dim's
    await save(MARIA, { "koos-1": { status: "bad" } }, T2);
    expect(await testplanCard(db, MARIA, NAMES)).toEqual({ open: 1, bad: 1 });
  });

  test("for Dim it counts his checks and the shared ones", async () => {
    expect(await testplanCard(db, DIM, NAMES)).toEqual({ open: 2, bad: 0 }); // dim-1, koos-1
    await save(DIM, { "dim-1": { status: "bad" } });
    expect(await testplanCard(db, DIM, NAMES)).toEqual({ open: 1, bad: 1 });
  });

  test("null when every counted check is done (OK); a stored Jäta vahele is open (piece 4c, Dim 29.10); a standing Viga keeps the card", async () => {
    await save(MARIA, { "maria-1": { status: "ok" }, "maria-2": { status: "skip" }, "koos-1": { status: "ok" } });
    expect(await testplanCard(db, MARIA, NAMES)).toEqual({ open: 1, bad: 0 }); // (maria-2's skip)
    await save(MARIA, { "maria-2": { status: "ok" } });
    expect(await testplanCard(db, MARIA, NAMES)).toBeNull();
    // Dim's own check is still open for him
    expect(await testplanCard(db, DIM, NAMES)).toEqual({ open: 1, bad: 0 });
    await save(MARIA, { "koos-1": { status: "bad" } }, T2);
    expect(await testplanCard(db, MARIA, NAMES)).toEqual({ open: 0, bad: 1 });
  });

  test("an admin with no tester match counts all of the plan", async () => {
    expect(await testplanCard(db, "other@example.test", NAMES)).toEqual({ open: 4, bad: 0 });
    expect(await testplanCard(db, MARIA, undefined)).toEqual({ open: 4, bad: 0 });
    await save(MARIA, { "dim-1": { status: "bad" } });
    expect(await testplanCard(db, "other@example.test", NAMES)).toEqual({ open: 3, bad: 1 });
  });
});

// Dim 25.10: a third tester, „Automaattest“, whose answers stay apart from Maria's and Dim's: the same row, its own map `auto`.
describe("Automaattest's answers stay apart (Dim 25.10)", () => {
  freshDb();

  test("a save as Automaattest, then as Maria, on the same check keeps both, each in its own map; and Automaattest again leaves hers", async () => {
    const auto = await saveAnswers(db, AUTO, body({ "maria-1": { status: "bad", note: "nupp puudub" } }), T1, NAMES);
    expect(auto.ok && auto.pings).toEqual([{ id: "maria-1", kind: "bad", auto: true }]);
    const maria = await saveAnswers(db, MARIA, body({ "maria-1": { status: "ok" } }), T2, NAMES);
    expect(maria.ok && maria.pings).toEqual([]);
    expect(await rowOf(db)).toEqual({
      v: 1,
      answers: { "maria-1": { status: "ok", note: "", at: T2.toISOString(), by: MARIA } },
      auto: { "maria-1": { status: "bad", note: "nupp puudub", at: T1.toISOString(), by: AUTO, pinged: T1.toISOString(), notePinged: true } },
    });
    await saveAnswers(db, AUTO, body({ "maria-1": { status: "ok" } }), T3, NAMES);
    const stored = await readAnswers(db);
    expect(stored.answers).toEqual({ "maria-1": { status: "ok", note: "", at: T2.toISOString(), by: MARIA } });
    expect(stored.auto).toEqual({ "maria-1": { status: "ok", note: "", at: T3.toISOString(), by: AUTO } });
  });

  test("an old row without `auto` reads as before, and a save by Maria or Dim writes no `auto` into it", async () => {
    await db.insert(settings).values({ key: "testplan_answers", value: { v: 1, answers: { "maria-1": { status: "ok", note: "hea", at: T1.toISOString(), by: MARIA } } } });
    expect(await readAnswers(db)).toEqual(doc({ "maria-1": answer("ok", { note: "hea" }) }));
    await saveAnswers(db, DIM, body({ "dim-1": { status: "skip" } }), T2, NAMES);
    expect(Object.keys((await rowOf(db)) as object)).toEqual(["v", "answers"]);
    expect(Object.keys((await readAnswers(db)).answers).sort()).toEqual(["dim-1", "maria-1"]);
  });

  test("Maria's and Dim's Ülevaade cards and menu badges are the same with Automaattest's answers as without; its own card counts its answers over the plan", async () => {
    await saveAnswers(db, MARIA, body({ "maria-1": { status: "ok" }, "koos-1": { status: "bad" } }), T1, NAMES);
    const before = [await testplanCard(db, MARIA, NAMES), await testplanCard(db, DIM, NAMES), await ownFaultCount(db, MARIA), await ownFaultCount(db, DIM)];
    expect(before).toEqual([{ open: 1, bad: 1 }, { open: 1, bad: 1 }, 1, 0]);
    await saveAnswers(db, AUTO, body({ "maria-1": { status: "bad" }, "maria-2": { status: "ok" }, "dim-1": { status: "bad" }, "koos-1": { status: "ok" } }), T2, NAMES);
    expect([await testplanCard(db, MARIA, NAMES), await testplanCard(db, DIM, NAMES), await ownFaultCount(db, MARIA), await ownFaultCount(db, DIM)]).toEqual(before);
    expect(await testplanCard(db, AUTO, NAMES)).toEqual({ open: 0, bad: 2 });
    expect(await ownFaultCount(db, AUTO)).toBe(2);
  });

  test("its OK or Jäta vahele sends nothing, even with a note; its Viga's first note is the second message, once", async () => {
    const quiet = await saveAnswers(db, AUTO, body({ "maria-1": { status: "ok", note: "korras" }, "maria-2": { status: "skip", note: "hiljem" } }), T1, NAMES);
    expect(quiet.ok && quiet.pings).toEqual([]);
    expect(await saveAnswers(db, AUTO, body({ "dim-1": { status: "bad" } }), T1, NAMES)).toMatchObject({ pings: [{ id: "dim-1", kind: "bad", auto: true }] });
    expect(await saveAnswers(db, AUTO, body({ "dim-1": { status: "bad", note: "makse jäi ootele" } }), T2, NAMES)).toMatchObject({ pings: [{ id: "dim-1", kind: "note", auto: true }] });
    expect(await saveAnswers(db, AUTO, body({ "dim-1": { status: "bad", note: "makse jäi ootele, ka teisel korral" } }), T3, NAMES)).toMatchObject({ pings: [] });
  });

  test("pingText names Automaattest and reads its answer from `auto`, never Maria's on the same check", () => {
    const both: AnswersDoc = {
      v: 1,
      answers: { "maria-1": answer("ok", { note: "Maria märkus" }) },
      auto: { "maria-1": answer("bad", { note: "nupp puudub", by: AUTO }) },
    };
    expect(pingText({ id: "maria-1", kind: "bad", auto: true }, PLAN, both, NAMES, "https://mslab.ee")).toBe(
      "Testimine — Viga: Avaleht telefonis (Automaattest)\nnupp puudub\nhttps://mslab.ee/admin/testimine#maria-1",
    );
    expect(pingText({ id: "maria-1", kind: "note", auto: true }, PLAN, both, NAMES, "https://mslab.ee")).toBe(
      "Testimine — Märkus: Avaleht telefonis (Automaattest) · Viga\nnupp puudub\nhttps://mslab.ee/admin/testimine#maria-1",
    );
  });

  test("pageView: Maria, Dim and any other admin get the shared answers, with Automaattest's apart in `auto`; Automaattest gets its own as its answers", () => {
    const both: AnswersDoc = {
      v: 1,
      answers: { "maria-1": answer("ok", { note: "hea" }) },
      auto: { "maria-1": answer("bad", { note: "nupp puudub", by: AUTO }), vana: answer("ok", { by: AUTO }) },
    };
    const shared = { "maria-1": { status: "ok", note: "hea", at: T1.toISOString(), byName: "Maria" } };
    const auto = { "maria-1": { status: "bad", note: "nupp puudub", at: T1.toISOString(), byName: "Automaattest" } };
    for (const tester of ["maria", "dim", null] as const) expect(pageView(both, PLAN, NAMES, tester), String(tester)).toEqual({ answers: shared, auto });
    expect(pageView(both, PLAN, NAMES, "auto")).toEqual({ answers: auto, auto });
    expect(pageView(doc(), PLAN, NAMES, "maria")).toEqual({ answers: {}, auto: {} });
    expect(JSON.stringify(pageView(both, PLAN, NAMES, "maria"))).not.toContain("@");
  });
});

describe("testplanBuildAt", () => {
  test("the build instant next.config inlines (TESTPLAN_BUILD_AT); the epoch where it is not set (the tests)", () => {
    vi.stubEnv("TESTPLAN_BUILD_AT", "2026-10-22T08:00:00.000Z");
    expect(testplanBuildAt()).toBe("2026-10-22T08:00:00.000Z");
    vi.unstubAllEnvs();
    delete process.env.TESTPLAN_BUILD_AT;
    expect(testplanBuildAt()).toBe("1970-01-01T00:00:00.000Z");
  });
});
