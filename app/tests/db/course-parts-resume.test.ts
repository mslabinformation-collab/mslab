// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courses } from "@/db/schema";
import { AutosaveEngine, draftKey, type Fields, type SendPatch } from "@/components/admin/autosave/engine";
import { autosaveHandler } from "@/server/autosave-route";
import { makeTestDb } from "./helpers";

// Review I-1 of Task 4 (admin UX pass piece 3a; Review Focus 1, "never a silent overwrite"), through the editors' real autosave engine: a copy this
// browser kept of a card's text (its answer never came) is sent again, on the next visit, against the version it was typed on (engine.ts resume). A
// draft's version names the draft row ("d:<id>.<n>"), so a copy typed on a draft that has since been published is a conflict with the new draft, never
// saved over it, although the new draft's counter is back at 1. The route's contract is the real one (autosaveHandler); the database is PGlite.

const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import { coursePartPatch, publishCourse, readCoursePart, writeCoursePart } from "@/server/course-parts";

const MARIA = { email: "maria@example.test" };
const NOW = new Date("2026-10-24T09:00:00Z");
let db: Db;
let id: number;
let engine: AutosaveEngine | null = null;

beforeEach(async () => {
  db = await makeTestDb();
  localStorage.clear();
  [{ id }] = await db
    .insert(courses)
    .values({ slug: "e-kulm", type: "e_learning", level: "basic", title: { et: "E-kulm" }, summary: { et: "" }, body: { et: "" }, price: 9500, published: true })
    .returning();
});
afterEach(() => {
  engine?.stop();
  engine = null;
});

/** The basics card's save, as POST /api/admin/koolitus/<id>/osa/basics answers it (without the session check: autosaveHandler alone). */
const send: SendPatch = async (body) => {
  const save = autosaveHandler<Record<string, unknown>>({
    schema: coursePartPatch("basics"),
    read: (courseId) => readCoursePart(db, courseId, "basics"),
    write: (courseId, patch, version, admin) => writeCoursePart(db, courseId, "basics", patch, version, admin, NOW),
  });
  const res = await save(new Request("https://mslab.example/api/admin/koolitus/1/osa/basics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), id, MARIA);
  return { status: res.status, body: await res.json() };
};
const basics = async () => (await readCoursePart(db, id, "basics"))!;

test("a copy kept from a draft that was published since is resumed as a conflict with the new draft; the new draft keeps its text", async () => {
  await writeCoursePart(db, id, "basics", { title: { et: "A1" } }, (await basics()).version, MARIA, NOW);
  const old = await basics();
  // this browser typed on that draft and kept the text (the save's answer never came)
  const key = draftKey("course", `${id}-basics`, "vana");
  localStorage.setItem(key, JSON.stringify({ version: old.version, fields: { ...(old.value as Fields), title: { et: "Vana koopia" } }, sent: [], at: Date.now() }));
  // meanwhile: published, and typed on in another tab (a new draft, its counter at 1 again)
  expect((await publishCourse(db, id, NOW)).published).toEqual(["basics"]);
  await writeCoursePart(db, id, "basics", { title: { et: "A2" } }, (await basics()).version, MARIA, NOW);
  const now = await basics();
  expect(now.version).not.toBe(old.version);

  // the card opens again in this browser: the engine resumes the copy against the version it was typed on
  engine = new AutosaveEngine({ owner: "course", key: `${id}-basics`, version: now.version, fields: { ...(now.value as Fields) }, send, tab: "uus" });
  engine.start(localStorage);
  await vi.waitFor(() => expect(engine!.snapshot().status.kind).toBe("conflict"));
  expect(engine.snapshot().conflict).toEqual({ version: now.version, value: now.value });
  expect(engine.snapshot().fields).toMatchObject({ title: { et: "Vana koopia" } }); // the text stays on screen and in the copy, for „Taasta minu tekst“
  expect((await basics()).value).toMatchObject({ title: { et: "A2" } });
});
