import type { TestInfo } from "@playwright/test";
import postgres from "postgres";
import type { Db } from "../../src/db/client";
import { readCertificateSettings, tallinnYear } from "../../src/domain/certificate";
import { issueCertificate, type IssueResult } from "../../src/server/certificates";
import { clientEmail } from "./account";
import { completedCourse, NUMBER_LOCK, storedCertificate, storedCertificateSetting } from "./certificate";
import type { CompletionCourse } from "./completion";
import { holdLocalLock, LOCK_WAIT_MS, onLocalDb, removeClientRows } from "./fixtures";
import { runName } from "./protocols";
import { lockWaits, racePool, type Waiting } from "./race";
import { expect, submitsForms, test } from "./test";

// Spec §10 "Real Postgres (e2e)" and Review Focus 1: what the unit tests' single-connection PGlite cannot show. The app's own issueCertificate,
// in this process, on a pool of the local Postgres:
// - two students completing at the same moment get two numbers, one after the other, and the setting goes past both;
// - one student confirming on two devices at the same moment gets one certificate; the second answer is "already", with the same number.
// "At the same moment" is proven, not hoped for (atOnce): another connection holds the number's transaction lock (pg_advisory_xact_lock of
// hashtext('certificate-number'), server/certificates.ts) while the calls start, and lets it go only once this pool shows every call waiting
// — the two students' at the number's lock, or the second device's at her access row, which the first holds while it waits for the number.
// The e2e lock NUMBER_LOCK keeps the other tests' issues out of the series meanwhile. Nothing here depends on the screen: the desktop project
// runs these once.

test.skip(({ isMobile }) => isMobile, "nothing here depends on the screen: the desktop project runs these once");

const made = new Set<string>();
/** The name this process's pool connects under, so the test finds its own backends in pg_stat_activity and no one else's. */
const APPLICATION = `mslab-e2e-certificate-race-${process.pid}`;
let pool: postgres.Sql | null = null;
let db: Db;

test.beforeAll(() => {
  ({ pool, db } = racePool(APPLICATION));
});
test.afterAll(async () => {
  await pool?.end();
});
test.beforeEach(() => {
  submitsForms();
  test.setTimeout(60_000 + LOCK_WAIT_MS); // the wait for NUMBER_LOCK is this test's too
});
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
});

/** What one waiting backend waits at: the number's lock, her access row, or (for the failure message) its query. */
const waitsAt = (w: Waiting) => (/pg_advisory_xact_lock/i.test(w.query) ? "number" : /from "?course_access"?[\s\S]*\bfor update\b/i.test(w.query) ? "access" : w.query);

/**
 * The calls of issueCertificate that `calls` starts, at the same moment for certain: another connection holds the number's transaction lock
 * while they start; the test waits until this pool shows every one of them waiting (`at`: where each waits, in any order), and only then lets
 * the lock go (its transaction ends). A call that ran its whole transaction before the other began would never be seen waiting beside it, so
 * the outcome that follows is the locks', not the timing's. Their results, in the order started.
 */
async function atOnce(calls: () => Promise<IssueResult>[], at: string[]): Promise<IssueResult[]> {
  let running: Promise<IssueResult>[] = [];
  let settled = 0;
  try {
    await onLocalDb(
      (sql) =>
        sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext('certificate-number'))`;
          running = calls();
          for (const r of running)
            void r.then(
              () => settled++,
              () => settled++,
            );
          const waiting = await lockWaits(APPLICATION, running.length, () => settled > 0);
          expect(settled, "an issue went past the locks while the number's lock was held").toBe(0);
          expect(waiting.map(waitsAt).sort(), "where each issue waits (server/certificates.ts issueCertificate)").toEqual([...at].sort());
        }),
      { marksPages: false },
    );
  } finally {
    await Promise.allSettled(running); // a failure above lets the lock go too: what is on its way finishes before the clean-up
  }
  return Promise.all(running);
}

/** A student (`name`) with a completed access to an e-course of her own. */
async function student(label: string, info: TestInfo, name: string): Promise<CompletionCourse> {
  const email = clientEmail(`certrace-${label}`, runName(info));
  made.add(email);
  await removeClientRows(email);
  return completedCourse(email, name);
}

const issue = (s: CompletionCourse, name: string) => issueCertificate(db, s.clientId, s.slug, name, new Date());
const NUMBER = /^MS LAB (\d{4})-(\d{2,})$/;

test("Review Focus 1: two students completing at the same moment — two numbers, one after the other, and the setting past both", async ({}, info) => {
  const unlock = await holdLocalLock(NUMBER_LOCK);
  try {
    const anu = await student("a", info, "Anu Kask");
    const eve = await student("b", info, "Eve Tamm");
    const results = await atOnce(() => [issue(anu, "Anu Kask"), issue(eve, "Eve Tamm")], ["number", "number"]);
    expect(results.map((r) => r.kind)).toEqual(["issued", "issued"]);
    const numbers = results.map((r) => (r.kind === "issued" ? r.certificate.number : ""));
    const parts = numbers.map((n) => NUMBER.exec(n));
    expect(parts.every(Boolean), numbers.join(", ")).toBe(true);
    const [y1, y2] = parts.map((p) => Number(p![1]));
    const seqs = parts.map((p) => Number(p![2])).sort((a, b) => a - b);
    expect([y1, y2]).toEqual([tallinnYear(new Date()), tallinnYear(new Date())]);
    expect(seqs[1], `${numbers.join(" and ")}: one after the other`).toBe(seqs[0] + 1);
    // stored as answered, one each; the setting is past the second
    expect((await storedCertificate(anu.accessId))?.number).toBe(numbers[0]);
    expect((await storedCertificate(eve.accessId))?.number).toBe(numbers[1]);
    expect(readCertificateSettings(await storedCertificateSetting(), new Date())).toMatchObject({ nextYear: y1, nextSeq: seqs[1] + 1 });
  } finally {
    await unlock();
  }
});

test("Review Focus 1: one student confirming on two devices at the same moment — one certificate; the second answer is 'already', with the same number", async ({}, info) => {
  const unlock = await holdLocalLock(NUMBER_LOCK);
  try {
    const kati = await student("twice", info, "Kati Kask");
    // the first locks her access row and waits for the number; the second waits for her access row
    const results = await atOnce(() => [issue(kati, "Kati Kask"), issue(kati, "Kati Kask")], ["number", "access"]);
    expect(results.map((r) => r.kind).sort()).toEqual(["already", "issued"]);
    const [a, b] = results.map((r) => (r.kind === "issued" || r.kind === "already" ? r.certificate : null));
    expect(a?.id).toBe(b?.id);
    expect(a?.number).toBe(b?.number);
    expect(a?.number).toMatch(NUMBER);
    const stored = await onLocalDb((sql) => sql<{ number: string }[]>`select number from certificates where access_id = ${kati.accessId}`, { marksPages: false });
    expect(stored).toEqual([{ number: a!.number }]);
  } finally {
    await unlock();
  }
});
