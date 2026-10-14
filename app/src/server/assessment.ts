import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { courses, protocols, type SentProtocol, type Verdict } from "@/db/schema";
import { practicalStatus, type PracticalStatus } from "@/domain/completion";
import { hasText, PROTOCOL_LIMITS, readStages } from "@/domain/protocols";
import type { CompletionMailKind } from "./account-mail";
import { completeIfDone, completionJob, isActive, lockAccess, mailCompletion } from "./completion";
import { logFailure } from "./log";
import type { SendDeps } from "./protocols";

// Maria's assessment of an e-course's practical work (phase e-course completion, spec §5.3, §8; R2, R3), without Next.js: the verdict taps
// (saveVerdict, behind POST /api/admin/hinnang) and "Saada hinnang" (sendAssessment, behind actions/admin-assessment.ts). The admin session is
// checked by the callers (withAdmin, adminAction). The notes are the protocol's own autosave (server/protocols.ts saveProtocol with the access
// as the owner); the verdicts are a column of their own, saved per tap, which the notes' version check does not cover (R2), and the sent copy
// carries them. Every write here locks the access row first (server/completion.ts lockAccess), then the protocol row (FOR UPDATE): the order of
// every writer about one access (the student's photos and submit, server/practical.ts; the test, server/test-attempts.ts), so none of them can
// deadlock with another, and a tap or a send never meets the student's submit half done. Logs carry the access's id only: never a note, a name
// or an address.

/**
 * One tap: the access, the protocol's row the screen shows, the student's round it shows (AssessmentView.round), the point (0-based) and its
 * verdict (null: cleared, the pressed button tapped again). Task 11's tap sends the round its screen shows: a resubmission never raises the
 * version (R3), so only the round tells a screen of an older submission from the stored one.
 */
export const verdictBody = z.object({
  accessId: z.number().int().positive().max(2_147_483_647),
  protocolId: z.number().int().positive().max(2_147_483_647),
  round: z.number().int().min(0).max(2_147_483_647),
  stage: z.number().int().min(0).max(PROTOCOL_LIMITS.stages - 1),
  verdict: z.enum(["ok", "fix"]).nullable(),
});
export type VerdictInput = z.infer<typeof verdictBody>;

/**
 * saved: the verdicts as stored now (one per point); closed: nothing was sent by the student yet (no protocol, or round 0), or every point is
 * approved and sent (the verdicts are locked: spec §8); stale: the screen's row is not the stored one, the point is not the protocol's, or the
 * student sent a new round since the screen was read (Maria would judge photos she has not seen); notFound: no such access, or a revoked one.
 */
export type VerdictResult = { kind: "saved"; verdicts: (Verdict | null)[] } | { kind: "closed" } | { kind: "stale" } | { kind: "notFound" };

/**
 * One tap (R2): last tap wins. An ended access is still assessed (spec §8); a revoked one is not. The tap writes `verdicts[stage]` (the list
 * read along the points, so one stored shorter is filled with nulls) and the protocol's `updated_at`; never the notes' version: a screen of the
 * same protocol on another device is not told to reload by it (its next read brings the verdicts).
 */
export async function saveVerdict(db: Db, input: VerdictInput, now: Date): Promise<VerdictResult> {
  return db.transaction(async (tx): Promise<VerdictResult> => {
    const access = await lockAccess(tx as unknown as Db, input.accessId);
    if (!access || access.revokedAt !== null) return { kind: "notFound" };
    const [p] = await tx.select().from(protocols).where(eq(protocols.accessId, input.accessId)).for("update");
    if (!p) return { kind: "closed" }; // (her first photo makes the protocol: none, nothing sent)
    if (p.id !== input.protocolId || input.stage >= p.stages.length) return { kind: "stale" };
    if (p.round === 0 || practicalStatus(p) === "passed") return { kind: "closed" };
    if (p.round !== input.round) return { kind: "stale" }; // (after "closed": not submitted or locked is the lasting answer)
    const verdicts = p.stages.map((_, i) => (i === input.stage ? input.verdict : (p.verdicts[i] ?? null)));
    await tx.update(protocols).set({ verdicts, updatedAt: now }).where(eq(protocols.id, p.id));
    return { kind: "saved", verdicts };
  });
}

/** A tap's body is a few dozen characters: anything far longer is not one. */
export const MAX_VERDICT_CHARS = 1024;

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/admin/hinnang — one verdict tap (the route wraps this in withAdmin). 200 `{ ok: true, verdicts }`; 409 `{ ok: false, error: "closed" |
 * "stale" }`; 404 `{ ok: false, error: "notFound" }`; 400 `{ error: "body" }` (not a tap); 413 `{ error: "size" }`; 500 `{ error: "server" }`,
 * logged by the access's id. Never cached.
 */
export async function handleVerdict(db: Db, request: Request, now: Date): Promise<Response> {
  let value: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_VERDICT_CHARS) return json({ ok: false, error: "size" }, 413);
    value = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "body" }, 400);
  }
  const parsed = verdictBody.safeParse(value);
  if (!parsed.success) return json({ ok: false, error: "body" }, 400);
  try {
    const result = await saveVerdict(db, parsed.data, now);
    if (result.kind === "saved") return json({ ok: true, verdicts: result.verdicts });
    if (result.kind === "notFound") return json({ ok: false, error: "notFound" }, 404);
    return json({ ok: false, error: result.kind }, 409);
  } catch (e) {
    logFailure(`[assessment] access ${parsed.data.accessId}: the verdict failed`, e);
    return json({ ok: false, error: "server" }, 500);
  }
}

/**
 * What "Saada hinnang" names: the access, the notes' version the screen confirmed, the protocol's row it shows (null: none yet), and the
 * student's round it showed (AssessmentView.round; 0: none submitted). The screen passes the round it showed: a resubmission never raises the
 * version (R3), so only the round tells a screen of an older submission from the stored one.
 */
export type AssessmentInput = { accessId: number; version: number; protocolId: number | null; round: number };

/**
 * sent: frozen now (`status` after it; `completed`: this send completed the course); notSubmitted: the course has points and the student has
 * sent nothing yet; verdicts / comments: the points (0-based) without a verdict, or "Paranda" without a note; already: nothing new since the
 * last send; stale: the stored version, row or round is not the screen's (`version`: the stored one); empty: notes only and nothing written;
 * notFound: no such access to an e-course, or a revoked one.
 */
export type AssessmentResult =
  | { kind: "sent"; status: PracticalStatus; completed: boolean; version: number; sentAt: string }
  | { kind: "notSubmitted" }
  | { kind: "verdicts"; missing: number[] }
  | { kind: "comments"; missing: number[] }
  | { kind: "already"; version: number; sentAt: string }
  | { kind: "stale"; version: number }
  | { kind: "empty" }
  | { kind: "notFound" };

/** The mail of a send, made after the commit (Task 2's completionMail through Task 4's mailCompletion). */
type AssessmentMail = { kind: CompletionMailKind; fixCount?: number };

/** Two verdict lists alike point by point (a sent copy without verdicts is none). */
const sameVerdicts = (a: readonly (Verdict | null)[] | undefined, b: readonly (Verdict | null)[]): boolean =>
  a !== undefined && a.length === b.length && a.every((v, i) => (v ?? null) === b[i]);

/**
 * "Saada hinnang" (spec §5.3, §8; R2), in one transaction:
 * 1. the locks: the access (revoked: notFound; ended: still assessed), then the protocol row;
 * 2. the checks: no protocol (nothing submitted, nothing written); another version, row or round than the screen's: stale (the round: the
 *    student sent a new one since the screen was read — R3 leaves the version as it was — so Maria never approves photos she has not seen);
 * 3. an e-course without points (the protocol's own copy has none): the notes-only protocol, sent as a contact course's ("protocol", then
 *    "protocolAgain"); with points: nothing submitted yet (round 0), a point without a verdict, a "Paranda" without a note are refused; approved
 *    and sent before: the verdicts are locked, changed notes go again alone; the same round, version and verdicts as the last send: already;
 * 4. the freeze: `sent` = { stages, generalNote, verdicts }, sent_at, sent_version, sent_round = round; every point ok: completeIfDone
 *    (completed_at once, in this transaction).
 * The mail goes after the commit (`later`): see the table in the plan's Task 10; it never carries a note, and a sample address is never mailed
 * (mailCompletion). An access that has ended (the locked row's expires_at) gets no "assessed" mail, as she can no longer redo a "Paranda"
 * point; "completed" and the notes-only protocol mails still go. A mail that fails never undoes the send.
 */
export async function sendAssessment(deps: SendDeps, input: AssessmentInput): Promise<AssessmentResult> {
  const done = await deps.db.transaction(async (tx): Promise<{ result: AssessmentResult; mail: AssessmentMail | null }> => {
    const t = tx as unknown as Db;
    const none = (result: AssessmentResult) => ({ result, mail: null });
    const access = await lockAccess(t, input.accessId);
    if (!access || access.revokedAt !== null) return none({ kind: "notFound" });
    const [course] = await tx.select({ type: courses.type, points: courses.protocolStages }).from(courses).where(eq(courses.id, access.courseId)).limit(1);
    if (!course || course.type !== "e_learning") return none({ kind: "notFound" });
    const [p] = await tx.select().from(protocols).where(eq(protocols.accessId, input.accessId)).for("update");
    if (!p) return none(readStages(course.points).length > 0 ? { kind: "notSubmitted" } : { kind: "empty" });
    if (p.version !== input.version || (input.protocolId !== null && p.id !== input.protocolId) || p.round !== input.round) return none({ kind: "stale", version: p.version });
    const verdicts = p.stages.map((_, i) => p.verdicts[i] ?? null);
    const freeze = async (frozen: (Verdict | null)[]): Promise<SentProtocol> => {
      const sent: SentProtocol = { stages: p.stages, generalNote: p.generalNote, verdicts: frozen };
      await tx.update(protocols).set({ sent, sentAt: deps.now, sentVersion: p.version, sentRound: p.round }).where(eq(protocols.id, p.id));
      return sent;
    };
    const sentAs = (status: PracticalStatus, completed: boolean): AssessmentResult => ({ kind: "sent", status, completed, version: p.version, sentAt: deps.now.toISOString() });
    const already = (sentAt: Date): AssessmentResult => ({ kind: "already", version: p.version, sentAt: sentAt.toISOString() });

    // an e-course without points: Maria's notes only (spec §4.3 last bullet, §5.3 last bullet)
    if (p.stages.length === 0) {
      if (!hasText(p)) return none({ kind: "empty" });
      if (p.sentAt !== null && p.sentVersion === p.version) return none(already(p.sentAt));
      const sent = await freeze([]);
      return { result: sentAs(practicalStatus({ round: p.round, sentRound: p.round, sent }), false), mail: { kind: p.sentAt === null ? "protocol" : "protocolAgain" } };
    }
    if (p.round === 0) return none({ kind: "notSubmitted" });
    if (practicalStatus(p) === "passed" && p.sentAt !== null) {
      // approved and sent: the verdicts are locked; changed notes go again, and only they (spec §8)
      if (p.sentVersion === p.version) return none(already(p.sentAt));
      await freeze(p.sent?.verdicts ?? verdicts);
      const completed = await completeIfDone(t, access.id, deps.now); // (a step added since the approval may have kept it open until now)
      return { result: sentAs("passed", completed), mail: { kind: completed ? "completed" : "protocolAgain" } };
    }
    const missing = verdicts.flatMap((v, i) => (v === null ? [i] : []));
    if (missing.length > 0) return none({ kind: "verdicts", missing });
    const bare = verdicts.flatMap((v, i) => (v === "fix" && p.stages[i].note.trim() === "" ? [i] : []));
    if (bare.length > 0) return none({ kind: "comments", missing: bare });
    if (p.sentAt !== null && p.sentRound === p.round && p.sentVersion === p.version && sameVerdicts(p.sent?.verdicts, verdicts)) return none(already(p.sentAt));
    await freeze(verdicts);
    const active = isActive(access, deps.now); // (an ended access: no "assessed" mail)
    const fixCount = verdicts.filter((v) => v === "fix").length;
    if (fixCount > 0) return { result: sentAs("fix", false), mail: active ? { kind: "assessed", fixCount } : null };
    const completed = await completeIfDone(t, access.id, deps.now);
    return { result: sentAs("passed", completed), mail: completed ? { kind: "completed" } : active ? { kind: "assessed" } : null };
  });
  if (done.result.kind === "sent") console.info(`[assessment] access ${input.accessId}: sent (${done.result.status}${done.result.completed ? ", completed" : ""})`);
  const mail = done.mail;
  if (mail) deps.later(() => mailAssessment(deps, input.accessId, mail));
  return done.result;
}

/** The student's mail of a send, after the commit: to whom and in which language is Task 4's completionJob, the sending mailCompletion (logged by the access's id). */
async function mailAssessment(deps: SendDeps, accessId: number, mail: AssessmentMail): Promise<void> {
  const job = await completionJob(deps.db, accessId);
  if (job) await mailCompletion(deps.env, deps.siteUrl, job, mail.kind, mail.fixCount);
}
