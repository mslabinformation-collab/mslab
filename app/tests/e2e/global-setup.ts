import { existsSync, readFileSync, rmSync } from "node:fs";
import { applySeatFixtures, ensureCourseTermsPage, ensureSeedPopup, LOCAL_FIXTURES, scheduleSampleSessions, removeAdminFixtures, removeAdminRows, removeClientRows, removeEditRows, removeFormRows, removeLeftoverReviewFixtures, removePostRows, removePreviewDrafts, restoreLeftoverCourses, restoreLeftoverRows } from "./fixtures";
import { E2E_MAIL_OUTBOX, forbiddenSettingError, SERVER_ENV_FILES } from "../local-secrets";
import { assertLocalDatabases } from "./local-db";
import { removeLeftoverComments } from "./local-kv";
import { assertAppOnFakeMontonio } from "./montonio-guard";
import { LOCAL_URL, TARGET } from "./target";

// Runs once per `playwright test` run (whatever the file or --grep filter): the app under test is checked to be on the fake Montonio (not the
// real sandbox), seat fixtures for the calendar tests, and leftovers of an interrupted run's form submissions removed.
export default async function globalSetup(): Promise<void> {
  if (!LOCAL_FIXTURES) {
    // A deployment has a real database and real notifications. Read-only runs against it need an explicit opt-in;
    // even then the form tests skip themselves and every POST is blocked (tests/e2e/test.ts).
    if (process.env.E2E_ALLOW_REMOTE !== "1")
      throw new Error("e2e: E2E_BASE_URL is not a local server — set E2E_ALLOW_REMOTE=1 for a read-only run (form tests are skipped)");
    return;
  }
  refuseForbiddenSettings();
  assertLocalDatabases(); // before any write: the fixtures' database and the server's are both on this machine
  rmSync(E2E_MAIL_OUTBOX, { force: true }); // the mails the servers wrote to their outbox (the newsletter e2e) of an earlier run
  await assertAppOnFakeMontonio(TARGET || LOCAL_URL); // a server of your own with the owner's sandbox keys must not create real Montonio orders
  await removeFormRows();
  await removeAdminRows(); // e2e-auth-… leftovers of an interrupted run
  await removeClientRows(); // e2e-client-… accounts and login tokens of an interrupted run
  await removeAdminFixtures(); // e2e-admin-… inbox fixtures of an interrupted run
  await restoreLeftoverCourses(); // seed courses an interrupted content test left changed
  await restoreLeftoverRows(); // site content (slides, packages, pages, settings …) it left changed
  await removePostRows(); // and the posts the site editor tests made
  await removeEditRows(); // its "E2E …" sessions and "e2e-uus-…" course
  await removeLeftoverReviewFixtures(); // the reviews the public pages' tests made (student reviews)
  await removePreviewDrafts(); // the draft the preview test made (a seed course's title)
  await removeLeftoverComments(); // review comments (dev server's local KV) of an interrupted feedback test
  await ensureCourseTermsPage(); // the e-course terms page (phase 2a), in a database seeded before it existed
  await ensureSeedPopup(); // the newsletter popup shown, not the old campaign offer (piece 4b), in a database seeded before that
  await scheduleSampleSessions(); // the sample sessions on today's schedule: the calendar never runs out of dates
  await applySeatFixtures();
}

/**
 * The form tests submit to the local server, which must not e-mail or ping anyone: notifications are skipped there
 * because its environment has no RESEND_API_KEY / TELEGRAM_BOT_TOKEN. The upload tests must not reach the real image
 * bucket either: with no R2_* variable the server keeps images in a local folder. Stop before any test if someone has
 * added one of them (tests/local-secrets.ts, FORBIDDEN_SETTINGS).
 */
function refuseForbiddenSettings(): void {
  const files: Record<string, string | undefined> = {};
  for (const file of SERVER_ENV_FILES) files[file] = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const problem = forbiddenSettingError(files, process.env);
  if (problem) throw new Error(problem);
}
