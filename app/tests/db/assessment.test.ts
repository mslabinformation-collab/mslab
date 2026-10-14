import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { protocolScreen } from "@/db/queries/protocols";
import { courseAccess, courseTests, lessons, protocols, type Verdict } from "@/db/schema";
import { handleVerdict, MAX_VERDICT_CHARS, saveVerdict, sendAssessment } from "@/server/assessment";
import type { Env } from "@/server/notify";
import { saveProtocol, type SendDeps } from "@/server/protocols";
import { fakeKv, stubFetch } from "../fakes";
import { DAY, ecourse, ecourseAccess, learner, POINTS, submitRound } from "./assessment-fixtures";
import { makeTestDb } from "./helpers";

// Maria's assessment (spec §5.3, §8, §9 DB; R2, R3): the verdict taps — refused before the student has sent and once every point is approved and
// sent, stored at once outside the notes' version; "Saada hinnang" — its refusals (a screen of an older round too), the frozen copy with the
// verdicts and sent_round, the mail after the commit (never a note in it) of every row of the plan's Task 10 table, the completion once, the
// notes sent again after an approval, the notes-only protocol of an e-course without points; and Review Focus 4. Two sends at once and the lock order run on real Postgres (Task 14, completion-race.spec.ts).

const SITE = "https://mslab.example";
const MARIA = new Date("2026-11-11T09:00:00Z");
const NEXT = new Date("2026-11-12T09:00:00Z");
const AGAIN = new Date("2026-11-13T09:00:00Z");
const LAST = new Date("2026-11-14T09:00:00Z");
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
/** `flush` runs the work queued after the answer (the mails), as Next's after() does. */
function deps(now = MARIA) {
  const tasks: (() => Promise<unknown>)[] = [];
  const d: SendDeps = { db, env: env(), siteUrl: SITE, now, mailGapMs: 0, later: (task) => void tasks.push(task) };
  return { d, queued: () => tasks.length, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
}
type SentMail = { to: string; subject: string; text: string; html: string };
const mails = () => resend.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as SentMail);
const infoLog = () => vi.mocked(console.info).mock.calls.flat().join("\n");
const write = (accessId: number, version: number, protocolId: number | null, notes: string[], generalNote = "", at = MARIA) =>
  saveProtocol(db, { accessId, protocolId, version, titles: POINTS, notes, generalNote }, at);
const tap = (accessId: number, protocolId: number, stage: number, verdict: Verdict | null) => saveVerdict(db, { accessId, protocolId, stage, verdict }, MARIA);
const stored = async (accessId: number) => (await db.select().from(protocols).where(eq(protocols.accessId, accessId)))[0];
const completedAt = async (accessId: number) => (await db.select({ at: courseAccess.completedAt }).from(courseAccess).where(eq(courseAccess.id, accessId)))[0].at;

/** Kati's first round with Maria's notes (version 2) and her verdicts: point 2 "Paranda". */
async function assessed() {
  const { access } = await ecourseAccess(db);
  const p = await submitRound(db, access.id, [0, 1, 2], DAY);
  await write(access.id, 1, p.id, ["", "Kuju on ebaühtlane", ""], "Hea algus");
  for (const [stage, verdict] of [[0, "ok"], [1, "fix"], [2, "ok"]] as const) await tap(access.id, p.id, stage, verdict);
  return { access, p };
}

describe("the verdict taps (R2)", () => {
  test("before the student has sent her work a tap is closed — no protocol yet, or Maria's early notes (round 0); after it each tap is stored at once, the others kept, the notes' version untouched", async () => {
    const { access } = await ecourseAccess(db);
    expect(await tap(access.id, 1, 0, "ok")).toEqual({ kind: "closed" });
    await write(access.id, 0, null, ["Vaata valgust", "", ""]); // "Lisa protokoll" early: Maria's first save makes the row
    const early = await stored(access.id);
    expect(await tap(access.id, early.id, 0, "ok")).toEqual({ kind: "closed" });
    await submitRound(db, access.id, [0, 1, 2], DAY);
    expect(await tap(access.id, early.id, 1, "fix")).toEqual({ kind: "saved", verdicts: [null, "fix", null] });
    expect(await tap(access.id, early.id, 0, "ok")).toEqual({ kind: "saved", verdicts: ["ok", "fix", null] });
    expect(await tap(access.id, early.id, 1, null)).toEqual({ kind: "saved", verdicts: ["ok", null, null] }); // the pressed one tapped again
    expect(await stored(access.id)).toMatchObject({ version: 1, verdicts: ["ok", null, null], sentAt: null, stages: [{ note: "Vaata valgust" }, {}, {}] });
  });

  test("a tap of another row, or of a point the protocol does not have, is stale; an access that is not there is notFound; nothing is written", async () => {
    const { access } = await ecourseAccess(db);
    const p = await submitRound(db, access.id, [0, 1, 2], DAY);
    expect(await tap(access.id, p.id + 1, 0, "ok")).toEqual({ kind: "stale" });
    expect(await tap(access.id, p.id, 3, "ok")).toEqual({ kind: "stale" });
    expect(await tap(999_999, p.id, 0, "ok")).toEqual({ kind: "notFound" });
    expect((await stored(access.id)).verdicts).toEqual([null, null, null]);
  });

  test("POST /api/admin/hinnang (handleVerdict): 200 with the stored verdicts, 409 closed or stale, 404, 400 for what is not a tap, 413 for a body far too long; never cached", async () => {
    const { access } = await ecourseAccess(db);
    const post = (body: unknown) =>
      handleVerdict(db, new Request(`${SITE}/api/admin/hinnang`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), MARIA);
    const answer = async (res: Response) => [res.status, await res.json(), res.headers.get("cache-control")];
    expect(await answer(await post({ accessId: access.id, protocolId: 1, stage: 0, verdict: "ok" }))).toEqual([409, { ok: false, error: "closed" }, "no-store"]);
    const p = await submitRound(db, access.id, [0, 1, 2], DAY);
    expect(await answer(await post({ accessId: access.id, protocolId: p.id, stage: 2, verdict: "fix" }))).toEqual([200, { ok: true, verdicts: [null, null, "fix"] }, "no-store"]);
    expect(await answer(await post({ accessId: access.id, protocolId: p.id, stage: 5, verdict: "ok" }))).toEqual([409, { ok: false, error: "stale" }, "no-store"]);
    expect(await answer(await post({ accessId: 999_999, protocolId: p.id, stage: 0, verdict: "ok" }))).toEqual([404, { ok: false, error: "notFound" }, "no-store"]);
    const tapOf = (over: Record<string, unknown>) => ({ accessId: access.id, protocolId: p.id, stage: 0, verdict: "ok", ...over });
    for (const bad of ["{", "[]", { accessId: access.id }, tapOf({ stage: -1 }), tapOf({ stage: 30 }), tapOf({ stage: 1.5 }), tapOf({ verdict: "maybe" }), tapOf({ protocolId: 0 }), tapOf({ accessId: "1" })])
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(await answer(await post("x".repeat(MAX_VERDICT_CHARS + 1)))).toEqual([413, { ok: false, error: "size" }, "no-store"]);
    expect((await stored(access.id)).verdicts).toEqual([null, null, "fix"]);
  });
});

describe("Saada hinnang", () => {
  test("refused before the student has sent (notSubmitted), with a point without a verdict (verdicts: the points, 0-based), with a Paranda without a note (comments): nothing frozen, no mail", async () => {
    const { access } = await ecourseAccess(db);
    const { d, queued } = deps();
    expect(await sendAssessment(d, { accessId: access.id, version: 0, protocolId: null, round: 0 })).toEqual({ kind: "notSubmitted" });
    await write(access.id, 0, null, ["Vaata valgust", "Jälgi kuju", ""]);
    const p = await stored(access.id);
    const send = (round: number) => sendAssessment(d, { accessId: access.id, version: 1, protocolId: p.id, round });
    expect(await send(0)).toEqual({ kind: "notSubmitted" });
    await submitRound(db, access.id, [0, 1, 2], DAY);
    expect(await send(1)).toEqual({ kind: "verdicts", missing: [0, 1, 2] });
    await tap(access.id, p.id, 0, "ok");
    await tap(access.id, p.id, 1, "fix");
    expect(await send(1)).toEqual({ kind: "verdicts", missing: [2] });
    await tap(access.id, p.id, 2, "fix");
    expect(await send(1)).toEqual({ kind: "comments", missing: [2] }); // point 2 has its note ("Jälgi kuju"), point 3 none
    expect([(await stored(access.id)).sentAt, queued()]).toEqual([null, 0]);
  });

  test("a Paranda: the notes and the verdicts frozen into `sent`, sent_round = round, status fix; the 'assessed' mail after the commit, no note in it; the same again is already; a correction of the same round goes again", async () => {
    const { access, p } = await assessed();
    const { d, queued, flush } = deps(MARIA);
    expect(await sendAssessment(d, { accessId: access.id, version: 2, protocolId: p.id, round: 1 })).toEqual({ kind: "sent", status: "fix", completed: false, version: 2, sentAt: MARIA.toISOString() });
    expect(await stored(access.id)).toMatchObject({
      round: 1,
      version: 2,
      sentVersion: 2,
      sentAt: MARIA,
      sentRound: 1,
      sent: {
        stages: [
          { title: POINTS[0], note: "" },
          { title: POINTS[1], note: "Kuju on ebaühtlane" },
          { title: POINTS[2], note: "" },
        ],
        generalNote: "Hea algus",
        verdicts: ["ok", "fix", "ok"],
      },
    });
    expect(await completedAt(access.id)).toBeNull();
    expect(infoLog()).toContain(`[assessment] access ${access.id}: sent (fix)`);
    // nothing is mailed inside the transaction: the mail is queued, and goes when the work after the answer runs
    expect([mails(), queued()]).toEqual([[], 1]);
    await flush();
    const [mail] = mails();
    expect([mail.to, mail.subject]).toEqual(["kati@example.com", "Sinu praktiline töö on hinnatud"]);
    expect(mail.text).toContain(`${SITE}/konto/kursus/kulmud-e/praktiline`);
    expect(mail.text).toContain("Parandamist vajavaid punkte: 1");
    for (const body of [mail.text, mail.html]) for (const note of ["Kuju on ebaühtlane", "Hea algus"]) expect(body).not.toContain(note);

    const again = deps(NEXT);
    expect(await sendAssessment(again.d, { accessId: access.id, version: 2, protocolId: p.id, round: 1 })).toEqual({ kind: "already", version: 2, sentAt: MARIA.toISOString() });
    expect(again.queued()).toBe(0);

    // "Muuda" and a correction of the same round (spec §8): point 1 needs fixing too; the new copy replaces the old, the status follows it
    await tap(access.id, p.id, 0, "fix");
    await write(access.id, 2, p.id, ["Valgus on liiga hele", "Kuju on ebaühtlane", ""], "Hea algus");
    const fixed = deps(NEXT);
    expect(await sendAssessment(fixed.d, { accessId: access.id, version: 3, protocolId: p.id, round: 1 })).toEqual({ kind: "sent", status: "fix", completed: false, version: 3, sentAt: NEXT.toISOString() });
    expect(await stored(access.id)).toMatchObject({ sentRound: 1, sent: { verdicts: ["fix", "fix", "ok"] } });
    await fixed.flush();
    expect(mails()[1].text).toContain("Parandamist vajavaid punkte: 2");
  });

  test("R3: the student's second round (the Paranda verdict cleared, the notes' version untouched); Maria approves it: passed, completed_at set once, the 'completed' mail; then the verdicts are locked, changed notes go again alone (protocolAgain), nothing new is already", async () => {
    const { access, p } = await assessed();
    const first = deps(MARIA);
    await sendAssessment(first.d, { accessId: access.id, version: 2, protocolId: p.id, round: 1 });
    await first.flush();
    expect(await submitRound(db, access.id, [1], NEXT)).toMatchObject({ round: 2, verdicts: ["ok", null, "ok"], version: 2 });
    const { d, flush } = deps(AGAIN);
    expect(await sendAssessment(d, { accessId: access.id, version: 2, protocolId: p.id, round: 2 })).toEqual({ kind: "verdicts", missing: [1] });
    await tap(access.id, p.id, 1, "ok");
    expect(await sendAssessment(d, { accessId: access.id, version: 2, protocolId: p.id, round: 2 })).toEqual({ kind: "sent", status: "passed", completed: true, version: 2, sentAt: AGAIN.toISOString() });
    expect(await stored(access.id)).toMatchObject({ round: 2, sentRound: 2, sent: { verdicts: ["ok", "ok", "ok"] } });
    expect(await completedAt(access.id)).toEqual(AGAIN);
    await flush();
    const done = mails().at(-1)!;
    expect(done.subject).toContain("Palju õnne!");
    expect(done.subject).toContain("Kulmude e-kursus");

    // approved and sent: the verdicts are locked
    expect(await tap(access.id, p.id, 1, "fix")).toEqual({ kind: "closed" });
    expect(await sendAssessment(deps(LAST).d, { accessId: access.id, version: 2, protocolId: p.id, round: 2 })).toEqual({ kind: "already", version: 2, sentAt: AGAIN.toISOString() });
    // changed notes go again, and only they: the verdicts and completed_at stay; the mail is the protocol's "uuendatud"
    await write(access.id, 2, p.id, ["", "Kuju on nüüd ühtlane", ""], "Hea algus. Tubli!", LAST);
    const notes = deps(LAST);
    expect(await sendAssessment(notes.d, { accessId: access.id, version: 3, protocolId: p.id, round: 2 })).toEqual({ kind: "sent", status: "passed", completed: false, version: 3, sentAt: LAST.toISOString() });
    expect(await stored(access.id)).toMatchObject({ sentVersion: 3, sentRound: 2, sent: { generalNote: "Hea algus. Tubli!", verdicts: ["ok", "ok", "ok"] } });
    expect(await completedAt(access.id)).toEqual(AGAIN);
    await notes.flush();
    expect(mails().map((m) => m.subject)).toHaveLength(3);
    expect(mails()[2].subject).toBe("Sinu koolituse protokolli on uuendatud");
  });

  test("every point ok while another step is still open (a test Maria added after the submission): passed, not completed, the 'assessed' mail without a count of points to fix", async () => {
    const { course, access } = await ecourseAccess(db);
    const p = await submitRound(db, access.id, [0, 1, 2], DAY);
    const question = { id: "q1", kind: "choice" as const, text: "Mis on esimene samm?", options: [{ id: "a", text: "Ettevalmistus", correct: true }, { id: "b", text: "Värvimine", correct: false }] };
    await db.insert(courseTests).values({ courseId: course.id, questions: [question] }); // the test step is open: no attempt yet
    for (const stage of [0, 1, 2]) await tap(access.id, p.id, stage, "ok");
    const { d, queued, flush } = deps(MARIA);
    expect(await sendAssessment(d, { accessId: access.id, version: 1, protocolId: p.id, round: 1 })).toEqual({ kind: "sent", status: "passed", completed: false, version: 1, sentAt: MARIA.toISOString() });
    expect(await stored(access.id)).toMatchObject({ sentRound: 1, sent: { verdicts: ["ok", "ok", "ok"] } });
    expect(await completedAt(access.id)).toBeNull();
    expect(infoLog()).toContain(`[assessment] access ${access.id}: sent (passed)`);
    expect(infoLog()).not.toContain("completed");
    expect(queued()).toBe(1);
    await flush();
    const [mail] = mails();
    expect([mails().length, mail.subject]).toEqual([1, "Sinu praktiline töö on hinnatud"]);
    expect(mail.text).not.toContain("Parandamist vajavaid punkte");
  });

  test("approved before while another step was open; that step is gone since (Maria hid the lesson) and the notes changed: the notes' send completes the course and mails 'completed', not 'protocolAgain'", async () => {
    const { lesson, access } = await ecourseAccess(db);
    const [extra] = await db.insert(lessons).values({ moduleId: lesson.moduleId, position: 2, title: { et: "Lisatund" }, kind: "text" }).returning(); // not done by Kati
    const p = await submitRound(db, access.id, [0, 1, 2], DAY);
    await write(access.id, 1, p.id, ["", "", ""], "Hea töö");
    for (const stage of [0, 1, 2]) await tap(access.id, p.id, stage, "ok");
    const first = deps(MARIA);
    expect(await sendAssessment(first.d, { accessId: access.id, version: 2, protocolId: p.id, round: 1 })).toEqual({ kind: "sent", status: "passed", completed: false, version: 2, sentAt: MARIA.toISOString() });
    await first.flush();
    expect(mails().map((m) => m.subject)).toEqual(["Sinu praktiline töö on hinnatud"]);
    // Maria hides the lesson (nothing completes on that: the student's next page load, or this send, does); then she changes her notes
    await db.update(lessons).set({ hidden: true }).where(eq(lessons.id, extra.id));
    expect(await completedAt(access.id)).toBeNull();
    expect(await write(access.id, 2, p.id, ["", "", ""], "Hea töö. Tubli!", NEXT)).toMatchObject({ kind: "saved", version: 3 });
    const notes = deps(NEXT);
    expect(await sendAssessment(notes.d, { accessId: access.id, version: 3, protocolId: p.id, round: 1 })).toEqual({ kind: "sent", status: "passed", completed: true, version: 3, sentAt: NEXT.toISOString() });
    expect(await stored(access.id)).toMatchObject({ sentVersion: 3, sentRound: 1, sent: { generalNote: "Hea töö. Tubli!", verdicts: ["ok", "ok", "ok"] } });
    expect(await completedAt(access.id)).toEqual(NEXT);
    expect(infoLog()).toContain(`[assessment] access ${access.id}: sent (passed, completed)`);
    await notes.flush();
    expect(mails()).toHaveLength(2);
    expect(mails()[1].subject).toContain("Palju õnne!");
  });

  test("the version and the row the screen showed must be the stored ones: stale, nothing frozen; an access that is not there: notFound", async () => {
    const { access } = await ecourseAccess(db);
    const p = await submitRound(db, access.id, [0, 1, 2], DAY);
    for (const stage of [0, 1, 2]) await tap(access.id, p.id, stage, "ok");
    await write(access.id, 1, p.id, ["Hea", "", ""]); // version 2: another device's save
    const { d, queued } = deps();
    expect(await sendAssessment(d, { accessId: access.id, version: 1, protocolId: p.id, round: 1 })).toEqual({ kind: "stale", version: 2 });
    expect(await sendAssessment(d, { accessId: access.id, version: 2, protocolId: p.id + 1, round: 1 })).toEqual({ kind: "stale", version: 2 });
    expect(await sendAssessment(d, { accessId: 999_999, version: 2, protocolId: p.id, round: 1 })).toEqual({ kind: "notFound" });
    expect([(await stored(access.id)).sentAt, queued()]).toEqual([null, 0]);
  });

  test("a screen of an older round is stale: the student sent a new round meanwhile (R3 leaves the version), so Maria's 'ok' on the round she saw approves nothing — nothing frozen, not completed, no mail", async () => {
    const { access, p } = await assessed();
    const first = deps(MARIA);
    expect(await sendAssessment(first.d, { accessId: access.id, version: 2, protocolId: p.id, round: 1 })).toMatchObject({ kind: "sent", status: "fix" });
    await first.flush();
    // round 2: point 2 redone, its verdict back to null, the notes' version still 2; Maria's screen still shows round 1
    expect(await submitRound(db, access.id, [1], NEXT)).toMatchObject({ round: 2, version: 2, verdicts: ["ok", null, "ok"] });
    expect(await tap(access.id, p.id, 1, "ok")).toEqual({ kind: "saved", verdicts: ["ok", "ok", "ok"] });
    const stale = deps(AGAIN);
    expect(await sendAssessment(stale.d, { accessId: access.id, version: 2, protocolId: p.id, round: 1 })).toEqual({ kind: "stale", version: 2 });
    expect(await stored(access.id)).toMatchObject({ round: 2, sentRound: 1, sentVersion: 2, sentAt: MARIA, sent: { verdicts: ["ok", "fix", "ok"] } });
    expect(await completedAt(access.id)).toBeNull();
    expect(stale.queued()).toBe(0);
    expect(mails()).toHaveLength(1); // the round-1 "assessed" only
  });

  test("an e-course without points: the notes-only protocol — empty without text; the first send mails 'protocol', a later one 'protocolAgain'; nothing new is already", async () => {
    const { access } = await ecourseAccess(db, { points: [] });
    expect(await sendAssessment(deps().d, { accessId: access.id, version: 0, protocolId: null, round: 0 })).toEqual({ kind: "empty" });
    await saveProtocol(db, { accessId: access.id, protocolId: null, version: 0, titles: [], notes: [], generalNote: "Tubli töö" }, MARIA);
    const p = await stored(access.id);
    const first = deps(MARIA);
    expect(await sendAssessment(first.d, { accessId: access.id, version: 1, protocolId: p.id, round: 0 })).toEqual({ kind: "sent", status: "open", completed: false, version: 1, sentAt: MARIA.toISOString() });
    expect(await stored(access.id)).toMatchObject({ sentVersion: 1, sentRound: 0, sent: { stages: [], generalNote: "Tubli töö", verdicts: [] } });
    await first.flush();
    expect(mails()[0].subject).toBe("Sinu koolituse protokoll on valmis");
    expect(mails()[0].text).not.toContain("Tubli töö");
    expect(await sendAssessment(deps(NEXT).d, { accessId: access.id, version: 1, protocolId: p.id, round: 0 })).toEqual({ kind: "already", version: 1, sentAt: MARIA.toISOString() });
    await saveProtocol(db, { accessId: access.id, protocolId: p.id, version: 1, titles: [], notes: [], generalNote: "Tubli töö, jätka" }, NEXT);
    const again = deps(NEXT);
    expect(await sendAssessment(again.d, { accessId: access.id, version: 2, protocolId: p.id, round: 0 })).toMatchObject({ kind: "sent", version: 2 });
    await again.flush();
    expect(mails()[1].subject).toBe("Sinu koolituse protokolli on uuendatud");
  });

  test("Review Focus 4: an ended access is still assessed and sent; a revoked one is notFound for the notes, a tap and the send, its screen is gone, and nothing is written", async () => {
    const { course, lesson } = await ecourse(db);
    const { access: ended } = await learner(db, course, lesson, "kati@example.com", { expiresAt: new Date("2026-11-01T00:00:00Z") });
    const p = await submitRound(db, ended.id, [0, 1, 2], new Date("2026-10-30T10:00:00Z"));
    expect(await write(ended.id, 1, p.id, ["", "", ""], "Hea töö")).toMatchObject({ kind: "saved", version: 2 });
    for (const stage of [0, 1, 2]) expect(await tap(ended.id, p.id, stage, "ok")).toMatchObject({ kind: "saved" });
    expect(await sendAssessment(deps().d, { accessId: ended.id, version: 2, protocolId: p.id, round: 1 })).toMatchObject({ kind: "sent", status: "passed" });

    const { access: gone } = await learner(db, course, lesson, "mari@example.com");
    const q = await submitRound(db, gone.id, [0, 1, 2], DAY);
    await db.update(courseAccess).set({ revokedAt: DAY }).where(eq(courseAccess.id, gone.id));
    expect(await write(gone.id, 1, q.id, ["x", "", ""])).toEqual({ kind: "notFound" });
    expect(await tap(gone.id, q.id, 0, "ok")).toEqual({ kind: "notFound" });
    const { d, queued } = deps();
    expect(await sendAssessment(d, { accessId: gone.id, version: 1, protocolId: q.id, round: 1 })).toEqual({ kind: "notFound" });
    expect(await protocolScreen(db, { accessId: gone.id })).toBeNull();
    expect(await stored(gone.id)).toMatchObject({ version: 1, verdicts: [null, null, null], sentAt: null });
    expect(queued()).toBe(0);
  });
});
