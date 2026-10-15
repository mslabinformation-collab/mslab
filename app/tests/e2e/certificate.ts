import { insertCompletionCourse, type CompletionCourse } from "./completion";
import { onLocalDb } from "./fixtures";

// The certificate's e2e rows (certificate.spec.ts, certificate-race.spec.ts; phase 3d): a completed access on an e-course of the test's own
// (completion.ts insertCompletionCourse: no test, no points, its one lesson done; completed an hour ago), a certificate written straight to the
// database (the year 1999 and the access's id as its number: no certificate of the app's ever has it), and the stored `certificate` setting.
// Every address is a sample one (`e2e-client-cert-…@example.test`, never mailed) that fixtures.ts removeClientRows removes with its course; a
// certificate goes with its access (on delete cascade). There is no signature fixture: the signature is the trainer's name in the script font.

/** The local database for rows no public page shows. */
const localDb = <T>(work: Parameters<typeof onLocalDb<T>>[0]): Promise<T> => onLocalDb(work, { marksPages: false });

/**
 * Held by every e2e test that issues a certificate through the app, while it does: the number series is the whole database's, and the race
 * spec's two numbers are consecutive only if no other test takes one between them.
 */
export const NUMBER_LOCK = "e2e-certificate-number";
/** The year of the certificates written straight: no real certificate has it, so their numbers never meet the app's. */
export const E2E_YEAR = 1999;

/** A client (`name`) with a completed access to an e-course of her own: no test, no points, the lesson done, the course terms accepted. */
export async function completedCourse(email: string, name = "Kati Kask"): Promise<CompletionCourse> {
  const s = await insertCompletionCourse(email, { points: [], lessonsDone: true, name });
  await localDb((sql) => sql`update course_access set completed_at = now() - interval '1 hour' where id = ${s.accessId}`);
  return s;
}

export type StoredCertificate = {
  id: number;
  number: string;
  year: number;
  seq: number;
  name: string;
  courseTitle: string;
  skills: string[];
  volume: string;
  practicalLine: string;
  place: string;
  registryCode: string;
  issuedAt: Date;
  reissuedAt: Date | null;
};

/** The access's certificate as stored, or null. */
export async function storedCertificate(accessId: number): Promise<StoredCertificate | null> {
  const [row] = await localDb(
    (sql) => sql<StoredCertificate[]>`
      select id, number, year, seq, name, course_title as "courseTitle", skills, volume, practical_line as "practicalLine", place,
             registry_code as "registryCode", issued_at as "issuedAt", reissued_at as "reissuedAt"
      from certificates where access_id = ${accessId}`,
  );
  return row ?? null;
}

/** A certificate written straight for the access, issued now: "MS LAB 1999-<access id>". */
export async function insertCertificate(accessId: number, name: string): Promise<{ id: number; number: string }> {
  const number = `MS LAB ${E2E_YEAR}-${String(accessId).padStart(2, "0")}`;
  return localDb(async (sql) => {
    const [row] = await sql<{ id: number }[]>`
      insert into certificates (access_id, number, year, seq, name, course_title, skills, volume, practical_line, place, registry_code, issued_at)
      values (${accessId}, ${number}, ${E2E_YEAR}, ${accessId}, ${name}, 'E2E lõpetamine', ${sql.json(["Kulmude kuju ja proportsioonid", "Värvi valik"])},
              '10 akadeemilist tundi', 'Praktiline töö fotodel', 'Pärnu linn', '16346048', now())
      returning id`;
    return { id: row.id, number };
  });
}

/** The stored `certificate` setting; null before anything is saved (the app's defaults apply then). */
export async function storedCertificateSetting(): Promise<Record<string, unknown> | null> {
  const [row] = await localDb((sql) => sql<{ value: Record<string, unknown> }[]>`select value from settings where key = 'certificate'`);
  return row?.value ?? null;
}

/** The highest number issued in `year` (0 for none): the other half of the rule an issue follows (domain/certificate.ts seqToIssue). */
export async function highestIssuedSeq(year: number): Promise<number> {
  const [row] = await localDb((sql) => sql<{ top: number | null }[]>`select max(seq) as top from certificates where year = ${year}`);
  return row?.top ?? 0;
}

/** The course's "Tunnistus" card as stored. */
export async function storedCourseCertificate(courseId: number): Promise<{ skills: string[]; volume: string }> {
  const [row] = await localDb(
    (sql) => sql<{ skills: string[]; volume: string }[]>`select certificate_skills as skills, certificate_volume as volume from courses where id = ${courseId}`,
  );
  return row;
}
