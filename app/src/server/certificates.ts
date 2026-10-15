import { and, count, desc, eq, getTableColumns, isNull, max, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { paged, setSetting, type Paged } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import { certificates, courseAccess, courses, type Certificate } from "@/db/schema";
import {
  CERT_LIMITS, certificateSkills, checkCertificateName, formatCertificateNumber, nextNumber, readCertificateSettings, tallinnYear, type CertificateSettings,
} from "@/domain/certificate";
import { PAGE_SIZE } from "@/domain/paging";
import { toStorable } from "@/lib/to-storable";
import { loadCertificateAssets, renderCertificate } from "./certificate-pdf";
import { accessFor, lockAccess } from "./completion";

// The e-course certificate (phase 3d, spec §3–§7), without Next.js: the issue (one per completed access, numbered in Maria's own series), the
// re-issue under the same number ("Paranda nimi"), the student's and Maria's reads, Seaded → Tunnistus (the settings key `certificate`) and
// the register. Every write of the number series — an issue, Seaded's save — holds the transaction lock `certificate-number`
// (pg_advisory_xact_lock), and an issue locks its access row before it (completion.ts lockAccess, the first lock of every write about one
// access): two issues of one access go one after the other and the second finds the first's certificate; two of different accesses get two
// numbers; the unique (year, seq) is the backstop. A certificate prints its own frozen copy, never the course or Seaded as they are now,
// except the trainer's name — Maria's signature, typed in the script font — which each download reads. No picture of a signature is drawn.
// Logs carry ids and numbers only, never a name.

/** The settings key of Seaded → Tunnistus: CertificateSettings, all six keys. */
const SETTING_KEY = "certificate";
/** The number series' transaction lock (hashtext of this): every write that reads and rewrites the setting holds it. */
const NUMBER_LOCK = "certificate-number";
/** "Järgmine number": a year Maria can mean, and a number below six digits. */
const YEAR_MIN = 2000;
const YEAR_MAX = 2099;
const SEQ_MAX = 99_999;

export type CertificateView = { id: number; number: string; name: string; issuedAt: string; reissuedAt: string | null };

export type IssueResult =
  | { kind: "issued"; certificate: CertificateView }
  | { kind: "already"; certificate: CertificateView }
  | { kind: "notCompleted" }
  | { kind: "invalid"; error: "length" | "letters" }
  | { kind: "notFound" };

export type RegisterRow = { id: number; number: string; name: string; course: string; issuedAt: Date; reissuedAt: Date | null; revoked: boolean; clientId: number };

/**
 * Seaded's refusal of one field (saveCertificateSettings): "required" empty, "tooLong" over its CERT_LIMITS, "invalid" no year 2000–2099
 * or no number 1–99 999 (both under `nextSeq`), "taken" a number at or below one already issued in that year; on `trainerName` also the
 * name rules' "letters" and "length" (checkCertificateName: the trainer's name is the signature the script font writes).
 */
export type CertificateFieldError = "required" | "tooLong" | "invalid" | "taken" | "letters" | "length";

type SaveResult = { ok: true; settings: CertificateSettings } | { ok: false; fields: Record<string, string> };

/** What the pages get of a certificate row (ISO times). */
const viewOf = (c: Pick<Certificate, "id" | "number" | "name" | "issuedAt" | "reissuedAt">): CertificateView => ({
  id: c.id,
  number: c.number,
  name: c.name,
  issuedAt: c.issuedAt.toISOString(),
  reissuedAt: c.reissuedAt ? c.reissuedAt.toISOString() : null,
});

/** Waits for and takes the number series' lock; it is held to the end of `tx`'s transaction. */
const lockNumbers = (tx: Db) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${NUMBER_LOCK}))`);

/** Seaded's certificate settings as stored, or the defaults (domain/certificate.ts readCertificateSettings); inside a write, after lockNumbers. */
const readSettings = async (q: Db, now: Date): Promise<CertificateSettings> => readCertificateSettings(await readSetting(q, SETTING_KEY), now);

/**
 * "Kinnita ja koosta tunnistus" (spec §4, §5): the certificate of her completed access to the e-course `slug`, with `rawName` as she confirmed
 * it. A name the rules refuse (domain/certificate.ts checkCertificateName) is `invalid` before anything is read. Then ONE transaction:
 * - the access row is locked (lockAccess). A revoked access is `notFound`; an expired one issues, since she completed it. One without
 *   completed_at is `notCompleted`. One that has a certificate is `already`, with that one's view (a double tap, a second device). These
 *   answers need only the access's lock, so they never wait for the number series;
 * - otherwise the course's copy is read, the number series locked, Seaded read and the number taken: nextNumber for the Tallinn year of
 *   `now`, a new year starting at 1;
 * - the frozen copy is written: the course's Estonian title, its certificate lines (certificateSkills: its own, else "Mida õpid") and its
 *   volume, and Seaded's practical line, place and registry code;
 * - Seaded's next number is moved on.
 * `notFound` also without an access, and for a contact course (accessFor). Logs `[certificate] access N: issued <number>` after the commit.
 */
export async function issueCertificate(db: Db, clientId: number, slug: string, rawName: string, now: Date): Promise<IssueResult> {
  const checked = checkCertificateName(rawName);
  if (!checked.ok) return { kind: "invalid", error: checked.error };
  const known = await accessFor(db, clientId, slug);
  if (!known) return { kind: "notFound" };
  const result = await db.transaction(async (t): Promise<IssueResult> => {
    const tx = t as unknown as Db;
    const access = await lockAccess(tx, known.id);
    if (!access || access.revokedAt !== null) return { kind: "notFound" };
    if (access.completedAt === null) return { kind: "notCompleted" };
    const [existing] = await tx.select().from(certificates).where(eq(certificates.accessId, access.id)).limit(1);
    if (existing) return { kind: "already", certificate: viewOf(existing) };
    const [course] = await tx
      .select({ title: courses.title, certificateSkills: courses.certificateSkills, certificateVolume: courses.certificateVolume, outcomes: courses.outcomes })
      .from(courses)
      .where(eq(courses.id, access.courseId))
      .limit(1);
    if (!course) return { kind: "notFound" };
    // the series' lock after the access's, always in this order: no two writes ever wait for each other the other way round
    await lockNumbers(tx);
    const settings = await readSettings(tx, now);
    const { year, seq, next } = nextNumber(settings, tallinnYear(now));
    const [row] = await tx
      .insert(certificates)
      .values({
        accessId: access.id,
        number: formatCertificateNumber(year, seq),
        year,
        seq,
        name: checked.name,
        courseTitle: course.title.et,
        skills: certificateSkills(course),
        volume: course.certificateVolume.trim(),
        practicalLine: settings.practicalLine,
        place: settings.place,
        registryCode: settings.registryCode,
        issuedAt: now,
      })
      .returning(); // (returning(fields) has no common overload on the Db union: the whole row)
    await setSetting(tx, SETTING_KEY, { ...settings, ...next });
    return { kind: "issued", certificate: viewOf(row) };
  });
  if (result.kind === "issued") console.info(`[certificate] access ${known.id}: issued ${result.certificate.number}`);
  return result;
}

/**
 * "Paranda nimi" (spec §6): the certificate `certificateId` under its own number with a new name and reissued_at = now. Nothing else of it
 * changes: the frozen copy stays, and no mail goes. It has the student's name rules; `notFound` for an unknown id. Maria may correct a
 * revoked access's certificate too. Logs `[certificate] N: re-issued` (its id).
 */
export async function reissueCertificate(
  db: Db,
  certificateId: number,
  rawName: string,
  now: Date,
): Promise<{ kind: "reissued"; certificate: CertificateView } | { kind: "invalid"; error: "length" | "letters" } | { kind: "notFound" }> {
  const checked = checkCertificateName(rawName);
  if (!checked.ok) return { kind: "invalid", error: checked.error };
  const [row] = await db.update(certificates).set({ name: checked.name, reissuedAt: now }).where(eq(certificates.id, certificateId)).returning();
  if (!row) return { kind: "notFound" };
  console.info(`[certificate] ${certificateId}: re-issued`);
  return { kind: "reissued", certificate: viewOf(row) };
}

/** Her own certificate (its access is hers) while that access is not revoked; an ended one keeps it (spec §5). null otherwise. */
export async function certificateForStudent(db: Db, clientId: number, certificateId: number): Promise<Certificate | null> {
  const [row] = await db
    .select(getTableColumns(certificates))
    .from(certificates)
    .innerJoin(courseAccess, eq(certificates.accessId, courseAccess.id))
    .where(and(eq(certificates.id, certificateId), eq(courseAccess.clientId, clientId), isNull(courseAccess.revokedAt)))
    .limit(1);
  return row ?? null;
}

/** Any certificate, for Maria (spec §6, §9): `revoked` when its access was revoked after the issue ("ligipääs tühistatud"). */
export async function certificateForAdmin(db: Db, certificateId: number): Promise<(Certificate & { revoked: boolean }) | null> {
  const [row] = await db
    .select({ ...getTableColumns(certificates), revoked: sql<boolean>`${courseAccess.revokedAt} is not null` })
    .from(certificates)
    .innerJoin(courseAccess, eq(certificates.accessId, courseAccess.id))
    .where(eq(certificates.id, certificateId))
    .limit(1);
  return row ?? null;
}

/** The view of an access's certificate (the e-course page's "Tunnistus" row, Maria's drawer); null before it is issued. */
export async function certificateOfAccess(db: Db, accessId: number): Promise<CertificateView | null> {
  const [row] = await db
    .select({ id: certificates.id, number: certificates.number, name: certificates.name, issuedAt: certificates.issuedAt, reissuedAt: certificates.reissuedAt })
    .from(certificates)
    .where(eq(certificates.accessId, accessId))
    .limit(1);
  return row ? viewOf(row) : null;
}

/** Seaded → Tunnistus as stored, or its defaults (this year, number 1, Maria Sosnina). */
export async function getCertificateSettings(db: Db, now: Date): Promise<CertificateSettings> {
  return readSettings(db, now);
}

/** A text of Seaded's card as stored: what Postgres can hold, on one line (each run of white space one space), trimmed. */
const oneLine = (value: unknown): string => (typeof value === "string" ? toStorable(value).replace(/\s+/g, " ").trim() : "");

/** A whole number from the form: a number, or digits as a string; null for anything else. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  return typeof value === "string" && /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : null;
}

/**
 * Seaded → Tunnistus "Salvesta" (spec §3, §4, §6).
 * - The four texts are kept on one line and trimmed; each is required and within its CERT_LIMITS. A length is measured as
 *   readCertificateSettings measures it, so a value saved here is never dropped by the read: place, registry code and practical line in
 *   UTF-16 units, the trainer's name in code points once it is NFC.
 * - The trainer's name is Maria's signature, written in the script font: it also passes the student's name rules (checkCertificateName:
 *   "letters" or "length" on `trainerName`) and is stored as they clean it, so the PDF never prints a letter the font lacks. No character
 *   outside the BMP is a letter, so none is ever saved in it.
 * - "Järgmine number" is a year 2000–2099 and a number 1–99 999.
 * - Under the number series' lock, a number at or below the highest one issued in that year is refused (`nextSeq: "taken"`). Two certificates
 *   must never share a number, and a student's issue between Maria's loading the page and her save moves the series on.
 * Field errors (CertificateFieldError) are keyed place, registryCode, practicalLine, trainerName and nextSeq (a bad year is reported under
 * nextSeq too); nothing is stored when there is one.
 */
export async function saveCertificateSettings(db: Db, raw: unknown): Promise<SaveResult> {
  const input = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fields: Record<string, CertificateFieldError> = {};
  // the lengths are measured as readCertificateSettings measures them (a value saved here must never be dropped there): these three in UTF-16
  // units (`.length`), the trainer's name below in code points once it is NFC
  const text = (key: "place" | "registryCode" | "practicalLine"): string => {
    const value = oneLine(input[key]);
    if (!value) fields[key] = "required";
    else if (value.length > CERT_LIMITS[key]) fields[key] = "tooLong";
    return value;
  };
  const place = text("place");
  const registryCode = text("registryCode");
  const practicalLine = text("practicalLine");
  let trainerName = oneLine(input.trainerName);
  if (!trainerName) fields.trainerName = "required";
  else if (Array.from(trainerName.normalize("NFC")).length > CERT_LIMITS.trainerName) fields.trainerName = "tooLong";
  else {
    const signer = checkCertificateName(trainerName);
    if (signer.ok) trainerName = signer.name;
    else fields.trainerName = signer.error;
  }
  const nextYear = wholeNumber(input.nextYear);
  const nextSeq = wholeNumber(input.nextSeq);
  if (nextYear === null || nextYear < YEAR_MIN || nextYear > YEAR_MAX || nextSeq === null || nextSeq < 1 || nextSeq > SEQ_MAX) fields.nextSeq = "invalid";
  // the null checks again, written out: the transaction's closure below sees both as numbers
  if (nextYear === null || nextSeq === null || Object.keys(fields).length > 0) return { ok: false, fields };
  return db.transaction(async (t): Promise<SaveResult> => {
    const tx = t as unknown as Db;
    await lockNumbers(tx);
    const [{ top }] = await tx.select({ top: max(certificates.seq) }).from(certificates).where(eq(certificates.year, nextYear));
    if (top !== null && nextSeq <= top) return { ok: false, fields: { nextSeq: "taken" } };
    const settings: CertificateSettings = { place, registryCode, practicalLine, trainerName, nextYear, nextSeq };
    await setSetting(tx, SETTING_KEY, settings);
    return { ok: true, settings };
  });
}

/** The register /admin/tunnistused (spec §6): every certificate, revoked ones too, newest first, 50 a page (a page past the end is the last). */
export async function listCertificates(db: Db, page: number): Promise<Paged<RegisterRow>> {
  return paged(
    page,
    PAGE_SIZE,
    async () => (await db.select({ n: count() }).from(certificates))[0].n,
    (range) =>
      db
        .select({
          id: certificates.id,
          number: certificates.number,
          name: certificates.name,
          course: certificates.courseTitle,
          issuedAt: certificates.issuedAt,
          reissuedAt: certificates.reissuedAt,
          revoked: sql<boolean>`${courseAccess.revokedAt} is not null`,
          clientId: courseAccess.clientId,
        })
        .from(certificates)
        .innerJoin(courseAccess, eq(certificates.accessId, courseAccess.id))
        .orderBy(desc(certificates.issuedAt), desc(certificates.id))
        .limit(range.limit)
        .offset(range.offset),
  );
}

/** The issued number with the highest seq in `year`, for Seaded's "viimane väljastatud"; null without one. */
export async function lastIssued(db: Db, year: number): Promise<string | null> {
  const [row] = await db.select({ number: certificates.number }).from(certificates).where(eq(certificates.year, year)).orderBy(desc(certificates.seq)).limit(1);
  return row?.number ?? null;
}

/**
 * The PDF of a certificate row, rendered on each download (spec §7). It uses the row's frozen copy, and from Seaded as it is now the trainer's
 * name, which the renderer writes in the script font as Maria's signature (one the font cannot draw reads as "Maria Sosnina":
 * readCertificateSettings). The fonts come from assets/fonts (certificate-pdf.ts loadCertificateAssets); no store, no image. Nothing is stored.
 */
export async function certificatePdf(db: Db, cert: Certificate, now: Date): Promise<Uint8Array> {
  const [settings, assets] = await Promise.all([getCertificateSettings(db, now), loadCertificateAssets()]);
  return renderCertificate(
    {
      number: cert.number,
      name: cert.name,
      courseTitle: cert.courseTitle,
      skills: cert.skills,
      volume: cert.volume,
      practicalLine: cert.practicalLine,
      place: cert.place,
      registryCode: cert.registryCode,
      issuedAt: cert.issuedAt,
      trainerName: settings.trainerName,
    },
    assets,
  );
}
