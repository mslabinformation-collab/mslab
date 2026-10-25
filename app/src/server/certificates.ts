import { and, count, desc, eq, getTableColumns, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { paged, setSetting, type Paged } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import { certificates, courseAccess, courses, type Certificate } from "@/db/schema";
import type { SaveAnswer } from "@/domain/autosave";
import {
  CERT_LIMITS, certificateForm, certificateSkills, checkCertificateName, formatCertificateNumber, readCertificateSettings, seqToIssue, tallinnYear, type CertificateSettings,
} from "@/domain/certificate";
import { PAGE_SIZE } from "@/domain/paging";
import { toStorable } from "@/lib/to-storable";
import { contentVersion } from "@/lib/version";
import { fieldCodes } from "./autosave-route";
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
/** "Järgmine number": a number below six digits (its year is this Tallinn year or the next: saveCertificateSettings). */
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
 * Seaded's refusal of one field (saveCertificateSettings): "required" empty, "tooLong" over its CERT_LIMITS, "invalid" a year that is not
 * this Tallinn year or the next (`nextYear`) or no number 1–99 999 (`nextSeq`), "taken" a number at or below one already issued in that year;
 * on `trainerName` also the name rules' "letters" and "length" (checkCertificateName: the trainer's name is the signature the script font
 * writes).
 */
export type CertificateFieldError = "required" | "tooLong" | "invalid" | "taken" | "letters" | "length";

/** What the pages get of a certificate row (ISO times). */
export const viewOf = (c: Pick<Certificate, "id" | "number" | "name" | "issuedAt" | "reissuedAt">): CertificateView => ({
  id: c.id,
  number: c.number,
  name: c.name,
  issuedAt: c.issuedAt.toISOString(),
  reissuedAt: c.reissuedAt ? c.reissuedAt.toISOString() : null,
});

/** Waits for and takes the number series' lock; it is held to the end of `tx`'s transaction. */
const lockNumbers = (tx: Db) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${NUMBER_LOCK}))`);

/** The highest seq issued in `year`, 0 for none: what seqToIssue (the one rule of the next number) and Seaded's "taken" check read; inside a write, after lockNumbers. */
const highestSeq = async (q: Db, year: number): Promise<number> => {
  const [{ top }] = await q.select({ top: max(certificates.seq) }).from(certificates).where(eq(certificates.year, year));
  return top ?? 0;
};

/** Seaded's certificate settings as stored, or the defaults (domain/certificate.ts readCertificateSettings); inside a write, after lockNumbers. */
const readSettings = async (q: Db, now: Date): Promise<CertificateSettings> => readCertificateSettings(await readSetting(q, SETTING_KEY), now);

/**
 * "Kinnita ja koosta tunnistus" (spec §4, §5): the certificate of her completed access to the e-course `slug`, with `rawName` as she confirmed
 * it. A name the rules refuse (domain/certificate.ts checkCertificateName) is `invalid` before anything is read. Then ONE transaction:
 * - the access row is locked (lockAccess). A revoked access is `notFound`; an expired one issues, since she completed it. One without
 *   completed_at is `notCompleted`. One that has a certificate is `already`, with that one's view (a double tap, a second device). These
 *   answers need only the access's lock, so they never wait for the number series;
 * - otherwise the course's copy is read, the number series locked, Seaded read and the number taken (domain/certificate.ts seqToIssue, the one
 *   rule Seaded's card shows too): nextNumber for the Tallinn year of `now` (a new year starting at 1), but never at or below the highest
 *   number already issued in that year (highestSeq under the lock): the issue takes the larger of the two, so Seaded's number ahead of the
 *   series (Maria's jump) is kept, and one behind it or for another year, or no row at all, cannot make the unique (year, seq) refuse every
 *   later issue. This amends spec §4's "else 1";
 * - the frozen copy is written: the course's Estonian title, its certificate lines (certificateSkills: its own, else "Mida õpid") and its
 *   volume, and Seaded's practical line, place and registry code;
 * - Seaded's next number is moved on: the year used and the number used plus one.
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
    // Never a number of this year that is already issued, whatever Seaded says (spec §4 as amended): a year that is not this one (a typo,
    // next year preset in December, a form left open over New Year) or a missing row would give number 1 again, the unique (year, seq)
    // would refuse every later issue and the series would stall. A number ahead of the highest (Maria's jump) is kept.
    const year = tallinnYear(now);
    const taken = seqToIssue(settings, year, await highestSeq(tx, year));
    const [row] = await tx
      .insert(certificates)
      .values({
        accessId: access.id,
        number: formatCertificateNumber(taken.year, taken.seq),
        year: taken.year,
        seq: taken.seq,
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
    await setSetting(tx, SETTING_KEY, { ...settings, ...taken.next });
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

/** A whole number from the card: a number, or digits as typed; null for anything else. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  return typeof value === "string" && /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : null;
}

/**
 * The card's version (admin UX pass piece 3b, Task 4): "c:" and two hashes (lib/version.ts contentVersion) of the setting as read
 * (readCertificateSettings): its texts, then its counter („Aasta“, „Number“). An issue moves the counter only, so a text Maria saves while a student's
 * certificate is issued is no conflict, while a number from before it is; another tab's text or number is.
 */
async function cardVersion(s: CertificateSettings): Promise<string> {
  const { nextYear, nextSeq, ...texts } = s;
  return `c:${await contentVersion(texts)}.${await contentVersion({ nextYear, nextSeq })}`;
}

/** The two halves of a card's version (cardVersion), or null for one that is not. */
function versionHalves(version: string): { texts: string; counter: string } | null {
  const m = /^c:([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(version);
  return m ? { texts: m[1], counter: m[2] } : null;
}

/**
 * „Järgmine number“ as the card shows it (certificateCard): the stored setting run through the issue's own rule (seqToIssue) for this Tallinn year,
 * except a setting for a LATER year (Maria's preset in December), shown as she saved it.
 */
async function shownCounter(q: Db, stored: CertificateSettings, now: Date): Promise<{ nextYear: number; nextSeq: number }> {
  const year = tallinnYear(now);
  if (stored.nextYear > year) return { nextYear: stored.nextYear, nextSeq: stored.nextSeq };
  return { nextYear: year, nextSeq: seqToIssue(stored, year, await highestSeq(q, year)).seq };
}

const cardText = z.string({ error: "invalid" }).max(2_000, "tooLong");
const cardNumber = z.union([z.string().max(40), z.number()], { error: "invalid" });

/** The card's autosave patch (the route's schema; server/autosave-route.ts): some of its fields as typed (a number also as a number), no other. */
export const CERTIFICATE_SETTINGS_PATCH = z
  .strictObject({ place: cardText, registryCode: cardText, practicalLine: cardText, trainerName: cardText, nextYear: cardNumber, nextSeq: cardNumber }, { error: "invalid" })
  .partial();

const refused = (fields: Record<string, CertificateFieldError>): SaveAnswer => ({ ok: false, error: "invalid", fields });

/**
 * Seaded → Tunnistus, autosaved (spec §3, §4, §6; admin UX pass piece 3b, Task 4; README B4, spec D6): `patch` (some of the card's fields) over the
 * setting at `version` (cardVersion). Each field sent is checked by itself first, before any lock:
 * - the four texts are kept on one line and trimmed; each is required and within its CERT_LIMITS. A length is measured as readCertificateSettings
 *   measures it, so a value saved here is never dropped by the read: place, registry code and practical line in UTF-16 units, the trainer's name in
 *   code points once it is NFC;
 * - the trainer's name is Maria's signature, written in the script font: it also passes the student's name rules (checkCertificateName: "letters"
 *   or "length" on `trainerName`) and is stored as they clean it, so the PDF never prints a letter the font lacks. No character outside the BMP is
 *   a letter, so none is ever saved in it;
 * - „Aasta“ is the Tallinn year of `now` or the next one (a preset in December): an issue never uses a past year's setting (seqToIssue), so Maria's
 *   number for one — a typo, a form left open over New Year — would be void ("invalid"); „Number“ is 1–99 999 ("invalid").
 * Then under the number series' lock, the setting read under it:
 * - when „Aasta“ or „Number“ is sent: the pair as the card shows it with the sent one(s) over it; a number at or below the highest one issued in
 *   that year is `taken` (on `nextSeq` when it was sent, else on `nextYear`), whatever version it was sent from — a student's issue took it
 *   (Review Focus 1, 4);
 * - the texts' half of `version` not the stored one's, or a number sent from another counter than the stored one (an issue or another tab
 *   moved it meanwhile): a conflict, with the card as stored (CertificateForm, „Järgmine number“ as the card shows it);
 * - a number not sent keeps the stored counter as it is.
 * Answers SaveAnswer (domain/autosave.ts): ok with the card's new version (the one it had when nothing changed: nothing written), the conflict, or
 * the refused fields (CertificateFieldError); nothing is stored when a field is refused.
 */
export async function saveCertificateSettings(db: Db, patch: unknown, version: string, now: Date): Promise<SaveAnswer> {
  const parsed = CERTIFICATE_SETTINGS_PATCH.safeParse(patch);
  if (!parsed.success) return { ok: false, error: "invalid", fields: fieldCodes(parsed.error.issues) ?? {} };
  const p = parsed.data;
  const fields: Record<string, CertificateFieldError> = {};
  const values: Partial<CertificateSettings> = {};
  // the lengths are measured as readCertificateSettings measures them (a value saved here must never be dropped there): these three in UTF-16
  // units (`.length`), the trainer's name below in code points once it is NFC
  for (const key of ["place", "registryCode", "practicalLine"] as const) {
    if (p[key] === undefined) continue;
    const value = oneLine(p[key]);
    if (!value) fields[key] = "required";
    else if (value.length > CERT_LIMITS[key]) fields[key] = "tooLong";
    else values[key] = value;
  }
  if (p.trainerName !== undefined) {
    const trainerName = oneLine(p.trainerName);
    if (!trainerName) fields.trainerName = "required";
    else if (Array.from(trainerName.normalize("NFC")).length > CERT_LIMITS.trainerName) fields.trainerName = "tooLong";
    else {
      const signer = checkCertificateName(trainerName);
      if (signer.ok) values.trainerName = signer.name;
      else fields.trainerName = signer.error;
    }
  }
  const year = tallinnYear(now);
  let nextYear: number | undefined;
  if (p.nextYear !== undefined) {
    const typed = wholeNumber(p.nextYear);
    if (typed !== year && typed !== year + 1) fields.nextYear = "invalid";
    else nextYear = typed;
  }
  let nextSeq: number | undefined;
  if (p.nextSeq !== undefined) {
    const typed = wholeNumber(p.nextSeq);
    if (typed === null || typed < 1 || typed > SEQ_MAX) fields.nextSeq = "invalid";
    else nextSeq = typed;
  }
  if (Object.keys(fields).length > 0) return refused(fields);
  const savedAt = now.toISOString();
  return db.transaction(async (t): Promise<SaveAnswer> => {
    const tx = t as unknown as Db;
    await lockNumbers(tx);
    const storedValue = await readSetting(tx, SETTING_KEY);
    const stored = readCertificateSettings(storedValue, now);
    const current = await cardVersion(stored);
    const sent = versionHalves(version);
    const held = versionHalves(current)!;
    const conflict = async (): Promise<SaveAnswer> => ({ ok: false, error: "conflict", version: current, value: certificateForm({ ...stored, ...(await shownCounter(tx, stored, now)) }) });
    const counted = nextYear !== undefined || nextSeq !== undefined;
    let counter = { nextYear: stored.nextYear, nextSeq: stored.nextSeq };
    if (counted) {
      counter = { ...(await shownCounter(tx, stored, now)), ...(nextYear === undefined ? {} : { nextYear }), ...(nextSeq === undefined ? {} : { nextSeq }) };
      if (counter.nextSeq <= (await highestSeq(tx, counter.nextYear))) return refused(nextSeq !== undefined ? { nextSeq: "taken" } : { nextYear: "taken" });
    }
    if (sent?.texts !== held.texts || (counted && sent.counter !== held.counter)) return conflict();
    const settings: CertificateSettings = { ...stored, ...values, ...counter };
    const after = await cardVersion(settings);
    if (after === current && storedValue !== null) return { ok: true, version: current, savedAt };
    await setSetting(tx, SETTING_KEY, settings);
    return { ok: true, version: after, savedAt };
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
 * Seaded's "Tunnistus" card (spec §4, §6): the stored setting with "Järgmine number" as the next issue will take it, and the number last issued
 * in the year the card shows. The stored number is only a start: an issue never takes less than the year's highest + 1, and a setting for
 * another year (still last year's in January, until the year's first issue; a deleted row's default) is not used, so the card runs the stored
 * setting through the issue's own rule (seqToIssue) for this Tallinn year. One exception: a setting for a LATER year (Maria's preset in December)
 * is shown as she saved it. An issue before that year still takes this year's number, but showing that would replace her preset on the card,
 * and an unrelated save of the card would overwrite it. `version`: the card's (cardVersion, of the setting as stored: the one its autosave goes from).
 */
export async function certificateCard(db: Db, now: Date): Promise<{ settings: CertificateSettings; last: string | null; version: string }> {
  const stored = await getCertificateSettings(db, now);
  const counter = await shownCounter(db, stored, now);
  return { settings: { ...stored, ...counter }, last: await lastIssued(db, counter.nextYear), version: await cardVersion(stored) };
}

/**
 * The PDF of a certificate row, rendered on each download (spec §7). It uses the row's frozen copy, and from Seaded as it is now the trainer's
 * name, which the renderer writes in the script font as Maria's signature (one the font cannot draw reads as "Maria Sosnina":
 * readCertificateSettings). The fonts come from assets/fonts (certificate-pdf.ts loadCertificateAssets); no store, no image. Nothing is stored.
 * certificate-pdf.ts (pdf-lib and its fontkit) is imported here, when a certificate is rendered: this module comes with every account API
 * request, the payment routes and the admin pages, which then never load the PDF stack at a cold start.
 */
export async function certificatePdf(db: Db, cert: Certificate, now: Date): Promise<Uint8Array> {
  const { loadCertificateAssets, renderCertificate } = await import("./certificate-pdf");
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
