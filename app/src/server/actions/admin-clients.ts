"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import type { Db } from "@/db/client";
import { addClientForm, extendAccessRequest, grantAccessForm, openStudentHref, revokeAccessForm, unlockNextForm, type ClientResult, type ExtendAnswer } from "../admin-clients";
import { adminAction } from "../auth";
import { logFailure } from "../log";

// Õpilased (the admin's students) server actions: every export is wrapped in adminAction (signed-in admin or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise). The work is in ../admin-clients.ts. Any admin may grant
// and end e-course access and open a student's next lesson; the grant and the opening record the admin's address. Nothing
// here shows on a public page (access and progress are read only through the student's own account JSON), so no page is
// revalidated; refresh() updates the open admin page.

async function run(what: string, work: (db: Db) => Promise<ClientResult>): Promise<ClientResult> {
  try {
    const result = await work(getDb());
    if (result.ok) refresh();
    return result;
  } catch (e) {
    logFailure(`[admin] ${what} failed`, e);
    return { ok: false, error: "server" };
  }
}

/**
 * "Lisa õpilane": fields email and `back` (the list's own address: its form, search and page). Opens the student's drawer (a new or an existing one), where "Ava
 * ligipääs" is, over the same list (README A5).
 */
export const addStudent = adminAction(async (_admin, _prev: ClientResult | null, formData: FormData) => {
  const result = await run("add student", (db) => addClientForm(db, formData));
  const back = formData.get("back");
  if (result.ok && result.id) redirect(openStudentHref(typeof back === "string" ? back : null, result.id));
  return result;
});

/** Drawer, "Ava ligipääs": fields clientId, courseId, until (yyyy-mm-dd, Estonian date). */
export const grantCourseAccess = adminAction(async ({ email }, _prev: ClientResult | null, formData: FormData) =>
  run("grant access", (db) => grantAccessForm(db, formData, email, new Date())),
);

/** Drawer, "Lõpeta ligipääs" (after its confirmation): fields clientId, accessId. */
export const revokeCourseAccess = adminAction(async (_admin, _prev: ClientResult | null, formData: FormData) =>
  run("revoke access", (db) => revokeAccessForm(db, formData, new Date())),
);

/** Drawer, "Ava järgmine õppetund" (after its confirmation): fields clientId, courseId, lessonId. The admin's e-mail is recorded. */
export const unlockNextLesson = adminAction(async ({ email }, _prev: ClientResult | null, formData: FormData) =>
  run("unlock lesson", (db) => unlockNextForm(db, formData, email, new Date())),
);

/**
 * Drawer, „Pikenda ▾“ and its „Võta tagasi“ (B12): `{ accessId, expected, months | date | restore }` (server/admin-clients.ts extendAccessRequest). It applies at
 * once; the answer carries the end it replaced and the new one, for the UndoBar. The open page is refreshed when it went through, and also when the
 * screen was out of date (`stale`, `revoked`): it then shows the stored end. A throw is `server`, logged by the access.
 */
export const extendAccessAction = adminAction(async (_admin, input: unknown): Promise<ExtendAnswer | { ok: false; error: "server" }> => {
  try {
    const result = await extendAccessRequest(getDb(), input, new Date());
    if (result.ok || result.error === "stale" || result.error === "revoked") refresh();
    return result;
  } catch (e) {
    logFailure("[admin] extend access failed", e);
    return { ok: false, error: "server" };
  }
});
