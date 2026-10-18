import { LOCAL_FIXTURES, removeAdminFixtures, removeAdminRows, removeClientRows, removeEditRows, removeFormRows, removeLeftoverReviewFixtures, removePostRows, removeSeatFixtures, restoreLeftoverCourses, restoreLeftoverRows } from "./fixtures";
import { assertLocalDatabases } from "./local-db";
import { removeLeftoverComments, removeRateLimitRows } from "./local-kv";

// Removes the seat fixtures, the rows the form and admin sign-in tests stored, the account tests' clients and login tokens,
// the admin inbox fixtures, the public pages' review fixtures and the content tests' sessions / course (and restores a course they left changed), and fails
// the run if any of them was left behind.
// (The sign-in tests delete the token and session rows of the real admin addresses themselves, by hash.)
export default async function globalTeardown(): Promise<void> {
  if (!LOCAL_FIXTURES) return;
  assertLocalDatabases();
  await removeRateLimitRows(); // the tests' rate limit counters (one per visitor, holding addresses); not a failure, so removed first
  // a course still snapshotted means a content test did not restore it (restored now, but the run fails)
  const left = (await removeFormRows()) + (await removeAdminRows()) + (await removeAdminFixtures()) + (await removeEditRows()) + (await restoreLeftoverCourses()) + (await restoreLeftoverRows()) + (await removePostRows()) + (await removeClientRows()) + (await removeLeftoverReviewFixtures());
  await removeSeatFixtures();
  if (left !== 0) throw new Error(`e2e: ${left} rows of the form / sign-in / account / admin inbox / review / content tests were left in the database`);
  // review comments the feedback tests posted to the dev server's local KV (each test deletes its own)
  const comments = await removeLeftoverComments();
  if (comments !== 0) throw new Error(`e2e: ${comments} review comments of the feedback tests were left in the local KV`);
}
