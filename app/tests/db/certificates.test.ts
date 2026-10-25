import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import * as schema from "@/db/schema";
import { certificates, clients, courseAccess, courses, settings } from "@/db/schema";
import { CERT_DEFAULTS } from "@/domain/certificate";
import { renderCertificate } from "@/server/certificate-pdf";
import {
  certificateCard, certificateForAdmin, certificateForStudent, certificateOfAccess, certificatePdf, getCertificateSettings, issueCertificate, lastIssued, listCertificates,
  reissueCertificate, saveCertificateSettings, type IssueResult,
} from "@/server/certificates";
import { makeTestDb } from "./helpers";

// The e-course certificate's server (phase 3d, spec §3, §4, §6, §9) against a real (PGlite) database: the issue (the name rules first, then
// under the access's lock and the number series' lock; one per access; the number from Seaded, moved on; the frozen copy), the re-issue under
// the same number, the student's and Maria's reads, Seaded's settings (the trainer's name, her typed signature, under the student's name
// rules), the register, and the PDF of a row rendered with the fonts and Seaded's trainer's name. The renderer is the real one (Task 2),
// wrapped so a test can see what it was given.

vi.mock("@/server/certificate-pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/certificate-pdf")>();
  return { ...real, renderCertificate: vi.fn(real.renderCertificate) };
});

const NOW = new Date("2026-10-20T10:00:00Z");
const DAY = 86_400_000;
/** Seaded as these tests store it unless one says otherwise: the defaults, 2026, the next number 3. */
const SETTING = { ...CERT_DEFAULTS, nextYear: 2026, nextSeq: 3 };
/** A save of Seaded's card that passes. */
const VALID = { place: "Pärnu linn", registryCode: "16346048", practicalLine: CERT_DEFAULTS.practicalLine, trainerName: "Maria Sosnina", nextYear: 2026, nextSeq: 1 };

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.mocked(renderCertificate).mockClear();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** A fresh migrated database that records every query it runs (drizzle's logger); it replaces `db`, which the helpers below write through. */
async function useLoggedDb() {
  const log: { query: string; params: unknown[] }[] = [];
  const logged: Db = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string, params: unknown[]) => void log.push({ query, params }) } });
  await migrate(logged, { migrationsFolder: "./drizzle" });
  db = logged;
  log.length = 0; // the migrations are not of interest
  return log;
}
/** Where in a query log the access row is locked, the number series' transaction lock is taken, the year's highest seq is read, and the setting is read or written. */
const at = (log: { query: string; params: unknown[] }[]) => ({
  accessLock: log.findIndex((e) => /from "course_access"[\s\S]*for update/.test(e.query)),
  numberLock: log.findIndex((e) => /pg_advisory_xact_lock\(hashtext\(/.test(e.query) && e.params.includes("certificate-number")),
  maxSeq: log.findIndex((e) => /max\("seq"\)/.test(e.query)),
  settingRead: log.findIndex((e) => /^select .* from "settings"/.test(e.query)),
  settingWrite: log.findIndex((e) => /^insert into "settings"/.test(e.query)),
  written: log.findIndex((e) => /^insert into "certificates"/.test(e.query)),
});

const infoLog = () => vi.mocked(console.info).mock.calls.flat().join("\n");
const stored = () => readSetting(db, "certificate");
/** The card's version as stored now (certificateCard: its autosave goes from it). */
const versionNow = async (now = NOW) => (await certificateCard(db, now)).version;
/**
 * Seaded → Tunnistus's autosave of `patch` from the version stored now (saveCertificateSettings, the part writer, admin UX pass piece 3b Task 4),
 * answered as these rules' tests read it: the setting as stored after a save, the refused fields, or the other refusal.
 */
async function saveCard(patch: unknown, now = NOW): Promise<{ ok: true; settings: unknown } | { ok: false; fields: Record<string, string> } | { ok: false; error: string }> {
  const answer = await saveCertificateSettings(db, patch, await versionNow(now), now);
  if (answer.ok) return { ok: true, settings: await stored() };
  return answer.error === "invalid" ? { ok: false, fields: answer.fields } : { ok: false, error: answer.error };
}
const rows = () => db.select().from(certificates).orderBy(certificates.id);

/** The e-course "kulmud-e": two "Mida õpid" lines (the second with spaces around it) and 10 hours; `over` changes it. */
async function ecourse(over: Partial<typeof courses.$inferInsert> = {}) {
  const [c] = await db
    .insert(courses)
    .values({
      slug: "kulmud-e",
      type: "e_learning",
      level: "basic",
      title: { et: "Kulmude e-kursus", ru: "Онлайн-курс бровей" },
      summary: { et: "" },
      body: { et: "" },
      price: 9500,
      published: true,
      outcomes: [{ et: "Kulmude kuju määramine", ru: "Форма бровей" }, { et: " Värvimine " }],
      certificateVolume: "10 akadeemilist tundi",
      ...over,
    })
    .returning();
  return c;
}

/** A student with six months of access to `courseId`, completed yesterday unless `access` says otherwise. */
async function student(email: string, courseId: number, access: Partial<typeof courseAccess.$inferInsert> = {}) {
  const [client] = await db.insert(clients).values({ email, name: "Kati Kask" }).returning();
  const [a] = await db
    .insert(courseAccess)
    .values({ clientId: client.id, courseId, grantedBy: "maria@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY), completedAt: new Date(NOW.getTime() - DAY), ...access })
    .returning();
  return { client, access: a };
}

/** issueCertificate for "kulmud-e" that must issue: its view. */
async function issued(clientId: number, name: string, now = NOW) {
  const result = await issueCertificate(db, clientId, "kulmud-e", name, now);
  expect(result.kind, name).toBe("issued");
  return (result as Extract<IssueResult, { kind: "issued" }>).certificate;
}

describe("issueCertificate (spec §4, §5)", () => {
  test("a completed access: the name as she confirmed it (NFC, trimmed, one space), the number from Seaded, the frozen copy; Seaded's number moves on; the log names the access and the number only", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    await setSetting(db, "certificate", SETTING);
    // "To" + U+0303 (a combining tilde) is "Tõ" once it is NFC
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "  Mari-Liis   To\u0303nisson ", NOW)).toEqual({
      kind: "issued",
      certificate: { id: expect.any(Number), number: "MS LAB 2026-03", name: "Mari-Liis Tõnisson", issuedAt: NOW.toISOString(), reissuedAt: null },
    });
    const [row] = await rows();
    expect(row).toMatchObject({
      accessId: kati.access.id,
      number: "MS LAB 2026-03",
      year: 2026,
      seq: 3,
      name: "Mari-Liis Tõnisson",
      courseTitle: "Kulmude e-kursus",
      skills: ["Kulmude kuju määramine", "Värvimine"],
      volume: "10 akadeemilist tundi",
      practicalLine: CERT_DEFAULTS.practicalLine,
      place: "Pärnu linn",
      registryCode: "16346048",
      issuedAt: NOW,
      reissuedAt: null,
    });
    expect(await stored()).toEqual({ ...SETTING, nextSeq: 4 });
    expect(infoLog()).toContain(`[certificate] access ${kati.access.id}: issued MS LAB 2026-03`);
    expect(infoLog()).not.toMatch(/Mari|Tõnisson|kati@/);
  });

  test("the course's own certificate lines when it has any (else its 'Mida õpid' lines); no volume, none; nothing in Seaded yet: its defaults and this year's number 1", async () => {
    const c = await ecourse({ certificateSkills: [" Kulmude kuju ", "", "Hooldus"], certificateVolume: "" });
    const kati = await student("kati@example.test", c.id);
    expect((await issued(kati.client.id, "Kati Kask")).number).toBe("MS LAB 2026-01");
    expect((await rows())[0]).toMatchObject({ skills: ["Kulmude kuju", "Hooldus"], volume: "", place: "Pärnu linn", registryCode: "16346048", practicalLine: CERT_DEFAULTS.practicalLine });
    expect(await stored()).toEqual({ ...CERT_DEFAULTS, nextYear: 2026, nextSeq: 2 });
  });

  test("the refusals: a name the rules refuse, a course not completed yet, a revoked access, no access or a contact course — nothing stored; an expired completed access issues (she completed it)", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "Kati 2", NOW)).toEqual({ kind: "invalid", error: "letters" });
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "Kati 😀", NOW)).toEqual({ kind: "invalid", error: "letters" });
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "A".repeat(81), NOW)).toEqual({ kind: "invalid", error: "length" });
    const open = await student("open@example.test", c.id, { completedAt: null });
    expect(await issueCertificate(db, open.client.id, "kulmud-e", "Kati Kask", NOW)).toEqual({ kind: "notCompleted" });
    const revoked = await student("revoked@example.test", c.id, { revokedAt: NOW });
    expect(await issueCertificate(db, revoked.client.id, "kulmud-e", "Kati Kask", NOW)).toEqual({ kind: "notFound" });
    expect(await issueCertificate(db, kati.client.id, "pole-olemas", "Kati Kask", NOW)).toEqual({ kind: "notFound" });
    const [none] = await db.insert(clients).values({ email: "none@example.test" }).returning();
    expect(await issueCertificate(db, none.id, "kulmud-e", "Kati Kask", NOW)).toEqual({ kind: "notFound" });
    const [contact] = await db.insert(courses).values({ slug: "kontakt", type: "contact", level: "basic", title: { et: "Kontakt" }, summary: { et: "" }, body: { et: "" } }).returning();
    await db.insert(courseAccess).values({ clientId: kati.client.id, courseId: contact.id, grantedBy: "maria@example.test", expiresAt: new Date(NOW.getTime() + DAY), completedAt: NOW });
    expect(await issueCertificate(db, kati.client.id, "kontakt", "Kati Kask", NOW)).toEqual({ kind: "notFound" });
    expect(await rows()).toEqual([]);
    expect(await stored()).toBeNull();
    const ended = await student("ended@example.test", c.id, { expiresAt: new Date(NOW.getTime() - DAY) });
    expect((await issued(ended.client.id, "Kati Kask")).number).toBe("MS LAB 2026-01");
  });
});

describe("Review Focus 1: two certificates at the same moment", () => {
  test("Review Focus 1: the same access twice (a double tap, a second device): one certificate; the second answers 'already' with the first one's view, whatever name it sent; the number moves on once", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    const first = await issued(kati.client.id, "Kati Kask");
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "Katrin Kask", new Date(NOW.getTime() + 60_000))).toEqual({ kind: "already", certificate: first });
    // both at once: the access's lock lets one through, the other finds its certificate
    const mari = await student("mari@example.test", c.id);
    const both = await Promise.all([issueCertificate(db, mari.client.id, "kulmud-e", "Mari Maasikas", NOW), issueCertificate(db, mari.client.id, "kulmud-e", "Mari Maasikas", NOW)]);
    expect(both.map((r) => r.kind).sort()).toEqual(["already", "issued"]);
    expect((await rows()).map((r) => [r.accessId, r.number])).toEqual([
      [kati.access.id, "MS LAB 2026-01"],
      [mari.access.id, "MS LAB 2026-02"],
    ]);
    expect(await stored()).toMatchObject({ nextYear: 2026, nextSeq: 3 });
  });

  test("Review Focus 1: three students at the same moment get three numbers in a row, never one twice; Seaded's number after the last", async () => {
    await setSetting(db, "certificate", SETTING);
    const c = await ecourse();
    const people = [await student("a@example.test", c.id), await student("b@example.test", c.id), await student("c@example.test", c.id)];
    const results = await Promise.all(people.map((p) => issueCertificate(db, p.client.id, "kulmud-e", "Kati Kask", NOW)));
    expect(results.map((r) => r.kind)).toEqual(["issued", "issued", "issued"]);
    expect((await rows()).map((r) => r.number).sort()).toEqual(["MS LAB 2026-03", "MS LAB 2026-04", "MS LAB 2026-05"]);
    expect(await stored()).toMatchObject({ nextSeq: 6 });
  });

  test("Review Focus 1: the order of the locks — the access row (FOR UPDATE), then the number series' transaction lock, then Seaded read and the year's highest number read, the certificate written and the number moved on; an issued one never waits for the series", async () => {
    const log = await useLoggedDb();
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    log.length = 0;
    expect((await issueCertificate(db, kati.client.id, "kulmud-e", "Kati Kask", NOW)).kind).toBe("issued");
    const p = at(log);
    expect(p.accessLock).toBeGreaterThanOrEqual(0);
    expect([p.accessLock < p.numberLock, p.numberLock < p.settingRead, p.numberLock < p.maxSeq, p.settingRead < p.written, p.maxSeq < p.written, p.written < p.settingWrite]).toEqual([
      true, true, true, true, true, true,
    ]);
    expect(log.filter((e) => /pg_advisory/.test(e.query))).toHaveLength(1);
    // asked again: the access's lock finds it issued; the number series is never touched
    log.length = 0;
    expect((await issueCertificate(db, kati.client.id, "kulmud-e", "Kati Kask", NOW)).kind).toBe("already");
    expect(log.some((e) => /from "course_access"[\s\S]*for update/.test(e.query))).toBe(true);
    expect(log.some((e) => /pg_advisory/.test(e.query))).toBe(false);
  });

  test("Review Focus 1: the refusals that write nothing — a revoked access, one not completed — answer under the access's lock alone and never take the number series' lock", async () => {
    const log = await useLoggedDb();
    const c = await ecourse();
    const revoked = await student("revoked@example.test", c.id, { revokedAt: NOW });
    const open = await student("open@example.test", c.id, { completedAt: null });
    for (const [who, kind] of [[revoked, "notFound"], [open, "notCompleted"]] as const) {
      log.length = 0;
      expect((await issueCertificate(db, who.client.id, "kulmud-e", "Kati Kask", NOW)).kind).toBe(kind);
      expect(at(log).accessLock, kind).toBeGreaterThanOrEqual(0);
      expect(log.some((e) => /pg_advisory/.test(e.query)), kind).toBe(false);
      expect(at(log).written, kind).toBe(-1);
    }
    expect(await stored()).toBeNull();
  });
});

describe("the number series never stalls (an issue takes past the year's highest number, spec §4 as amended)", () => {
  /** Three students of "kulmud-e" with certificates 2026-01 to 2026-03, issued from an empty Seaded. */
  async function threeIssued() {
    const c = await ecourse();
    for (const [i, name] of ["Kati Kask", "Mari Maasikas", "Liis Lill"].entries()) await issued((await student(`s${i}@example.test`, c.id)).client.id, name);
    expect((await rows()).map((r) => r.number)).toEqual(["MS LAB 2026-01", "MS LAB 2026-02", "MS LAB 2026-03"]);
    return c;
  }

  test("Seaded says another year (next year preset in December, a typo, a form left open over New Year) while the certificates are of this one: the issue takes the next free number of its own year, and Seaded follows", async () => {
    const c = await threeIssued();
    // Maria presets 2027 from number 1: the save is accepted (nothing issued in 2027) ...
    expect(await saveCard({ ...VALID, nextYear: 2027, nextSeq: 1 }, NOW)).toMatchObject({ ok: true });
    // ... and a student completes in 2026 all the same: 2026-04, not a second 2026-01
    expect((await issued((await student("a@example.test", c.id)).client.id, "Anu Aas")).number).toBe("MS LAB 2026-04");
    expect(await stored()).toMatchObject({ nextYear: 2026, nextSeq: 5 });
    // a typo, 2025 from number 3: refused since M-5 (only this year or the next), the setting stays as the issue left it
    expect(await saveCard({ ...VALID, nextYear: 2025, nextSeq: 3 }, NOW)).toEqual({ ok: false, fields: { nextYear: "invalid" } });
    expect(await stored()).toMatchObject({ nextYear: 2026, nextSeq: 5 });
    expect((await issued((await student("b@example.test", c.id)).client.id, "Ben Bauer")).number).toBe("MS LAB 2026-05");
    expect(await stored()).toMatchObject({ nextYear: 2026, nextSeq: 6 });
    expect((await rows()).map((r) => [r.year, r.seq])).toEqual([[2026, 1], [2026, 2], [2026, 3], [2026, 4], [2026, 5]]);
  });

  test("a form left open over New Year: Seaded's old-year number, saved after a student issued the new year's first, is refused (last year: M-5); the next issue goes on from the new year's", async () => {
    await setSetting(db, "certificate", { ...SETTING, nextSeq: 8 });
    const c = await ecourse();
    const turned = new Date("2026-12-31T22:30:00Z"); // already 2027 in Tallinn
    expect((await issued((await student("a@example.test", c.id)).client.id, "Anu Aas", turned)).number).toBe("MS LAB 2027-01");
    // her form was loaded on 31.12 (2026, number 8) and saved after midnight: 2026 is last year now
    expect(await saveCard({ ...VALID, nextYear: 2026, nextSeq: 8 }, new Date("2026-12-31T22:45:00Z"))).toEqual({ ok: false, fields: { nextYear: "invalid" } });
    expect(await stored()).toMatchObject({ nextYear: 2027, nextSeq: 2 });
    expect((await issued((await student("b@example.test", c.id)).client.id, "Ben Bauer", new Date("2027-01-02T08:00:00Z"))).number).toBe("MS LAB 2027-02");
    expect(await stored()).toMatchObject({ nextYear: 2027, nextSeq: 3 });
  });

  test("Seaded's row is gone (deleted by hand) while certificates exist: the issue takes the next free number, not number 1 again", async () => {
    const c = await ecourse();
    await issued((await student("a@example.test", c.id)).client.id, "Anu Aas");
    await issued((await student("b@example.test", c.id)).client.id, "Ben Bauer");
    await db.delete(settings).where(eq(settings.key, "certificate"));
    expect(await stored()).toBeNull();
    expect((await issued((await student("c@example.test", c.id)).client.id, "Cleo Cook")).number).toBe("MS LAB 2026-03");
    expect(await stored()).toMatchObject({ ...CERT_DEFAULTS, nextYear: 2026, nextSeq: 4 });
  });

  test("a number ahead of the highest issued — Maria's deliberate jump, or a gap left by a deleted account — is honoured, and the series goes on from it", async () => {
    const c = await threeIssued();
    expect(await saveCard({ ...VALID, nextYear: 2026, nextSeq: 10 }, NOW)).toMatchObject({ ok: true });
    expect((await issued((await student("a@example.test", c.id)).client.id, "Anu Aas")).number).toBe("MS LAB 2026-10");
    expect(await stored()).toMatchObject({ nextYear: 2026, nextSeq: 11 });
    expect((await issued((await student("b@example.test", c.id)).client.id, "Ben Bauer")).number).toBe("MS LAB 2026-11");
  });
});

test("Review Focus 3: the year turns at Tallinn midnight: at 23:59 on 31.12 the old year's number, at 22:30 UTC (00:30 on 1.1 in Tallinn) the new year's first; Maria's number for the old year does not carry over", async () => {
  await setSetting(db, "certificate", { ...SETTING, nextSeq: 7 });
  const c = await ecourse();
  const kati = await student("kati@example.test", c.id);
  const mari = await student("mari@example.test", c.id);
  const liis = await student("liis@example.test", c.id);
  const late = new Date("2026-12-31T21:59:00Z"); // 23:59 in Tallinn (UTC+2)
  const turned = new Date("2026-12-31T22:30:00Z"); // 00:30 on 1.1.2027 in Tallinn
  expect((await issued(kati.client.id, "Kati Kask", late)).number).toBe("MS LAB 2026-07");
  expect(await stored()).toMatchObject({ nextYear: 2026, nextSeq: 8 });
  expect(await issued(mari.client.id, "Mari Maasikas", turned)).toMatchObject({ number: "MS LAB 2027-01", issuedAt: turned.toISOString() });
  expect(await stored()).toMatchObject({ nextYear: 2027, nextSeq: 2 });
  expect((await issued(liis.client.id, "Liis Lill", new Date("2027-01-02T08:00:00Z"))).number).toBe("MS LAB 2027-02");
  expect((await rows()).map((r) => [r.year, r.seq])).toEqual([
    [2026, 7],
    [2027, 1],
    [2027, 2],
  ]);
  expect([await lastIssued(db, 2026), await lastIssued(db, 2027), await lastIssued(db, 2025)]).toEqual(["MS LAB 2026-07", "MS LAB 2027-02", null]);
});

describe("re-issue ('Paranda nimi', spec §6)", () => {
  test("the same number and copy, the new name and reissued_at; the student's name rules; an unknown id; no number taken; logged by its id only", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    const { id } = await issued(kati.client.id, "Kati Kask");
    const [before] = await rows();
    const LATER = new Date(NOW.getTime() + 3 * DAY);
    expect(await reissueCertificate(db, id, "  Katrin   Kask ", LATER)).toEqual({
      kind: "reissued",
      certificate: { id, number: "MS LAB 2026-01", name: "Katrin Kask", issuedAt: NOW.toISOString(), reissuedAt: LATER.toISOString() },
    });
    expect((await rows())[0]).toEqual({ ...before, name: "Katrin Kask", reissuedAt: LATER });
    expect(await reissueCertificate(db, id, "Katrin 2", LATER)).toEqual({ kind: "invalid", error: "letters" });
    expect(await reissueCertificate(db, id, "A".repeat(81), LATER)).toEqual({ kind: "invalid", error: "length" });
    expect(await reissueCertificate(db, 999_999, "Katrin Kask", LATER)).toEqual({ kind: "notFound" });
    expect((await rows())[0].name).toBe("Katrin Kask");
    expect(await stored()).toMatchObject({ nextSeq: 2 });
    expect(infoLog()).toContain(`[certificate] ${id}: re-issued`);
    expect(infoLog()).not.toContain("Katrin");
  });
});

describe("who reads a certificate", () => {
  test("certificateOfAccess: the view of the access's certificate; null before it is issued", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    expect(await certificateOfAccess(db, kati.access.id)).toBeNull();
    const view = await issued(kati.client.id, "Kati Kask");
    expect(await certificateOfAccess(db, kati.access.id)).toEqual(view);
  });

  test("Review Focus 5: revoked after issue — her read is null (an ended access's is not), Maria's still has it marked revoked, the register says so, and she cannot issue again", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    const mari = await student("mari@example.test", c.id);
    const { id } = await issued(kati.client.id, "Kati Kask");
    const [row] = await rows();
    expect(await certificateForStudent(db, kati.client.id, id)).toEqual(row);
    expect(await certificateForStudent(db, mari.client.id, id)).toBeNull(); // never another student's
    expect(await certificateForStudent(db, kati.client.id, 999_999)).toBeNull();
    // her access has ended: the certificate stays hers
    await db.update(courseAccess).set({ expiresAt: new Date(NOW.getTime() - DAY) }).where(eq(courseAccess.id, kati.access.id));
    expect(await certificateForStudent(db, kati.client.id, id)).toEqual(row);
    expect(await certificateForAdmin(db, id)).toEqual({ ...row, revoked: false });
    // Maria revokes it (a refund): gone for her, still Maria's, marked
    await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, kati.access.id));
    expect(await certificateForStudent(db, kati.client.id, id)).toBeNull();
    expect(await certificateForAdmin(db, id)).toEqual({ ...row, revoked: true });
    expect((await listCertificates(db, 1)).rows).toEqual([
      { id, number: "MS LAB 2026-01", name: "Kati Kask", course: "Kulmude e-kursus", issuedAt: NOW, reissuedAt: null, revoked: true, clientId: kati.client.id },
    ]);
    expect(await issueCertificate(db, kati.client.id, "kulmud-e", "Kati Kask", NOW)).toEqual({ kind: "notFound" });
    expect(await certificateForAdmin(db, 999_999)).toBeNull();
  });

  test("the account's deletion takes her certificate with it (cascade); its number is never given again: the series has a gap", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    const mari = await student("mari@example.test", c.id);
    await issued(kati.client.id, "Kati Kask");
    await issued(mari.client.id, "Mari Maasikas");
    await db.delete(clients).where(eq(clients.id, kati.client.id));
    expect((await rows()).map((r) => r.number)).toEqual(["MS LAB 2026-02"]);
    const liis = await student("liis@example.test", c.id);
    expect((await issued(liis.client.id, "Liis Lill")).number).toBe("MS LAB 2026-03");
  });

  test("the register: newest first, 50 a page, each row with its course, the client and whether the access was revoked; a page past the end shows the last; lastIssued", async () => {
    const c = await ecourse();
    const people = await db
      .insert(clients)
      .values(Array.from({ length: 51 }, (_, i) => ({ email: `opilane${i}@example.test`, name: `Õpilane ${i}` })))
      .returning();
    const accesses = await db
      .insert(courseAccess)
      .values(people.map((p) => ({ clientId: p.id, courseId: c.id, grantedBy: "maria@example.test", expiresAt: NOW, completedAt: NOW })))
      .returning();
    await db.insert(certificates).values(
      accesses.map((a, i) => ({
        accessId: a.id,
        number: `MS LAB 2026-${String(i + 1).padStart(2, "0")}`,
        year: 2026,
        seq: i + 1,
        name: `Õpilane ${i}`,
        courseTitle: "Kulmude e-kursus",
        skills: [],
        volume: "",
        practicalLine: "Praktiline töö",
        place: "Pärnu linn",
        registryCode: "16346048",
        issuedAt: new Date(NOW.getTime() + i * 60_000),
      })),
    );
    const first = await listCertificates(db, 1);
    expect([first.page, first.pages, first.total, first.rows.length]).toEqual([1, 2, 51, 50]);
    expect(first.rows[0]).toEqual({
      id: expect.any(Number),
      number: "MS LAB 2026-51",
      name: "Õpilane 50",
      course: "Kulmude e-kursus",
      issuedAt: new Date(NOW.getTime() + 50 * 60_000),
      reissuedAt: null,
      revoked: false,
      clientId: people[50].id,
    });
    expect((await listCertificates(db, 2)).rows.map((r) => r.number)).toEqual(["MS LAB 2026-01"]);
    expect((await listCertificates(db, 9)).page).toBe(2);
    expect(await lastIssued(db, 2026)).toBe("MS LAB 2026-51");
  });
});

describe("Seaded → Tunnistus (spec §3, §4)", () => {
  test("getCertificateSettings: the defaults before anything is stored (this year, number 1, Maria Sosnina); what was stored after; a stored trainer's name the script font cannot draw reads as the default", async () => {
    expect(await getCertificateSettings(db, NOW)).toEqual({ ...CERT_DEFAULTS, nextYear: 2026, nextSeq: 1 });
    await setSetting(db, "certificate", { ...SETTING, place: "Tallinn" });
    expect(await getCertificateSettings(db, NOW)).toEqual({ ...SETTING, place: "Tallinn" });
    await setSetting(db, "certificate", { ...SETTING, trainerName: "Мария Соснина" });
    expect((await getCertificateSettings(db, NOW)).trainerName).toBe("Maria Sosnina");
  });

  test("saveCertificateSettings: the texts on one line and trimmed, the trainer's name cleaned as the name rules clean it (NFC), the numbers as numbers (a form's digit strings too)", async () => {
    // "Mari" + U+0301 (a combining acute) + "a" is "María" once it is NFC
    const raw = { place: "  Tallinn ", registryCode: " 16346048 ", practicalLine: "Praktiline töö\n fotodel ", trainerName: " Mari\u0301a  Sosnina ", nextYear: "2026", nextSeq: "12" };
    const saved = await saveCard(raw, NOW);
    const settings = { place: "Tallinn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel", trainerName: "María Sosnina", nextYear: 2026, nextSeq: 12 };
    expect(saved).toEqual({ ok: true, settings });
    expect(await stored()).toEqual(settings);
  });

  test("its refusals, each by its field: empty or too long, a year or a number that is none; nothing is stored", async () => {
    expect(await saveCard({ place: " ", registryCode: "1".repeat(21), practicalLine: "x".repeat(201), trainerName: "", nextYear: 2026, nextSeq: 0 }, NOW)).toEqual({
      ok: false,
      fields: { place: "required", registryCode: "tooLong", practicalLine: "tooLong", trainerName: "required", nextSeq: "invalid" },
    });
    const numbers: [unknown, unknown][] = [[2026, 1.5], [2026, -1], [2026, "-1"], [2026, 100_000], [2026, null], [2026, 0]];
    for (const [nextYear, nextSeq] of numbers)
      expect(await saveCard({ ...VALID, nextYear, nextSeq }, NOW), `${String(nextYear)} ${String(nextSeq)}`).toEqual({ ok: false, fields: { nextSeq: "invalid" } });
    // a year that is none is on its own field (M-5)
    for (const nextYear of [1999, 2100, "20x6", 2026.5, null])
      expect(await saveCard({ ...VALID, nextYear, nextSeq: 1 }, NOW), String(nextYear)).toEqual({ ok: false, fields: { nextYear: "invalid" } });
    expect(await saveCard({ ...VALID, nextYear: null, nextSeq: null }, NOW)).toEqual({ ok: false, fields: { nextYear: "invalid", nextSeq: "invalid" } });
    for (const raw of [null, "x", [], 7]) expect((await saveCard(raw, NOW)).ok, JSON.stringify(raw)).toBe(false);
    expect(await stored()).toBeNull();
    expect(await saveCard(VALID, NOW)).toEqual({ ok: true, settings: VALID });
  });

  test("M-5: the year is this Tallinn year or the next, else 'invalid' on nextYear (an issue would ignore a past year, and Maria's number with it): last year refused, this and next accepted, the year after refused; at Tallinn's midnight the new year counts", async () => {
    expect(await saveCard({ ...VALID, nextYear: 2025, nextSeq: 50 }, NOW)).toEqual({ ok: false, fields: { nextYear: "invalid" } });
    expect(await saveCard({ ...VALID, nextYear: 2028, nextSeq: 1 }, NOW)).toEqual({ ok: false, fields: { nextYear: "invalid" } });
    expect(await stored()).toBeNull(); // nothing stored
    expect(await saveCard({ ...VALID, nextYear: 2026, nextSeq: 50 }, NOW)).toMatchObject({ ok: true, settings: { nextYear: 2026, nextSeq: 50 } });
    expect(await saveCard({ ...VALID, nextYear: "2027", nextSeq: 1 }, NOW)).toMatchObject({ ok: true, settings: { nextYear: 2027, nextSeq: 1 } });
    // 31.12 at 22:30 UTC is already 2027 in Tallinn: 2026 is last year, 2028 the next
    const turned = new Date("2026-12-31T22:30:00Z");
    expect(await saveCard({ ...VALID, nextYear: 2026, nextSeq: 60 }, turned)).toEqual({ ok: false, fields: { nextYear: "invalid" } });
    expect(await saveCard({ ...VALID, nextYear: 2028, nextSeq: 1 }, turned)).toMatchObject({ ok: true });
    // the year's refusal comes with the others, before any query
    const log = await useLoggedDb();
    const version = await versionNow();
    log.length = 0;
    expect(await saveCertificateSettings(db, { ...VALID, place: "", nextYear: 2025 }, version, NOW)).toEqual({ ok: false, error: "invalid", fields: { place: "required", nextYear: "invalid" } });
    expect(log).toEqual([]);
  });

  test("the trainer's name is Maria's signature in the script font: the student's name rules (Latin letters as in the passport) — Cyrillic, a letter the font lacks or a digit is 'letters', one character 'length', over 60 'tooLong'; nothing is stored", async () => {
    const refused = [
      ["Мария Соснина", "letters"],
      ["Łucja Nowak", "letters"],
      ["Maria Sosnina 2", "letters"],
      ["M", "length"],
      ["M".repeat(61), "tooLong"],
    ] as const;
    for (const [trainerName, error] of refused)
      expect(await saveCard({ ...VALID, trainerName }, NOW), trainerName).toEqual({ ok: false, fields: { trainerName: error } });
    expect(await stored()).toBeNull();
    expect(await saveCard({ ...VALID, trainerName: "Õie-Mai Šõrmus" }, NOW)).toMatchObject({ ok: true, settings: { trainerName: "Õie-Mai Šõrmus" } });
  });

  test("Review Focus 1: the save takes the number series' lock before it reads the year's highest number and before it writes the setting (so an issue that commits first is seen, and none can slip in between); a refusal for a field touches nothing", async () => {
    const log = await useLoggedDb();
    const version = await versionNow();
    log.length = 0;
    expect(await saveCertificateSettings(db, VALID, version, NOW)).toMatchObject({ ok: true });
    let p = at(log);
    expect(p.numberLock).toBeGreaterThanOrEqual(0);
    expect([p.numberLock < p.maxSeq, p.maxSeq < p.settingWrite]).toEqual([true, true]);
    expect(log.filter((e) => /pg_advisory/.test(e.query))).toHaveLength(1);
    // 'taken': under the lock as well, and nothing is written
    const c = await ecourse();
    await issued((await student("kati@example.test", c.id)).client.id, "Kati Kask");
    const after = await versionNow();
    log.length = 0;
    expect(await saveCertificateSettings(db, { ...VALID, nextSeq: 1 }, after, NOW)).toEqual({ ok: false, error: "invalid", fields: { nextSeq: "taken" } });
    p = at(log);
    expect(p.numberLock).toBeGreaterThanOrEqual(0);
    expect([p.numberLock < p.maxSeq, p.settingWrite]).toEqual([true, -1]);
    // a field error is answered before any query
    log.length = 0;
    expect(await saveCertificateSettings(db, { ...VALID, place: "" }, after, NOW)).toEqual({ ok: false, error: "invalid", fields: { place: "required" } });
    expect(log).toEqual([]);
  });

  test("the save measures a text as readCertificateSettings does, so a value it accepts is never dropped by the read: the place, the registry code and the practical line in UTF-16 units (a character outside the BMP is two), at the limit with one", async () => {
    const emoji = "\u{1F600}"; // 2 UTF-16 units, 1 code point
    const limits = { place: 60, registryCode: 20, practicalLine: 200 } as const;
    for (const key of ["place", "registryCode", "practicalLine"] as const) {
      const limit = limits[key];
      // limit - 2 letters and one emoji: exactly `limit` units (limit - 1 code points) — kept
      const atLimit = "a".repeat(limit - 2) + emoji;
      expect(await saveCard({ ...VALID, [key]: atLimit }, NOW), key).toMatchObject({ ok: true, settings: { [key]: atLimit } });
      expect(await getCertificateSettings(db, NOW), key).toMatchObject({ [key]: atLimit });
      // limit - 1 letters and one emoji: limit + 1 units (exactly `limit` code points) — refused, as the read would drop it
      const over = "a".repeat(limit - 1) + emoji;
      expect(await saveCard({ ...VALID, [key]: over }, NOW), key).toEqual({ ok: false, fields: { [key]: "tooLong" } });
      await setSetting(db, "certificate", { ...SETTING, [key]: over });
      expect((await getCertificateSettings(db, NOW))[key], key).toBe(CERT_DEFAULTS[key]);
    }
  });

  test("the trainer's name is measured as the read does — in code points once it is NFC — so a decomposed name of 61 or more units that is shorter once composed is kept, one of 61 letters is 'tooLong', and a character outside the BMP is 'letters' (none is ever a letter, so none can reach the limit)", async () => {
    // "M" + 30 × (o + U+0308, a combining diaeresis) is 61 UTF-16 units, "Mö…ö" of 31 characters once it is NFC
    const decomposed = "M" + "o\u0308".repeat(30);
    const composed = "M" + "\u00F6".repeat(30);
    expect(await saveCard({ ...VALID, trainerName: decomposed }, NOW)).toMatchObject({ ok: true, settings: { trainerName: composed } });
    expect((await getCertificateSettings(db, NOW)).trainerName).toBe(composed);
    // 61 letters, composed: over the limit
    expect(await saveCard({ ...VALID, trainerName: "M" + "\u00F6".repeat(60) }, NOW)).toEqual({ ok: false, fields: { trainerName: "tooLong" } });
    // 60 code points (61 units) with an emoji: within the limit, so the name rules decide: not a letter
    expect(await saveCard({ ...VALID, trainerName: "M".repeat(59) + "\u{1F600}" }, NOW)).toEqual({ ok: false, fields: { trainerName: "letters" } });
    // 60 letters: kept, and the read keeps it
    const sixty = "M".repeat(60);
    expect(await saveCard({ ...VALID, trainerName: sixty }, NOW)).toMatchObject({ ok: true, settings: { trainerName: sixty } });
    expect((await getCertificateSettings(db, NOW)).trainerName).toBe(sixty);
  });

  test("Review Focus 4: Maria changes Seaded after certificates exist: they keep their place, registry code and practical line (and their course's title and lines); a next number at or below an issued one of that year is refused; a new trainer's name (her signature) is on every download, old certificates' too", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    const mari = await student("mari@example.test", c.id);
    const liis = await student("liis@example.test", c.id);
    await issued(kati.client.id, "Kati Kask"); // MS LAB 2026-01
    await issued(mari.client.id, "Mari Maasikas"); // MS LAB 2026-02
    const changed = { place: "Tallinn", registryCode: "12345678", practicalLine: "Uus rida", trainerName: "Maria S.", nextYear: 2026 };
    for (const nextSeq of [1, 2]) expect(await saveCard({ ...changed, nextSeq }, NOW), String(nextSeq)).toEqual({ ok: false, fields: { nextSeq: "taken" } });
    expect(await stored()).toMatchObject({ place: "Pärnu linn", nextSeq: 3 }); // nothing stored
    expect(await saveCard({ ...changed, nextYear: 2027, nextSeq: 1 }, NOW)).toMatchObject({ ok: true }); // nothing issued in 2027 yet
    expect(await saveCard({ ...changed, nextSeq: 3 }, NOW)).toMatchObject({ ok: true });
    await db.update(courses).set({ title: { et: "Kulmud 2.0" }, certificateSkills: ["Uus oskus"], certificateVolume: "12 tundi" }).where(eq(courses.id, c.id));
    await issued(liis.client.id, "Liis Lill"); // MS LAB 2026-03
    const [k, m, l] = await rows();
    for (const old of [k, m])
      expect(old).toMatchObject({
        place: "Pärnu linn",
        registryCode: "16346048",
        practicalLine: CERT_DEFAULTS.practicalLine,
        courseTitle: "Kulmude e-kursus",
        skills: ["Kulmude kuju määramine", "Värvimine"],
        volume: "10 akadeemilist tundi",
      });
    expect(l).toMatchObject({ number: "MS LAB 2026-03", place: "Tallinn", registryCode: "12345678", practicalLine: "Uus rida", courseTitle: "Kulmud 2.0", skills: ["Uus oskus"], volume: "12 tundi" });

    // the trainer's name (her signature, typed in the script font) is not in the row: each download reads Seaded's, an old certificate's too
    const render = vi.mocked(renderCertificate);
    await certificatePdf(db, k, NOW);
    expect(await saveCard({ ...changed, trainerName: "Maria Sosnina", nextSeq: 4 }, NOW)).toMatchObject({ ok: true });
    const pdf = await certificatePdf(db, k, NOW);
    expect(render.mock.calls.map(([content]) => content.trainerName)).toEqual(["Maria S.", "Maria Sosnina"]);
    expect(render.mock.calls[1][0]).toEqual({
      number: "MS LAB 2026-01",
      name: "Kati Kask",
      courseTitle: "Kulmude e-kursus",
      skills: ["Kulmude kuju määramine", "Värvimine"],
      volume: "10 akadeemilist tundi",
      practicalLine: CERT_DEFAULTS.practicalLine,
      place: "Pärnu linn",
      registryCode: "16346048",
      issuedAt: NOW,
      trainerName: "Maria Sosnina",
    });
    expect(Buffer.from(pdf.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  });

  test("certificatePdf: the renderer gets the two fonts and nothing else (no image, no store); a PDF under 300 KB; a stored trainer's name the script font cannot draw prints as Maria Sosnina", async () => {
    const c = await ecourse();
    const kati = await student("kati@example.test", c.id);
    await issued(kati.client.id, "Kati Kask");
    const [k] = await rows();
    const pdf = await certificatePdf(db, k, NOW);
    expect(Buffer.from(pdf.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(pdf.byteLength).toBeLessThan(300 * 1024);
    await setSetting(db, "certificate", { ...SETTING, trainerName: "Мария Соснина" });
    await certificatePdf(db, k, NOW);
    const calls = vi.mocked(renderCertificate).mock.calls;
    expect(calls.map(([, assets]) => Object.keys(assets).sort())).toEqual([
      ["sans", "script"],
      ["sans", "script"],
    ]);
    expect(calls.map(([content]) => content.trainerName)).toEqual(["Maria Sosnina", "Maria Sosnina"]);
  });
});
