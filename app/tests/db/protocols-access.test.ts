import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readStudents } from "@/components/admin/protocol-autosave";
import type { Db } from "@/db/client";
import { protocolScreen, screenStudents } from "@/db/queries/protocols";
import { courseAccess, courses, practicalPhotos, protocols } from "@/db/schema";
import { handleRead, handleSave, saveBody, saveProtocol } from "@/server/protocols";
import { DAY, ecourse, ecourseAccess, learner, POINTS, submitRound } from "./assessment-fixtures";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// The protocol of an e-course access (phase e-course completion, spec §3.4, §5.3, D6): Maria's notes save through the protocol screen's own
// autosave with the access as the owner — made by her first save or by the student's first photo, with the course's points as they are then,
// keeping its own copy after — and the screen reads it with the practical work (?ligipaas=). A registration's protocol is untouched (its tests are
// protocols-save, -read and -screen.test.ts): one owner per save, and a registration and an access with the same number are two protocols.

const SITE = "https://mslab.example";
const MARIA = new Date("2026-11-11T09:00:00Z");
const NEXT = new Date("2026-11-12T09:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const write = (accessId: number, version: number, protocolId: number | null, notes: string[], generalNote = "", titles: string[] = POINTS) =>
  saveProtocol(db, { accessId, protocolId, version, titles, notes, generalNote }, MARIA);
const stored = async (accessId: number) => (await db.select().from(protocols).where(eq(protocols.accessId, accessId)))[0];
const post = (body: unknown) =>
  handleSave(db, new Request(`${SITE}/api/admin/protokoll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), MARIA);
const get = (query: string) => handleRead(db, new Request(`${SITE}/api/admin/protokoll${query}`));

test("an access's first save creates its protocol with the course's points as they are then (a row of no registration); later saves raise the version; it keeps its own copy of the points", async () => {
  const { course, access } = await ecourseAccess(db);
  expect(await write(access.id, 0, null, ["Hea valgus", "", ""])).toMatchObject({ kind: "saved", version: 1 });
  const row = await stored(access.id);
  expect(row).toMatchObject({
    accessId: access.id,
    registrationId: null,
    version: 1,
    round: 0,
    verdicts: [],
    stages: POINTS.map((title, i) => ({ title, note: i === 0 ? "Hea valgus" : "" })),
  });
  expect(await write(access.id, 1, row.id, ["Hea valgus.", "", ""], "Üldiselt hästi")).toEqual({ kind: "saved", protocolId: row.id, version: 2, savedAt: MARIA });
  await db.update(courses).set({ protocolStages: ["Uus punkt"] }).where(eq(courses.id, course.id));
  expect(await write(access.id, 2, row.id, ["Hea valgus!", "", ""], "Üldiselt hästi")).toMatchObject({ kind: "saved", version: 3 });
  expect((await stored(access.id)).stages.map((s) => s.title)).toEqual(POINTS);
  // the version check is a registration's: a save from an older version is refused with what is stored
  expect(await write(access.id, 2, row.id, ["teine seade", "", ""])).toMatchObject({ kind: "conflict", protocol: { id: row.id, version: 3 } });
});

test("the row the student's first photo made (version 1, no text) is built on by the first save of a screen that showed none; once it holds words, such a save is the usual conflict", async () => {
  const { access } = await ecourseAccess(db);
  const p = await submitRound(db, access.id, [0, 1, 2], DAY);
  expect(await write(access.id, 0, null, ["Terav foto", "", ""])).toEqual({ kind: "saved", protocolId: p.id, version: 2, savedAt: MARIA });
  expect(await write(access.id, 0, null, ["Teine ekraan", "", ""])).toMatchObject({ kind: "conflict", protocol: { id: p.id, version: 2 } });
  expect((await stored(access.id)).stages[0].note).toBe("Terav foto");
});

test("one owner per save: a body naming both a registration and an access, or neither, is 400 and nothing is stored", async () => {
  const { access } = await ecourseAccess(db);
  const body = { protocolId: null, version: 0, titles: POINTS, notes: ["a", "", ""], generalNote: "" };
  expect(saveBody.safeParse({ ...body, accessId: access.id }).success).toBe(true);
  expect(saveBody.safeParse({ ...body, registrationId: 1 }).success).toBe(true);
  for (const bad of [{ ...body, accessId: access.id, registrationId: 1 }, body]) {
    expect(saveBody.safeParse(bad).success).toBe(false);
    expect((await post(bad)).status).toBe(400);
  }
  expect(await db.select().from(protocols)).toEqual([]);
  const res = await post({ ...body, accessId: access.id });
  expect([res.status, await res.json()]).toMatchObject([200, { ok: true, version: 1 }]);
});

test("a registration and an access with the same number are two protocols: each save goes to its own", async () => {
  const { course: contact, session } = await protocolCourse(db);
  const mari = await student(db, contact, session, "Mari Maasikas");
  const { access } = await ecourseAccess(db);
  expect(mari.id).toBe(access.id); // the first row of each table: the same number
  await saveProtocol(db, { registrationId: mari.id, version: 0, titles: HEADINGS, notes: ["Kontakt", "", "", ""], generalNote: "" }, MARIA);
  await write(access.id, 0, null, ["E-kursus", "", ""]);
  const rows = await db.select().from(protocols).orderBy(protocols.id);
  expect(rows.map((r) => [r.registrationId, r.accessId, r.stages[0].note])).toEqual([
    [mari.id, null, "Kontakt"],
    [null, access.id, "E-kursus"],
  ]);
});

test("Review Focus 4: an ended access still saves and reads (Maria can still assess); a revoked one, an access to a contact course, or none: 404, nothing written", async () => {
  const { course, lesson } = await ecourse(db);
  const { client, access: ended } = await learner(db, course, lesson, "kati@example.com", { expiresAt: new Date("2026-11-01T00:00:00Z") });
  expect(await write(ended.id, 0, null, ["Hea", "", ""])).toMatchObject({ kind: "saved", version: 1 });
  expect((await get(`?ligipaas=${ended.id}`)).status).toBe(200);

  const { access: revoked } = await learner(db, course, lesson, "mari@example.com", { revokedAt: new Date("2026-11-05T00:00:00Z") });
  expect(await write(revoked.id, 0, null, ["x", "", ""])).toEqual({ kind: "notFound" });
  expect((await post({ accessId: revoked.id, protocolId: null, version: 0, titles: POINTS, notes: ["x", "", ""], generalNote: "" })).status).toBe(404);
  expect((await get(`?ligipaas=${revoked.id}`)).status).toBe(404);
  expect(await protocolScreen(db, { accessId: revoked.id })).toBeNull();
  expect(await stored(revoked.id)).toBeUndefined();

  const { course: contact } = await protocolCourse(db);
  const [odd] = await db.insert(courseAccess).values({ clientId: client.id, courseId: contact.id, grantedBy: "admin@example.test", expiresAt: new Date("2027-01-01T00:00:00Z") }).returning();
  expect(await write(odd.id, 0, null, ["", "", "", ""], "", HEADINGS)).toEqual({ kind: "notFound" });
  expect(await protocolScreen(db, { accessId: odd.id })).toBeNull();
  expect(await write(999_999, 0, null, ["x", "", ""])).toEqual({ kind: "notFound" });
});

test("the screen of an access: one student by her name, her protocol's draft, and the practical work — status, round, the draft's and the sent verdicts, each point's submitted photos newest round first, never the round being prepared", async () => {
  const { access, client } = await ecourseAccess(db);
  // before anything: the course's points with empty notes, nothing submitted
  const empty = (await protocolScreen(db, { accessId: access.id }))!;
  expect(empty.students.map((s) => [s.registrationId, s.name, s.state, s.protocol.version, s.protocol.stages.map((x) => x.title)])).toEqual([[access.id, "Kati Kask", "none", 0, POINTS]]);
  expect(empty.assessment).toEqual({
    accessId: access.id,
    clientId: client.id,
    email: "kati@example.com",
    status: "open",
    round: 0,
    submittedAt: null,
    verdicts: [null, null, null],
    sentVerdicts: null,
    photos: [[], [], []],
    locked: false,
    expiresAt: access.expiresAt,
  });

  // round 1 sent back with point 2 "Paranda"; round 2 redoes it; a photo of round 3 is being prepared
  const p = await submitRound(db, access.id, [0, 1, 2], DAY);
  await db
    .update(protocols)
    .set({ verdicts: ["ok", "fix", "ok"], sent: { stages: p.stages, generalNote: "", verdicts: ["ok", "fix", "ok"] }, sentAt: MARIA, sentVersion: 1, sentRound: 1 })
    .where(eq(protocols.id, p.id));
  await submitRound(db, access.id, [1], NEXT);
  await db.insert(practicalPhotos).values({ protocolId: p.id, stage: 0, round: 3, key: "practical/next.jpg", thumbKey: "practical/next-t.jpg", size: 1000, width: 800, height: 600 });
  const screen = (await protocolScreen(db, { accessId: access.id }))!;
  expect(screen).toMatchObject({ kind: "access", session: null, hidden: 0, course: { title: { et: "Kulmude e-kursus", ru: "Брови онлайн" } } });
  expect(screen.students.map((s) => [s.registrationId, s.state])).toEqual([[access.id, "sent"]]);
  expect(screen.assessment).toMatchObject({ status: "review", round: 2, submittedAt: NEXT, verdicts: ["ok", null, "ok"], sentVerdicts: ["ok", "fix", "ok"], locked: false });
  expect(screen.assessment!.photos.map((point) => point.map((x) => x.round))).toEqual([[1], [2, 1], [1]]);
  // the browser's shape: its dates as text
  const [view] = screenStudents(screen);
  expect(view.assessment).toMatchObject({ status: "review", submittedAt: NEXT.toISOString(), expiresAt: access.expiresAt.toISOString() });
});

test("GET ?ligipaas=<id>: the access's screen in the browser's shape; ?sessioon= and ?registreering= come first; not there: 404; no number: 400; never cached", async () => {
  const { access } = await ecourseAccess(db);
  await submitRound(db, access.id, [0, 1, 2], DAY);
  const res = await get(`?ligipaas=${access.id}`);
  expect([res.status, res.headers.get("cache-control")]).toEqual([200, "no-store"]);
  const body = (await res.json()) as { students: { assessment?: { status: string; submittedAt: string } }[] };
  expect(readStudents(body)!.map((s) => [s.registrationId, s.name, s.titles, s.version])).toEqual([[access.id, "Kati Kask", POINTS, 1]]);
  expect(body.students[0].assessment).toMatchObject({ status: "review", submittedAt: DAY.toISOString() });
  const { course: contact } = await protocolCourse(db, { slug: "individuaal" });
  const kati = await student(db, contact, null, "Kati Kask");
  expect(readStudents(await (await get(`?registreering=${kati.id}&ligipaas=${access.id}`)).json())!.map((s) => s.titles)).toEqual([HEADINGS]);
  expect((await get("?ligipaas=999999")).status).toBe(404);
  expect((await get("?ligipaas=abc")).status).toBe(400);
});
