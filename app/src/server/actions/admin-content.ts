"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import type { Db } from "@/db/client";
import { createCourseForm, deleteSessionForm, moveCourseRequest, saveSessionForm, type EditResult } from "../admin-content";
import { adminAction } from "../auth";
import { parseSwitch, switchCoursePublished, switchCourseSample, type SwitchResult } from "../course-parts";
import { logFailure } from "../log";
import { revalidatePublic, type PublicChange } from "../public-cache";

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
    const result = await work(getDb(), request.id, request.on, new Date());
    if (result.ok) refresh();
    return result;
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

/** Calendar drawer "Salvesta" / "Lisa toimumine". A new session closes the drawer and is highlighted in the list. */
export const saveSession = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  const result = await run("session save", { kind: "sessions" }, (db) => saveSessionForm(db, formData));
  if (result.ok && result.created) redirect(`/admin/kalender?lisatud=${result.id}`);
  return result;
});

/** Calendar drawer "Kustuta toimumine": field id. Back to the list with a notice. */
export const deleteSession = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  const result = await run("session delete", { kind: "sessions" }, (db) => deleteSessionForm(db, formData));
  if (result.ok) redirect(`/admin/kalender?kustutatud=1`);
  return result;
});
