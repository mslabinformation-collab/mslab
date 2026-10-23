import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AttemptStatus, TestQuestion } from "../../src/db/schema";
import { localStore } from "../../src/server/media-local";
import { accountCourseSlug, onLocalDb } from "./fixtures";

// The e-course completion's e2e rows (completion.spec.ts, completion-race.spec.ts): an e-course of the test's own, not published, with one text
// lesson, Maria's test and points, a six-month access and the course terms of version "1" accepted; attempts, a practical work with its photos
// (in the local store of the e2e run's server: app/.media-local) and a contact registration, as a test needs them. Every address is
// `e2e-client-compl-<label>-<project>@example.test`: a sample address (never mailed) that fixtures.ts removeClientRows removes with everything it
// made, the photo files included; the course's slug is the address's (accountCourseSlug), so it goes too. Nothing here is on a public page.
// And the photo fixtures: a picture drawn on a canvas in the test's own browser, with a made-up EXIF block written in here (no binary in the
// repository, no real person or place).

/** The local database for rows no public page shows. */
const localDb = <T>(work: Parameters<typeof onLocalDb<T>>[0]): Promise<T> => onLocalDb(work, { marksPages: false });

/** The e2e run's server keeps the photos here (server/media-local.ts: `next dev`, and the local production build with MEDIA_LOCAL=1). */
const files = () => localStore(join(process.cwd(), ".media-local"));
const arrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export const E2E_POINTS = ["Ettevalmistus", "Värvimine"];
/** Two choice questions, one correct option each (`a`); ids as the course editor makes them ([0-9a-z]). */
export const E2E_QUESTIONS: TestQuestion[] = [
  { id: "q1", kind: "choice", text: "Mitu korda pesta pintslit?", options: [{ id: "a", text: "Pärast igat kasutust", correct: true }, { id: "b", text: "Kord nädalas", correct: false }] },
  { id: "q2", kind: "choice", text: "Millest algab kulmude kuju?", options: [{ id: "a", text: "Näo proportsioonidest", correct: true }, { id: "b", text: "Moest", correct: false }] },
];
/** Two open questions, for Maria's review. */
export const E2E_OPEN: TestQuestion[] = [
  { id: "q3", kind: "open", text: "Kirjelda oma tööde järjekorda." },
  { id: "q4", kind: "open", text: "Mida teed, kui kliendil tekib allergia?" },
];

export type CompletionCourse = { clientId: number; accessId: number; slug: string; courseId: number; lessonId: number };

/**
 * A client ("Kati Kask" unless `name`) with six months of access to an e-course of her own ("E2E lõpetamine", not published) of one text lesson
 * (done when `lessonsDone`), `questions` (none by default: a course without a test) with the pass mark 80 and 3 tries unless given, and `points`
 * (E2E_POINTS by default; [] for a course without practical work); the course terms of version "1" accepted.
 */
export async function insertCompletionCourse(
  email: string,
  opts: { locale?: "et" | "ru"; questions?: TestQuestion[]; points?: string[]; lessonsDone?: boolean; name?: string; passPercent?: number; tries?: number } = {},
): Promise<CompletionCourse> {
  const slug = accountCourseSlug(email);
  const questions = opts.questions ?? [];
  return localDb(async (sql) => {
    const [client] = await sql<{ id: number }[]>`insert into clients (email, name, locale) values (${email}, ${opts.name ?? "Kati Kask"}, ${opts.locale ?? "et"}) returning id`;
    const [course] = await sql<{ id: number }[]>`
      insert into courses (slug, type, level, title, summary, body, price, access_months, published, protocol_stages)
      values (${slug}, 'e_learning', 'basic', ${sql.json({ et: "E2E lõpetamine", ru: "E2E завершение" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 9500, 6, false,
              ${sql.json(opts.points ?? E2E_POINTS)})
      returning id`;
    if (questions.length > 0)
      await sql`insert into course_tests (course_id, questions, pass_percent, tries) values (${course.id}, ${sql.json(questions)}, ${opts.passPercent ?? 80}, ${opts.tries ?? 3})`;
    const [m] = await sql<{ id: number }[]>`insert into course_modules (course_id, position, title) values (${course.id}, 1, ${sql.json({ et: "Alustame", ru: "Начинаем" })}) returning id`;
    const [lesson] = await sql<{ id: number }[]>`
      insert into lessons (module_id, position, title, body, kind)
      values (${m.id}, 1, ${sql.json({ et: "Ainus tund", ru: "Единственный урок" })}, ${sql.json({ et: "Loe läbi ja märgi tehtuks." })}, 'text') returning id`;
    const [access] = await sql<{ id: number }[]>`
      insert into course_access (client_id, course_id, granted_by, expires_at) values (${client.id}, ${course.id}, 'e2e', now() + interval '6 months') returning id`;
    await sql`insert into terms_acceptances (client_id, course_id, terms_version) values (${client.id}, ${course.id}, '1')`;
    if (opts.lessonsDone) await sql`insert into lesson_progress (client_id, lesson_id, watched_sec, done_at) values (${client.id}, ${lesson.id}, 0, now())`;
    return { clientId: client.id, accessId: access.id, slug, courseId: course.id, lessonId: lesson.id };
  });
}

/** Her attempts, numbered 1… in `list`'s order an hour apart (the last an hour ago), each with `questions` as its copy; their ids. */
export async function insertAttempts(clientId: number, courseId: number, questions: TestQuestion[], list: { status: AttemptStatus; correct: number; total: number }[]): Promise<number[]> {
  const answers = Object.fromEntries(questions.map((q) => [q.id, q.kind === "choice" ? [q.options[0].id] : "Minu vastus."]));
  return localDb(async (sql) => {
    const ids: number[] = [];
    for (const [i, a] of list.entries()) {
      const [row] = await sql<{ id: number }[]>`
        insert into test_attempts (client_id, course_id, number, questions, answers, correct, total, status, submitted_at)
        values (${clientId}, ${courseId}, ${i + 1}, ${sql.json(questions)}, ${sql.json(answers)}, ${a.correct}, ${a.total}, ${a.status}, now() - make_interval(hours => ${list.length - i}::int))
        returning id`;
      ids.push(row.id);
    }
    return ids;
  });
}

/** A JPEG and its picture's size. */
export type Jpeg = { bytes: Buffer; width: number; height: number };

/**
 * Her practical work: `round` submissions so far (0: a round being prepared), the last two hours ago; `photos` each a copy of `jpeg` (full and
 * thumbnail) in the local store; with `sent`, Maria's assessment of `round` sent an hour ago (her notes under the points, the verdicts frozen
 * into the sent copy and kept in the draft, as server/assessment.ts sendAssessment leaves them).
 */
export async function insertPractical(
  accessId: number,
  points: string[],
  jpeg: Jpeg,
  seed: { round: number; photos: { stage: number; round: number }[]; sent?: { verdicts: ("ok" | "fix")[]; notes: string[] } },
): Promise<{ protocolId: number; photoIds: number[] }> {
  const stages = points.map((title, i) => ({ title, note: seed.sent?.notes[i] ?? "" }));
  const verdicts = points.map((_, i) => seed.sent?.verdicts[i] ?? null);
  const stored: { stage: number; round: number; key: string; thumbKey: string }[] = [];
  for (const p of seed.photos) {
    const id = crypto.randomUUID();
    const key = `practical/${id}.jpg`;
    const thumbKey = `practical/${id}-t.jpg`;
    for (const k of [key, thumbKey]) await files().put(k, arrayBuffer(jpeg.bytes), "image/jpeg");
    stored.push({ ...p, key, thumbKey });
  }
  const submittedAt = seed.round > 0 ? new Date(Date.now() - 2 * 3_600_000) : null;
  const sentAt = seed.sent ? new Date(Date.now() - 3_600_000) : null;
  return localDb(async (sql) => {
    const [protocol] = await sql<{ id: number }[]>`
      insert into protocols (access_id, stages, general_note, version, verdicts, round, submitted_at, sent, sent_at, sent_version, sent_round)
      values (${accessId}, ${sql.json(stages)}, '', 1, ${sql.json(verdicts)}, ${seed.round}, ${submittedAt},
              ${seed.sent ? sql.json({ stages, generalNote: "", verdicts }) : null}, ${sentAt}, ${seed.sent ? 1 : null}, ${seed.sent ? seed.round : null})
      returning id`;
    const photoIds: number[] = [];
    for (const p of stored) {
      const [row] = await sql<{ id: number }[]>`
        insert into practical_photos (protocol_id, stage, round, key, thumb_key, size, width, height)
        values (${protocol.id}, ${p.stage}, ${p.round}, ${p.key}, ${p.thumbKey}, ${jpeg.bytes.length}, ${jpeg.width}, ${jpeg.height})
        returning id`;
      photoIds.push(row.id);
    }
    return { protocolId: protocol.id, photoIds };
  });
}

/**
 * A contact course of the test's own (not published; its slug is `courseEmail`'s, so removeClientRows(courseEmail) removes it with its session)
 * with E2E_POINTS and one session in two weeks, and her confirmed group registration on it, linked to her account; the registration's id.
 */
export async function insertContactRegistration(email: string, clientId: number, courseEmail: string): Promise<number> {
  return localDb(async (sql) => {
    const [course] = await sql<{ id: number }[]>`
      insert into courses (slug, type, level, title, summary, body, price_group, published, protocol_stages)
      values (${accountCourseSlug(courseEmail)}, 'contact', 'basic', ${sql.json({ et: "E2E kontaktkoolitus" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 35000, false,
              ${sql.json(E2E_POINTS)})
      returning id`;
    const [session] = await sql<{ id: number }[]>`
      insert into course_sessions (course_id, starts_at, city, venue, capacity) values (${course.id}, now() + interval '14 days', 'Pärnu', 'MS LAB stuudio', 6) returning id`;
    const [r] = await sql<{ id: number }[]>`
      insert into registrations (course_id, course_session_id, kind, name, email, phone, payment_choice, status, paid_cents, client_id)
      values (${course.id}, ${session.id}, 'group', 'Kati Kask', ${email}, '+372 5555 0101', 'full', 'confirmed', 35000, ${clientId})
      returning id`;
    return r.id;
  });
}

export type StoredAttempt = {
  id: number;
  number: number;
  status: AttemptStatus;
  correct: number;
  total: number;
  answers: Record<string, string[] | string>;
  review: Record<string, { verdict: string; comment: string }> | null;
};

/** Her attempts at any test, by number. */
export async function storedAttempts(clientId: number): Promise<StoredAttempt[]> {
  return localDb((sql) => sql<StoredAttempt[]>`select id, number, status, correct, total, answers, review from test_attempts where client_id = ${clientId} order by number`);
}

/** Maria's autosaved marks on an attempt (B15: the draft of the review, entity "test_review"): empty once the review is sent. */
export type StoredMarks = { version: number; value: { submittedAt: string; marks: Record<string, { verdict: "ok" | "fix" | null; comment: string }> } };
export async function storedMarks(attemptId: number): Promise<StoredMarks[]> {
  return localDb((sql) => sql<StoredMarks[]>`select version, value from content_drafts where entity = 'test_review' and entity_id = ${attemptId}`);
}

type Stage = { title: string; note: string };
export type StoredPractical = {
  id: number;
  round: number;
  sentRound: number | null;
  verdicts: ("ok" | "fix" | null)[];
  stages: Stage[];
  generalNote: string;
  sent: { stages: Stage[]; generalNote: string; verdicts?: ("ok" | "fix" | null)[] } | null;
  submittedAt: Date | null;
};

/** The access's protocol (her practical work and Maria's assessment) as stored, or null when there is none. */
export async function storedProtocolOf(accessId: number): Promise<StoredPractical | null> {
  const [row] = await localDb(
    (sql) => sql<StoredPractical[]>`
      select id, round, sent_round as "sentRound", verdicts, stages, general_note as "generalNote", sent, submitted_at as "submittedAt" from protocols where access_id = ${accessId}`,
  );
  return row ?? null;
}

export type StoredPhoto = { id: number; stage: number; round: number; key: string; thumbKey: string; size: number; width: number; height: number };

/** The protocol's photo rows, oldest first. */
export async function storedPhotos(protocolId: number): Promise<StoredPhoto[]> {
  return localDb(
    (sql) => sql<StoredPhoto[]>`select id, stage, round, key, thumb_key as "thumbKey", size, width, height from practical_photos where protocol_id = ${protocolId} order by id`,
  );
}

/** The access's extra tries and its completion. */
export async function storedAccessRow(accessId: number): Promise<{ extraTries: number; completedAt: Date | null }> {
  const [row] = await localDb((sql) => sql<{ extraTries: number; completedAt: Date | null }[]>`select extra_tries as "extraTries", completed_at as "completedAt" from course_access where id = ${accessId}`);
  return row;
}

/** A stored photo's file, as the e2e run's server wrote it (app/.media-local/<key>). */
export const localFile = (key: string): Buffer => readFileSync(join(process.cwd(), ".media-local", ...key.split("/")));

// ---------- the photo fixtures ----------

/**
 * A JPEG drawn in `page`'s browser (any page, about:blank too): soft gradients, an arrow that points up (a turned picture shows it), and with
 * `grain` a fine noise all over, as a phone's sensor gives (it keeps a 6000×4000 picture megabytes large). Encoded by the canvas: no metadata.
 */
export async function canvasJpeg(page: Page, width: number, height: number, opts: { grain?: boolean } = {}): Promise<Jpeg> {
  const dataUrl = await page.evaluate(
    async ({ width, height, grain }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext("2d")!;
      const sky = g.createLinearGradient(0, 0, width, height);
      sky.addColorStop(0, "#d9c7cf");
      sky.addColorStop(0.5, "#8fa6b8");
      sky.addColorStop(1, "#4f5d46");
      g.fillStyle = sky;
      g.fillRect(0, 0, width, height);
      g.fillStyle = "#222222";
      const u = Math.min(width, height) / 10;
      g.beginPath();
      g.moveTo(width / 2, u);
      g.lineTo(width / 2 + 2 * u, 4 * u);
      g.lineTo(width / 2 - 2 * u, 4 * u);
      g.closePath();
      g.fill();
      g.fillRect(width / 2 - u / 2, 4 * u, u, 4 * u);
      if (grain) {
        const tile = document.createElement("canvas");
        tile.width = 256;
        tile.height = 256;
        const t = tile.getContext("2d")!;
        const noise = t.createImageData(256, 256);
        let seed = 7;
        for (let i = 0; i < noise.data.length; i += 4) {
          seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
          const v = seed >>> 24;
          noise.data[i] = noise.data[i + 1] = noise.data[i + 2] = v;
          noise.data[i + 3] = 24;
        }
        t.putImageData(noise, 0, 0);
        g.fillStyle = g.createPattern(tile, "repeat")!;
        g.fillRect(0, 0, width, height);
      }
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the canvas gave no JPEG"))), "image/jpeg", 0.92));
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    },
    { width, height, grain: opts.grain ?? false },
  );
  return { bytes: Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"), width, height };
}

const EXIF_ID = Buffer.from("Exif\0\0", "latin1");

/**
 * A phone's EXIF block (an APP1 segment), made up: the GPS position 1°2'3" N, 4°5'6" E (at sea) and, when given, the orientation tag (6: the
 * phone was held sideways). A big-endian TIFF: IFD0 (the orientation, the pointer to the GPS IFD), the GPS IFD (version, latitude, longitude),
 * then the six rationals; every offset counts from the TIFF header.
 */
function exifSegment(opts: { orientation?: number }): Buffer {
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n);
    return b;
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  /** One 12-byte entry; `value` is the value itself when it fits in 4 bytes (left-aligned), else the offset of the value. */
  const entry = (tag: number, type: number, count: number, value: Buffer) => Buffer.concat([u16(tag), u16(type), u32(count), Buffer.concat([value, Buffer.alloc(4)]).subarray(0, 4)]);
  const ifd = (entries: Buffer[]) => Buffer.concat([u16(entries.length), ...entries, u32(0)]); // (no next IFD)
  const [BYTE, ASCII, SHORT, LONG, RATIONAL] = [1, 2, 3, 4, 5];
  const ifd0Entries = opts.orientation ? 2 : 1;
  const gpsAt = 8 + 2 + ifd0Entries * 12 + 4;
  const latitudeAt = gpsAt + 2 + 5 * 12 + 4;
  const longitudeAt = latitudeAt + 24;
  const rationals = (values: number[]) => Buffer.concat(values.flatMap((v) => [u32(v), u32(1)]));
  const tiff = Buffer.concat([
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]), // "MM", 42, IFD0 at 8
    ifd([...(opts.orientation ? [entry(0x0112, SHORT, 1, u16(opts.orientation))] : []), entry(0x8825, LONG, 1, u32(gpsAt))]),
    ifd([
      entry(0x0000, BYTE, 4, Buffer.from([2, 2, 0, 0])),
      entry(0x0001, ASCII, 2, Buffer.from("N\0", "latin1")),
      entry(0x0002, RATIONAL, 3, u32(latitudeAt)),
      entry(0x0003, ASCII, 2, Buffer.from("E\0", "latin1")),
      entry(0x0004, RATIONAL, 3, u32(longitudeAt)),
    ]),
    rationals([1, 2, 3]),
    rationals([4, 5, 6]),
  ]);
  const payload = Buffer.concat([EXIF_ID, tiff]);
  return Buffer.concat([u16(0xffe1), u16(payload.length + 2), payload]);
}

/** `jpeg` with a made-up EXIF block (GPS, and `orientation` when given) after its JFIF segment, as a camera's "JFIF + Exif" file has it. */
export function withExif(jpeg: Buffer, opts: { orientation?: number } = {}): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG");
  const at = jpeg[2] === 0xff && jpeg[3] === 0xe0 ? 4 + jpeg.readUInt16BE(4) : 2;
  return Buffer.concat([jpeg.subarray(0, at), exifSegment(opts), jpeg.subarray(at)]);
}

/** Does the JPEG carry an EXIF block? Its segments are walked up to the picture's data (SOS), where no metadata comes any more. */
export function hasExif(jpeg: Buffer): boolean {
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1];
    if (marker === 0xda || marker === 0xd9) return false;
    if (marker === 0xe1 && jpeg.subarray(i + 4, i + 10).equals(EXIF_ID)) return true;
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return false;
}

/** The picture's size as `page`'s browser decodes it. */
export async function jpegSize(page: Page, jpeg: Buffer): Promise<{ width: number; height: number }> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }, jpeg.toString("base64"));
}
