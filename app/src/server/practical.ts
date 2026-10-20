import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clients, courseAccess, practicalPhotos, protocols, type PracticalPhoto, type Protocol, type Verdict } from "@/db/schema";
import { courseSteps, PHOTO_LIMITS, PHOTOS_PER_POINT, practicalStatus, sentFixPoints, type PracticalStatus } from "@/domain/completion";
import { PROTOCOL_LIMITS, stagesFrom } from "@/domain/protocols";
import type { I18n } from "@/i18n/field";
import { accessFor, courseSetup, isActive, lockAccess, stepInputs, type AccessRow, type CourseSetup } from "./completion";
import { logFailure, logNote } from "./log";
import type { FileStore } from "./media";
import { practicalSubmittedSummary } from "./messages";
import { adminUrl, notifyMaria, type Env } from "./notify";

// The student's practical work of an e-course (e-course completion, spec §3.4, §3.5, §4.3, D4, D6): 1–3 photos for each course point, sent
// all at once ("Saada hindamiseks"), assessed by Maria in the protocol screen (server/assessment.ts). The practical work IS the access's
// protocol: made by the first photo (or Maria's first save, "Lisa protokoll") with a copy of the course's points; `round` counts her
// submissions, and Maria's sent copy carries a verdict per point. The photos are private objects practical/<uuid>.jpg and
// practical/<uuid>-t.jpg (the thumbnail), never served by /media (media.ts isMediaKey): the account API and the admin's photo route answer
// a 5-minute signed address (private-file.ts) to their student or to an admin only. Every write locks the access row first, then the
// protocol (the phase's lock order), so a double tap or a second device makes one round and never a fourth photo on a point. The files are
// stored before the row and removed again when the row is refused; removed photos' files go after the answer. Logs carry ids only.

export type PracticalDeps = { db: Db; env: Env; siteUrl: string; now: Date; later: (task: () => Promise<unknown>) => void; files: FileStore | null };

export type PhotoView = { id: number; round: number; width: number; height: number };

export type PointView = {
  index: number;
  title: string;
  /** From the SENT copy (what Maria sent), null before. */
  verdict: Verdict | null;
  /** Maria's sent note under it, "" without one. */
  note: string;
  /** The round shown: the one being prepared (round + 1) while open or "Paranda", else the last submitted. */
  photos: PhotoView[];
  /** Older rounds, newest first. */
  earlier: PhotoView[];
  /** The student may add a photo to this point now. */
  canAdd: boolean;
};

export type PracticalView = {
  course: { slug: string; title: I18n };
  status: PracticalStatus;
  round: number;
  /** Empty for an e-course without points. */
  points: PointView[];
  /** Maria's sent general note, "" without one. */
  generalNote: string;
  sentAt: string | null;
  /** The step is not open yet (the test not passed / the lessons not done). */
  locked: boolean;
  /** Nothing can be added or sent: the access has expired, or the course was completed before her work had a protocol (points added after it). */
  readOnly: boolean;
  /** No points: only Maria's sent notes (spec §4.3, last bullet). */
  notesOnly: boolean;
  /** course_access.completed_at (ISO): "Lõpetatud {date}" once every point is approved and the course completed; null before. */
  completedAt: string | null;
};

export type PhotoInput = { stage: number; full: File; thumb: File; width: number; height: number };

export type PhotoResult =
  | { kind: "added"; photo: PhotoView }
  | { kind: "full" } // 3 photos on that point in this round
  | { kind: "closed" } // locked, waiting, passed, expired, or an approved point
  | { kind: "invalid"; error: "type" | "size" | "content" | "stage" | "shape" }
  | { kind: "storage" } // no store, or the store refused
  | { kind: "notFound" };

export type SubmitPracticalResult = { kind: "submitted"; view: PracticalView } | { kind: "missing"; points: number[] } | { kind: "already" } | { kind: "closed" } | { kind: "notFound" };

/** The longest side the server takes: the browser sends at most PHOTO_LIMITS.maxEdge; up to twice that is still a photo, more is not one of ours. */
const MAX_SIDE = 4096;
const isSide = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_SIDE;

/** A JPEG's first bytes: FF D8 FF. */
function isJpeg(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(3, bytes.byteLength));
  return head.length === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

const photoView = (r: Pick<PracticalPhoto, "id" | "round" | "width" | "height">): PhotoView => ({ id: r.id, round: r.round, width: r.width, height: r.height });

const statusOf = (p: Protocol | null | undefined): PracticalStatus => practicalStatus(p ? { round: p.round, sentRound: p.sentRound, sent: p.sent } : null);

/**
 * Is the practical step still locked for this access (domain/completion.ts courseSteps: the test not passed, or no questions and the lessons
 * not done)? Asked as if the course had points: a protocol keeps its own copy of them (spec §3.4), whatever the course has now.
 */
async function stepLocked(db: Db, access: AccessRow, setup: CourseSetup): Promise<boolean> {
  const inputs = await stepInputs(db, access, setup);
  return courseSteps({ ...inputs, hasPoints: true }).practical?.state === "locked";
}

/**
 * A course completed while her work had no protocol (Maria added the points after it: the page-load heal completes a lessons-only finisher)
 * takes no practical work: "Hindamine" never lists a completed access, so a round sent now would wait for nobody (spec §4.4: a completed
 * course stays completed). A protocol made before the completion keeps the work as it is.
 */
const completedBefore = (access: Pick<AccessRow, "completedAt">, protocol: Protocol | null | undefined): boolean => access.completedAt !== null && !protocol;

/**
 * Her practical page (spec §4.3): the points (the protocol's copy, or the course's before there is one) with their photos and Maria's sent
 * verdicts and notes, the status, the round. Only the sent copy is read for what Maria wrote, never the draft. Read-only when the access has
 * ended, or the course was completed before her work had a protocol (completedBefore). null: no access (a revoked one), a contact course, or
 * an e-course without points with no notes-only protocol sent.
 */
export async function practicalView(db: Db, clientId: number, slug: string, now: Date): Promise<PracticalView | null> {
  const access = await accessFor(db, clientId, slug);
  if (!access || access.revokedAt !== null) return null;
  const setup = await courseSetup(db, access.courseId);
  const [p] = await db.select().from(protocols).where(eq(protocols.accessId, access.id)).limit(1);
  const titles = p ? p.stages.map((s) => s.title) : setup.points;
  const notesOnly = titles.length === 0;
  if (notesOnly && !p?.sent) return null;
  const status = statusOf(p);
  const round = p?.round ?? 0;
  const locked = !notesOnly && status === "open" && (await stepLocked(db, access, setup));
  const readOnly = !isActive(access, now) || completedBefore(access, p);
  const rows = p ? await db.select().from(practicalPhotos).where(eq(practicalPhotos.protocolId, p.id)).orderBy(desc(practicalPhotos.round), asc(practicalPhotos.id)) : [];
  const fix = sentFixPoints(p?.sent ?? null);
  const points = titles.map((title, index): PointView => {
    const mine = rows.filter((r) => r.stage === index);
    const preparing = status === "open" || (status === "fix" && fix.includes(index));
    // being prepared: the next round; else the newest submitted round that has photos of this point (an approved point keeps its own)
    const shownRound = preparing ? round + 1 : Math.max(0, ...mine.filter((r) => r.round <= round).map((r) => r.round));
    const shown = mine.filter((r) => r.round === shownRound);
    return {
      index,
      title,
      verdict: p?.sent?.verdicts?.[index] ?? null,
      note: p?.sent?.stages[index]?.note ?? "",
      photos: shown.map(photoView),
      earlier: mine.filter((r) => r.round < shownRound).map(photoView),
      canAdd: preparing && !locked && !readOnly && shown.length < PHOTOS_PER_POINT,
    };
  });
  return {
    course: { slug: access.course.slug, title: access.course.title },
    status,
    round,
    points,
    generalNote: p?.sent?.generalNote ?? "",
    sentAt: p?.sentAt ? p.sentAt.toISOString() : null,
    locked,
    readOnly,
    notesOnly,
    completedAt: access.completedAt ? access.completedAt.toISOString() : null,
  };
}

/** What she may do with her work now, decided under the access's lock with the protocol row read FOR UPDATE. */
type Work = { kind: "open"; protocol: Protocol | null; status: "open" | "fix"; points: number } | { kind: "already" } | { kind: "closed" };

/**
 * The access's work, under its lock: open (round 0, the step open: the test passed, or no questions and the lessons done) or fix → the
 * protocol (null before the first photo) and its number of points; review → already (a second "Saada" of the same round); passed, a step
 * still locked, no points, a course completed before the work had a protocol (completedBefore) → closed. `create`: the first photo makes the
 * protocol with the course's points and no verdicts — or finds the one Maria's first save made meanwhile (on conflict do nothing, then read).
 * `stage`: the point that first photo is for; a point the work does not have makes no row (the caller refuses the photo as `stage`), so a
 * refused photo never leaves an empty protocol behind.
 */
async function workOf(tx: Db, access: AccessRow, now: Date, create: boolean, stage?: number): Promise<Work> {
  const setup = await courseSetup(tx, access.courseId);
  const [found] = await tx.select().from(protocols).where(eq(protocols.accessId, access.id)).for("update");
  const points = found ? found.stages.length : setup.points.length;
  if (points === 0) return { kind: "closed" }; // an e-course without points has no practical work (spec §4.3)
  if (completedBefore(access, found)) return { kind: "closed" };
  const status = statusOf(found);
  if (status === "review") return { kind: "already" };
  if (status === "passed") return { kind: "closed" };
  if (status === "open" && (await stepLocked(tx, access, setup))) return { kind: "closed" };
  if (found || !create || (stage !== undefined && stage >= points)) return { kind: "open", protocol: found ?? null, status, points };
  await tx
    .insert(protocols)
    .values({ accessId: access.id, stages: stagesFrom(setup.points), verdicts: setup.points.map(() => null), createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: protocols.accessId });
  const [made] = await tx.select().from(protocols).where(eq(protocols.accessId, access.id)).for("update");
  return { kind: "open", protocol: made, status, points: made.stages.length };
}

/**
 * One photo for a point (spec §4.3, §7): checks the JPEG (FF D8 FF, the full one ≤ 2 MB, the thumbnail ≤ 200 KB, 1–4096 px a side, a point
 * that can be), stores both files, then in one transaction — the access locked, the protocol (made by the first photo) read FOR UPDATE —
 * checks that the point may take a photo of this round (every point while open, only a "Paranda" point after Maria's assessment) and the cap
 * of 3, and writes the row. Refused after storing, or failed: both files are removed again.
 */
export async function addPhoto(deps: PracticalDeps, clientId: number, slug: string, input: PhotoInput): Promise<PhotoResult> {
  const { full, thumb } = input;
  if (full.type !== "image/jpeg" || thumb.type !== "image/jpeg") return { kind: "invalid", error: "type" };
  if (full.size === 0 || full.size > PHOTO_LIMITS.fullBytes || thumb.size === 0 || thumb.size > PHOTO_LIMITS.thumbBytes) return { kind: "invalid", error: "size" };
  if (!isSide(input.width) || !isSide(input.height)) return { kind: "invalid", error: "shape" };
  if (!Number.isInteger(input.stage) || input.stage < 0 || input.stage >= PROTOCOL_LIMITS.stages) return { kind: "invalid", error: "stage" };
  const [fullBytes, thumbBytes] = await Promise.all([full.arrayBuffer(), thumb.arrayBuffer()]);
  if (!isJpeg(fullBytes) || !isJpeg(thumbBytes)) return { kind: "invalid", error: "content" };
  // a first look before anything is stored (decided again under the lock)
  const known = await accessFor(deps.db, clientId, slug);
  if (!known || known.revokedAt !== null) return { kind: "notFound" };
  if (!isActive(known, deps.now)) return { kind: "closed" };
  const label = `[practical] access ${known.id}`;
  const store = deps.files;
  if (!store) {
    logNote(`${label}: a photo refused, no file store (production needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET)`);
    return { kind: "storage" };
  }
  const id = crypto.randomUUID();
  const key = `practical/${id}.jpg`;
  const thumbKey = `practical/${id}-t.jpg`;
  try {
    await store.put(key, fullBytes, "image/jpeg");
    await store.put(thumbKey, thumbBytes, "image/jpeg");
  } catch (e) {
    logFailure(`${label}: a photo could not be stored`, e);
    await removeKeys(store, [key, thumbKey], label);
    return { kind: "storage" };
  }
  let result: PhotoResult;
  try {
    result = await deps.db.transaction(async (t): Promise<PhotoResult> => {
      const tx = t as unknown as Db;
      const access = await lockAccess(tx, known.id);
      if (!access || access.revokedAt !== null) return { kind: "notFound" };
      if (!isActive(access, deps.now)) return { kind: "closed" };
      const work = await workOf(tx, access, deps.now, true, input.stage);
      if (work.kind !== "open") return { kind: "closed" };
      if (input.stage >= work.points) return { kind: "invalid", error: "stage" }; // a point the work does not have: workOf made no row for it
      const p = work.protocol;
      if (!p) return { kind: "closed" };
      if (work.status === "fix" && !sentFixPoints(p.sent).includes(input.stage)) return { kind: "closed" }; // an approved point
      const round = p.round + 1;
      const [{ n }] = await tx
        .select({ n: count() })
        .from(practicalPhotos)
        .where(and(eq(practicalPhotos.protocolId, p.id), eq(practicalPhotos.stage, input.stage), eq(practicalPhotos.round, round)));
      if (n >= PHOTOS_PER_POINT) return { kind: "full" };
      const [row] = await tx
        .insert(practicalPhotos)
        .values({ protocolId: p.id, stage: input.stage, round, key, thumbKey, size: full.size, width: input.width, height: input.height, createdAt: deps.now })
        .returning();
      return { kind: "added", photo: photoView(row) };
    });
  } catch (e) {
    // the files must not stay in the private bucket with nothing pointing at them; the error that comes out is the database's
    await removeKeys(store, [key, thumbKey], label);
    throw e;
  }
  if (result.kind !== "added") await removeKeys(store, [key, thumbKey], label);
  return result;
}

/**
 * Removes a photo of the round being prepared (spec §4.3): open, or a "Paranda" point after Maria's assessment. Its row goes under the
 * access's lock; its files after the answer. A photo of a submitted round stays (history, spec §3.5): closed. notFound: not hers.
 */
export async function removePhoto(deps: PracticalDeps, clientId: number, slug: string, photoId: number): Promise<{ kind: "removed" } | { kind: "closed" } | { kind: "notFound" }> {
  const known = await accessFor(deps.db, clientId, slug);
  if (!known || known.revokedAt !== null) return { kind: "notFound" };
  const result = await deps.db.transaction(async (t): Promise<{ kind: "removed"; keys: string[] } | { kind: "closed" } | { kind: "notFound" }> => {
    const tx = t as unknown as Db;
    const access = await lockAccess(tx, known.id);
    if (!access || access.revokedAt !== null) return { kind: "notFound" };
    const [p] = await tx.select().from(protocols).where(eq(protocols.accessId, access.id)).for("update");
    if (!p) return { kind: "notFound" };
    const [photo] = await tx.select().from(practicalPhotos).where(and(eq(practicalPhotos.id, photoId), eq(practicalPhotos.protocolId, p.id))).limit(1);
    if (!photo) return { kind: "notFound" };
    if (!isActive(access, deps.now)) return { kind: "closed" };
    const status = statusOf(p);
    const preparing = photo.round === p.round + 1 && (status === "open" || (status === "fix" && sentFixPoints(p.sent).includes(photo.stage)));
    if (!preparing) return { kind: "closed" };
    await tx.delete(practicalPhotos).where(eq(practicalPhotos.id, photo.id));
    return { kind: "removed", keys: [photo.key, photo.thumbKey] };
  });
  if (result.kind !== "removed") return result;
  const store = deps.files;
  const keys = result.keys;
  deps.later(() => removeKeys(store, keys, `[practical] access ${known.id}`));
  return { kind: "removed" };
}

/** The transaction's outcome of a send: a refusal, or the round sent and who to name in Maria's notice. */
type Sent = Exclude<SubmitPracticalResult, { kind: "submitted" }> | { kind: "sent"; round: number; who: { name: string; email: string } | null };

/**
 * "Saada hindamiseks" / "Saada uuesti" (spec §4.3, D4, R3), under the access's lock: every point (the first round) or every "Paranda" point
 * (later rounds) needs a photo of the new round (else `missing`, with the points' 0-based positions). Then round + 1, submitted_at = now, the
 * fix points' verdicts back to null in Maria's draft (the notes and their version are not touched); her sent copy stays what the student is
 * shown until Maria sends again. A second send of the same round: `already`. Maria is told after the answer (mail and Telegram, Reply-To the
 * student; a sample student too: her live check needs it).
 */
export async function submitPractical(deps: PracticalDeps, clientId: number, slug: string): Promise<SubmitPracticalResult> {
  const known = await accessFor(deps.db, clientId, slug);
  if (!known || known.revokedAt !== null) return { kind: "notFound" };
  const done = await deps.db.transaction(async (t): Promise<Sent> => {
    const tx = t as unknown as Db;
    const access = await lockAccess(tx, known.id);
    if (!access || access.revokedAt !== null) return { kind: "notFound" };
    if (!isActive(access, deps.now)) return { kind: "closed" };
    const work = await workOf(tx, access, deps.now, false);
    if (work.kind !== "open") return work;
    const p = work.protocol;
    const required = work.status === "fix" ? sentFixPoints(p?.sent ?? null) : Array.from({ length: work.points }, (_, i) => i);
    const round = (p?.round ?? 0) + 1;
    const have = p
      ? new Set(
          (await tx.selectDistinct({ stage: practicalPhotos.stage }).from(practicalPhotos).where(and(eq(practicalPhotos.protocolId, p.id), eq(practicalPhotos.round, round)))).map((r) => r.stage),
        )
      : new Set<number>();
    const missing = required.filter((i) => !have.has(i));
    if (!p || missing.length > 0) return { kind: "missing", points: missing };
    const verdicts = p.stages.map((_, i) => (required.includes(i) ? null : (p.verdicts[i] ?? null)));
    await tx.update(protocols).set({ round, submittedAt: deps.now, verdicts }).where(eq(protocols.id, p.id));
    const [who] = await tx.select({ name: clients.name, email: clients.email }).from(clients).where(eq(clients.id, clientId)).limit(1);
    return { kind: "sent", round, who: who ?? null };
  });
  if (done.kind !== "sent") return done;
  console.info(`[practical] access ${known.id}: submitted (round ${done.round})`);
  if (done.who) {
    const notice = { accessId: known.id, name: done.who.name.trim() || done.who.email, email: done.who.email, course: known.course.title.et, round: done.round };
    deps.later(async () => {
      const s = practicalSubmittedSummary(notice, adminUrl(deps.siteUrl));
      const r = await notifyMaria(deps.env, s.subject, s.text, { short: s.short, replyTo: notice.email, siteUrl: deps.siteUrl, count: deps.db });
      console.info(`[practical] access ${notice.accessId}: Maria notified by e-mail: ${r.mail}, Telegram: ${r.telegram}`);
    });
  }
  const view = await practicalView(deps.db, clientId, slug, deps.now);
  return view ? { kind: "submitted", view } : { kind: "notFound" };
}

/**
 * A photo's two keys for whoever may see it: the student of its access (not a revoked one; an expired access still reads its results), or
 * an admin (any photo). null otherwise.
 */
export async function photoFor(db: Db, who: { clientId: number } | { admin: true }, photoId: number): Promise<{ key: string; thumbKey: string } | null> {
  const fields = { key: practicalPhotos.key, thumbKey: practicalPhotos.thumbKey };
  if ("admin" in who) {
    const [row] = await db.select(fields).from(practicalPhotos).where(eq(practicalPhotos.id, photoId)).limit(1);
    return row ?? null;
  }
  const [row] = await db
    .select(fields)
    .from(practicalPhotos)
    .innerJoin(protocols, eq(practicalPhotos.protocolId, protocols.id))
    .innerJoin(courseAccess, eq(protocols.accessId, courseAccess.id))
    .where(and(eq(practicalPhotos.id, photoId), eq(courseAccess.clientId, who.clientId), isNull(courseAccess.revokedAt)))
    .limit(1);
  return row ?? null;
}

/** Every photo file (full and thumbnail) of a client's protocols: read in deleteClient's transaction, removed from the store after its commit. */
export async function practicalKeys(db: Db, clientId: number): Promise<string[]> {
  const rows = await db
    .select({ key: practicalPhotos.key, thumbKey: practicalPhotos.thumbKey })
    .from(practicalPhotos)
    .innerJoin(protocols, eq(practicalPhotos.protocolId, protocols.id))
    .innerJoin(courseAccess, eq(protocols.accessId, courseAccess.id))
    .where(eq(courseAccess.clientId, clientId));
  return rows.flatMap((r) => [r.key, r.thumbKey]);
}

/** Removes the files from the store, each on its own: a failure is logged by `label` (ids only, never a key) and the rest go on. Never throws. */
export async function removeKeys(store: FileStore | null, keys: readonly string[], label: string): Promise<void> {
  if (keys.length === 0) return;
  if (!store) {
    logNote(`${label}: no file store, ${keys.length} photo files not removed`);
    return;
  }
  for (const key of keys) {
    try {
      await store.delete(key);
    } catch (e) {
      logFailure(`${label}: a photo file could not be removed`, e);
    }
  }
}
