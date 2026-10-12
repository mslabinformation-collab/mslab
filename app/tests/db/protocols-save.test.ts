import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courses, protocols, registrations } from "@/db/schema";
import { PROTOCOL_LIMITS } from "@/domain/protocols";
import { handleSave, MAX_SAVE_CHARS, saveBody, saveProtocol, type SaveInput } from "@/server/protocols";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// The autosave (spec §3, §4, §10 DB): the first save creates the protocol with the course's headings; every saved change raises the version;
// a save from an older version is refused with what is stored, so newer text is never overwritten; a save that changes nothing raises
// nothing. And the route's answers (app/api/admin/protokoll: withAdmin around handleSave).

const NOW = new Date("2026-10-12T08:00:00Z");
const LATER = new Date("2026-10-12T08:05:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The notes under the four headings: the given ones first, the rest empty. */
const notes = (...given: string[]) => [...given, ...Array<string>(HEADINGS.length - given.length).fill("")];
const save = (registrationId: number, version: number, over: Partial<SaveInput> = {}, at = NOW) =>
  saveProtocol(db, { registrationId, version, titles: HEADINGS, notes: notes(), generalNote: "", ...over }, at);
const stored = async (registrationId: number) => (await db.select().from(protocols).where(eq(protocols.registrationId, registrationId)))[0];

async function setup() {
  const { course, session } = await protocolCourse(db);
  return { course, session, mari: await student(db, course, session, "Mari Maasikas") };
}

describe("saveProtocol", () => {
  test("the first save creates the protocol with the course's headings as they are now, version 1", async () => {
    const { mari } = await setup();
    expect(await save(mari.id, 0, { notes: notes("Kulmud ühtlased") })).toEqual({ kind: "saved", version: 1, savedAt: NOW });
    expect(await stored(mari.id)).toMatchObject({
      version: 1,
      stages: [{ title: "Ettevalmistus", note: "Kulmud ühtlased" }, { title: "Kulmude analüüs", note: "" }, { title: "Vormi määramine", note: "" }, { title: "Värvimine", note: "" }],
      generalNote: "",
      sent: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  test("each saved change raises the version; a save that changes nothing raises nothing (a look, a 'Muuda' without an edit)", async () => {
    const { mari } = await setup();
    await save(mari.id, 0, { notes: notes("A") });
    expect(await save(mari.id, 1, { notes: notes("AB") }, LATER)).toEqual({ kind: "saved", version: 2, savedAt: LATER });
    expect(await save(mari.id, 2, { notes: notes("AB"), generalNote: "Üldiselt hästi" })).toMatchObject({ kind: "saved", version: 3 });
    expect(await save(mari.id, 3, { notes: notes("AB"), generalNote: "Üldiselt hästi" }, new Date("2026-10-12T09:00:00Z"))).toEqual({ kind: "saved", version: 3, savedAt: NOW });
    expect((await stored(mari.id)).version).toBe(3);
  });

  test("Review Focus 2: a save from an older version is refused with what is stored; nothing is overwritten", async () => {
    const { mari } = await setup();
    await save(mari.id, 0, { notes: notes("tahvel") }); // the tablet
    await save(mari.id, 1, { notes: notes("tahvel, uuem") }, LATER); // the tablet again
    const phone = await save(mari.id, 1, { notes: notes("telefon") }); // the phone still has version 1
    expect(phone).toMatchObject({ kind: "conflict", protocol: { version: 2, generalNote: "", sentVersion: null, sentAt: null, updatedAt: LATER } });
    expect(phone.kind === "conflict" && phone.protocol.stages[0]).toEqual({ title: "Ettevalmistus", note: "tahvel, uuem" });
    expect((await stored(mari.id)).stages[0].note).toBe("tahvel, uuem");
    // a second first save (the phone did not see the tablet create it) is refused the same way
    expect(await save(mari.id, 0, { notes: notes("telefon") })).toMatchObject({ kind: "conflict", protocol: { version: 2 } });
  });

  test("Review Focus 1: a save whose answer was lost, sent again as it was, is answered with the version that holds it (no conflict)", async () => {
    const { course, mari } = await setup();
    await save(mari.id, 0, { notes: notes("A") });
    await save(mari.id, 1, { notes: notes("AB") }, LATER); // stored as 2, but the answer never reached the tablet
    expect(await save(mari.id, 1, { notes: notes("AB") })).toEqual({ kind: "saved", version: 2, savedAt: LATER });
    // the same for a first save whose answer was lost
    const anu = await student(db, course, null, "Anu Aas");
    await save(anu.id, 0, { notes: notes("Esimene") });
    expect(await save(anu.id, 0, { notes: notes("Esimene") })).toEqual({ kind: "saved", version: 1, savedAt: NOW });
  });

  test("a first save made for headings the course no longer has is refused with the headings now; a created protocol keeps its own (spec §9)", async () => {
    const { course, session, mari } = await setup();
    await save(mari.id, 0, { notes: notes("Mari") });
    await db.update(courses).set({ protocolStages: ["Uus punkt"] }).where(eq(courses.id, course.id));
    const anu = await student(db, course, session, "Anu Aas");
    expect(await save(anu.id, 0, { notes: notes("Anu") })).toEqual({
      kind: "conflict",
      protocol: { version: 0, stages: [{ title: "Uus punkt", note: "" }], generalNote: "", sentVersion: null, sentAt: null, updatedAt: null },
    });
    expect(await stored(anu.id)).toBeUndefined();
    expect(await save(anu.id, 0, { titles: ["Uus punkt"], notes: ["Anu"] })).toMatchObject({ kind: "saved", version: 1 });
    // Mari's protocol keeps its four headings and is saved with them
    expect(await save(mari.id, 1, { notes: notes("Mari, edasi") })).toMatchObject({ kind: "saved", version: 2 });
    expect((await stored(mari.id)).stages.map((s) => s.title)).toEqual(HEADINGS);
    // headings that are not the protocol's own: refused
    expect(await save(mari.id, 2, { titles: ["Uus punkt"], notes: ["x"] })).toMatchObject({ kind: "conflict", protocol: { version: 2 } });
  });

  test("Review Focus 3: a registration cancelled while the screen is open still saves: nothing typed is lost", async () => {
    const { mari } = await setup();
    await save(mari.id, 0, { notes: notes("Hommikul") });
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, mari.id));
    expect(await save(mari.id, 1, { notes: notes("Hommikul. Lõunal") })).toMatchObject({ kind: "saved", version: 2 });
  });

  test("two saves at the same moment: one is stored, the other reads again and is answered from what is stored (nothing overwritten, no error)", async () => {
    const { mari } = await setup();
    // a first save sent twice at once (a double tap; a retry overtaking its first try): one row, and both are answered with version 1
    expect(await Promise.all([save(mari.id, 0, { notes: notes("A") }), save(mari.id, 0, { notes: notes("A") })])).toEqual([
      { kind: "saved", version: 1, savedAt: NOW },
      { kind: "saved", version: 1, savedAt: NOW },
    ]);
    expect(await db.select().from(protocols).where(eq(protocols.registrationId, mari.id))).toHaveLength(1);
    // two devices saving from version 1 at once: one wins, the other is refused with the winner's text
    const [tablet, phone] = await Promise.all([save(mari.id, 1, { notes: notes("tahvel") }), save(mari.id, 1, { notes: notes("telefon") })]);
    expect(tablet).toMatchObject({ kind: "saved", version: 2 });
    expect(phone).toMatchObject({ kind: "conflict", protocol: { version: 2 } });
    expect(phone.kind === "conflict" && phone.protocol.stages[0].note).toBe("tahvel");
    expect(await stored(mari.id)).toMatchObject({ version: 2, stages: [{ title: "Ettevalmistus", note: "tahvel" }, {}, {}, {}] });
  });

  test("an e-course's registration, or none: notFound", async () => {
    const [ecourse] = await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" }, price: 9000 }).returning();
    const buyer = await student(db, ecourse, null, "Eva");
    expect(await save(buyer.id, 0, { titles: [], notes: [] })).toEqual({ kind: "notFound" });
    expect(await save(999_999, 0)).toEqual({ kind: "notFound" });
  });
});

describe("POST /api/admin/protokoll (handleSave)", () => {
  const post = (body: unknown) =>
    handleSave(db, new Request("https://mslab.example/api/admin/protokoll", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), NOW);
  const answer = async (res: Response) => [res.status, await res.json(), res.headers.get("cache-control")];
  const body = (registrationId: number, version: number, over: Record<string, unknown> = {}) => ({ registrationId, version, titles: HEADINGS, notes: notes("Hea"), generalNote: "", ...over });

  test("200 with the new version and when it was saved; never kept by a cache", async () => {
    const { mari } = await setup();
    expect(await answer(await post(body(mari.id, 0)))).toEqual([200, { ok: true, version: 1, savedAt: NOW.toISOString() }, "no-store"]);
  });

  test("409 with the stored protocol, its dates as text; 404 for a registration that is not there", async () => {
    const { mari } = await setup();
    await post(body(mari.id, 0));
    const [status, json] = await answer(await post(body(mari.id, 0, { notes: notes("teine seade") })));
    expect([status, json]).toEqual([
      409,
      { ok: false, error: "conflict", protocol: { version: 1, stages: HEADINGS.map((title, i) => ({ title, note: i === 0 ? "Hea" : "" })), generalNote: "", sentVersion: null, sentAt: null, updatedAt: NOW.toISOString() } },
    ]);
    expect(await answer(await post(body(999_999, 0)))).toEqual([404, { ok: false, error: "notFound" }, "no-store"]);
  });

  test("Review Focus 4: a box over 10 000 characters is refused with its place, so is text Postgres cannot store; nothing is stored", async () => {
    const { mari } = await setup();
    const long = "ä".repeat(PROTOCOL_LIMITS.note + 1);
    expect(await answer(await post(body(mari.id, 0, { notes: notes("ok", long), generalNote: long })))).toEqual([400, { ok: false, error: "tooLong", places: [1, "general"] }, "no-store"]);
    expect(await answer(await post(body(mari.id, 0, { generalNote: "nul\u0000" })))).toEqual([400, { ok: false, error: "text" }, "no-store"]);
    expect(await stored(mari.id)).toBeUndefined();
    expect((await post(body(mari.id, 0, { notes: notes("x".repeat(PROTOCOL_LIMITS.note)) }))).status).toBe(200); // at the limit: fine
  });

  test("a body that is not a save is 400; one longer than any save can be is 413", async () => {
    const { mari } = await setup();
    for (const bad of ["{", "[]", { registrationId: mari.id }, body(mari.id, -1), body(mari.id, 0, { notes: ["only one"] }), body(0, 0), body(mari.id, 0, { titles: ["x".repeat(121)], notes: [""] })])
      expect((await post(bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    expect(await answer(await post("x".repeat(MAX_SAVE_CHARS + 1)))).toEqual([413, { ok: false, error: "size" }, "no-store"]);
  });

  test("one note for each heading is part of the body's shape (saveBody), so a SaveInput always has it; a body with another count is the same 400 as before, and nothing is stored", async () => {
    const { mari } = await setup();
    const ok = body(mari.id, 0);
    expect(saveBody.safeParse(ok).success).toBe(true);
    expect(saveBody.safeParse({ ...ok, titles: [], notes: [] }).success).toBe(true);
    for (const bad of [{ ...ok, notes: ["only one"] }, { ...ok, notes: [...notes("A"), "extra"] }, { ...ok, titles: ["Üks"] }]) {
      expect(saveBody.safeParse(bad).success, JSON.stringify(bad.notes)).toBe(false);
      expect(await answer(await post(bad))).toEqual([400, { ok: false, error: "body" }, "no-store"]);
    }
    expect(await stored(mari.id)).toBeUndefined();
  });
});
