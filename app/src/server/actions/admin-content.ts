"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import type { Db } from "@/db/client";
import { createCourseForm, deleteSessionForm, moveCourseRequest, type EditResult } from "../admin-content";
import { adminAction } from "../auth";
import { parseSwitch, switchCoursePublished, switchCourseSample, type SwitchResult } from "../course-parts";
import { logFailure } from "../log";
import { revalidatePublic, type PublicChange } from "../public-cache";
import { stampOrNull } from "../read-stamp";
import { createSession, parseStatusRequest, setSessionStatus, type CreateSessionResult, type SessionStatusResult } from "../session-edit";

// The content editors' server actions (courses, calendar): every export is wrapped in adminAction (signed-in admin or a
// redirect to /admin/login; tests/unit/admin-guards.test.ts fails otherwise). The work is in ../admin-content.ts.
// The public pages are cached: a saved change revalidates the pages that show it (server/public-cache.ts), so the
// public site shows it on its next request; refresh() updates the open admin page.

async function run(what: string, change: PublicChange, work: (db: Db) => Promise<EditResult>): Promise<EditResult> {
  try {
    const result = await work(getDb());
    // not on "stale": the editor keeps the admin's unsaved draft on screen (reloading is her choice)
    if (result.ok) {
      revalidatePublic(change);
      refresh();
    }
    return result;
  } catch (e) {
    logFailure(`[admin] ${what} failed`, e);
    return { ok: false, error: "server" };
  }
}

/**
 * The new-course page's „Lisa koolitus“ (piece 3a, Task 7; S3-P3-g): field data (the draft as JSON, no id). The new course continues at its own
 * address, where every card autosaves. An existing course is never written here (createCourseForm refuses an id).
 */
export const createCourse = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  const result = await run("course create", { kind: "courses" }, (db) => createCourseForm(db, formData));
  if (result.ok && result.created) redirect(`/admin/koolitused/${result.id}?loodud=1`);
  return result;
});

/**
 * Course list, a drag, ↑ / ↓ or the „↕“ menu (README B1): `{ id, index }`, one `moveCourseTo`. The public pages show the new order at once; the open list
 * is refreshed with the answer.
 */
export const moveCourseToAction = adminAction(async (_admin, input: unknown) => run("course move", { kind: "courses" }, (db) => moveCourseRequest(db, input)));

/** A course editor switch `{ id, on }`: the work revalidates what it changed itself (server/course-parts.ts); the open page is refreshed. */
async function runSwitch(what: string, input: unknown, work: (db: Db, id: number, on: boolean, now: Date) => Promise<SwitchResult>): Promise<SwitchResult> {
  const request = parseSwitch(input);
  if (!request) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    const result = await work(db, request.id, request.on, new Date());
    if (!result.ok) return result;
    refresh();
    // (the database's clock after the commit: the editor shows the switch's stored state from a page read at or past it, Task 9 review M-1)
    return { ...result, stamp: await stampOrNull(db) };
  } catch (e) {
    logFailure(`[admin] ${what} failed`, e);
    return { ok: false, error: "server" };
  }
}

/**
 * The course editor's „Avaldatud“, instant (admin UX pass piece 3a, R-d): `{ id, on }`. On: refused without a price (the field's error). Off with
 * unpublished changes: they are published first, in the same transaction; a part that cannot be is listed (`blocked`) and nothing changes.
 */
export const setCoursePublished = adminAction(async (_admin, input: unknown) => runSwitch("course published switch", input, switchCoursePublished));

/** The course editor's „Näidissisu“, instant: `{ id, on }` (admin only: no public page shows it). */
export const setCourseSample = adminAction(async (_admin, input: unknown) => runSwitch("course sample switch", input, switchCourseSample));

/**
 * The Kalender drawer's „Lisa toimumine“ (piece 3b, Task 2; README B3, S3-P3-g: the one explicit create): `{ courseId, date, time, city, venue, language,
 * capacity }`. Answers the new session's id and version, so the drawer stays open, goes on at `?id=<n>` and autosaves (api/admin/toimumine/<id>);
 * createSession revalidates the public pages once; the open list is refreshed.
 */
export const createSessionAction = adminAction(async (_admin, input: unknown): Promise<CreateSessionResult | { ok: false; error: "server" }> => {
  try {
    const result = await createSession(getDb(), input, new Date());
    if (result.ok) refresh();
    return result;
  } catch (e) {
    logFailure("[admin] session create failed", e);
    return { ok: false, error: "server" };
  }
});

/**
 * The Kalender drawer's status, instant (README B3: „Tühistatud“ with registrations after the ConfirmPanel „Jah, tühista“; „Toimub“ back): `{ id,
 * status, version }`, the version the drawer holds (R-a). A conflict answers the stored fields; setSessionStatus revalidates the public pages once; the
 * open page is refreshed.
 */
export const setSessionStatusAction = adminAction(async (_admin, input: unknown): Promise<SessionStatusResult> => {
  const request = parseStatusRequest(input);
  if (!request) return { ok: false, error: "invalid" };
  try {
    const result = await setSessionStatus(getDb(), request.id, request.status, request.version);
    if (result.ok) refresh();
    return result;
  } catch (e) {
    logFailure("[admin] session status failed", e);
    return { ok: false, error: "server" };
  }
});

/** The Kalender drawer's „Kustuta toimumine“ (only without registrations): field id. Back to the list with a notice. */
export const deleteSession = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  const result = await run("session delete", { kind: "sessions" }, (db) => deleteSessionForm(db, formData));
  if (result.ok) redirect(`/admin/kalender?kustutatud=1`);
  return result;
});
