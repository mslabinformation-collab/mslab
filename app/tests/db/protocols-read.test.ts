import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courses, protocols } from "@/db/schema";
import { readStudents } from "@/components/admin/protocol-autosave";
import { handleRead, saveProtocol } from "@/server/protocols";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// GET /api/admin/protokoll (app/api/admin/protokoll: withAdmin around handleRead): the protocol screen's data again, for a screen the browser's
// Back restored from its cache (the visit's old render). The same students, in the same shape, as the page hands the screen; reads only.

const NOW = new Date("2026-10-12T08:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const get = (query: string) => handleRead(db, new Request(`https://mslab.example/api/admin/protokoll${query}`));
const notes = (...given: string[]) => [...given, ...Array<string>(HEADINGS.length - given.length).fill("")];

describe("handleRead", () => {
  test("a session: its students (cancelled ones left out) with their protocols as saved, every date as text; never cached", async () => {
    const { course, session } = await protocolCourse(db);
    const mari = await student(db, course, session, "Mari Maasikas");
    const anu = await student(db, course, session, "Anu Aas", { status: "awaiting_prepayment" });
    await student(db, course, session, "Eva Esimene", { status: "cancelled" });
    await saveProtocol(db, { registrationId: mari.id, version: 0, titles: HEADINGS, notes: notes("Esimene."), generalNote: "" }, NOW);
    await saveProtocol(db, { registrationId: mari.id, version: 1, titles: HEADINGS, notes: notes("Teine."), generalNote: "Üldiselt." }, new Date("2026-10-12T08:05:00Z"));
    const res = await get(`?sessioon=${session.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as unknown;
    const students = readStudents(body)!; // the shape the browser takes it in
    expect(students).toEqual([
      { registrationId: anu.id, name: "Anu Aas", awaiting: true, version: 0, titles: HEADINGS, notes: notes(), generalNote: "", sentVersion: null, sentAt: null, savedAt: null },
      {
        registrationId: mari.id,
        name: "Mari Maasikas",
        awaiting: false,
        version: 2,
        titles: HEADINGS,
        notes: notes("Teine."),
        generalNote: "Üldiselt.",
        sentVersion: null,
        sentAt: null,
        savedAt: "2026-10-12T08:05:00.000Z",
      },
    ]);
  });

  test("one registration (an individual course): that student", async () => {
    const { course } = await protocolCourse(db, { slug: "individuaal" });
    const kati = await student(db, course, null, "Kati Kask");
    const res = await get(`?registreering=${kati.id}`);
    expect(res.status).toBe(200);
    expect(readStudents(await res.json())!.map((s) => [s.registrationId, s.version])).toEqual([[kati.id, 0]]);
  });

  test("reading creates nothing: a student with no protocol stays without one (version 0, the course's headings)", async () => {
    const { course, session } = await protocolCourse(db);
    const mari = await student(db, course, session, "Mari Maasikas");
    await get(`?sessioon=${session.id}`);
    await get(`?registreering=${mari.id}`);
    expect(await db.select().from(protocols)).toEqual([]);
  });

  test("no valid id: 400; no such session or registration, or one of an e-course: 404 (nothing else says which)", async () => {
    const { course, session } = await protocolCourse(db);
    const mari = await student(db, course, session, "Mari Maasikas");
    for (const query of ["", "?sessioon=abc", "?sessioon=0", "?registreering=-1", "?sessioon=99999999999", "?id=1"]) {
      const res = await get(query);
      expect(res.status, query).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "body" });
    }
    for (const query of ["?sessioon=2147483647", "?registreering=2147483647"]) {
      const res = await get(query);
      expect(res.status, query).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "notFound" });
    }
    await db.update(courses).set({ type: "e_learning" });
    expect((await get(`?sessioon=${session.id}`)).status).toBe(404);
    expect((await get(`?registreering=${mari.id}`)).status).toBe(404);
  });

  test("a database that fails: 500, logged by the id, nothing of the request in the log", async () => {
    const broken = { select: () => { throw new Error("database is down for mari@example.com"); } } as unknown as Db;
    const res = await handleRead(broken, new Request("https://mslab.example/api/admin/protokoll?sessioon=7"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "server" });
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("[protocols] session 7: the screen could not be read");
    expect(logged).not.toContain("mari@example.com"); // (the error's message is never logged)
  });
});
