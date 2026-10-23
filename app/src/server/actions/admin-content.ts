"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import type { Db } from "@/db/client";
import { deleteSessionForm, moveCourseRequest, saveCourseForm, saveSessionForm, type EditResult } from "../admin-content";
import { adminAction } from "../auth";
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

/** Course editor "Salvesta": field data (the draft as JSON). A new course continues at its own address. */
export const saveCourse = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  const result = await run("course save", { kind: "courses" }, (db) => saveCourseForm(db, formData));
  if (result.ok && result.created) redirect(`/admin/koolitused/${result.id}?loodud=1`);
  return result;
});

/**
 * Course list, a drag, ↑ / ↓ or the „↕“ menu (README B1): `{ id, index }`, one `moveCourseTo`. The public pages show the new order at once; the open list
 * is refreshed with the answer.
 */
export const moveCourseToAction = adminAction(async (_admin, input: unknown) => run("course move", { kind: "courses" }, (db) => moveCourseRequest(db, input)));

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
