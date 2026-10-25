"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import type { Db } from "@/db/client";
import { deletePostForm, saveCampaignForm, saveHomeForm, savePostForm, savePracticeForm, saveTrainerForm } from "../admin-site";
import type { EditResult } from "../edit-check";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import { revalidatePublic, type PublicChange } from "../public-cache";

// The site content editors' server actions (Task 13B): every export is wrapped in adminAction (signed-in admin or a
// redirect to /admin/login; tests/unit/admin-guards.test.ts fails otherwise). The work is in ../admin-site.ts. The
// public pages are cached: a save revalidates the pages that show what it saved (server/public-cache.ts), so the public
// site shows it on its next request; refresh() updates the open admin page.

/** The parts an editor save stored (it sends only the changed ones). */
const savedParts = (result: EditResult): string[] => (result.ok ? Object.keys(result.saved?.values ?? {}) : []);

async function run(what: string, change: (result: EditResult) => PublicChange, work: (db: Db) => Promise<EditResult>): Promise<EditResult> {
  try {
    const result = await work(getDb());
    // not on "stale" or a refusal: the editor keeps the admin's unsaved draft on screen
    if (result.ok) {
      revalidatePublic(change(result));
      refresh();
    }
    return result;
  } catch (e) {
    logFailure(`[admin] ${what} failed`, e);
    return { ok: false, error: "server" };
  }
}

/** Avaleht "Salvesta": field data ({ parts: slides | statement | faq }). */
export const saveHome = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("home save", () => ({ kind: "home" }), (db) => saveHomeForm(db, formData)));

/** Praktika "Salvesta": field data ({ parts: <package code> }). */
export const savePractice = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("practice save", () => ({ kind: "practice" }), (db) => savePracticeForm(db, formData)));

/** Koolitaja "Salvesta": field data ({ parts: trainer | bio | works | center_story | trainer_journey }). */
export const saveTrainer = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("trainer save", (r) => ({ kind: "trainer", parts: savedParts(r) }), (db) => saveTrainerForm(db, formData)));

/** Hüpikaken "Salvesta": field data ({ parts: campaign and/or newsletter }). */
export const saveCampaign = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("campaign save", () => ({ kind: "campaign" }), (db) => saveCampaignForm(db, formData)));

/** Post editor "Salvesta": field data ({ parts: post }). A new post continues at its own address. */
export const savePost = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  const result = await run("post save", () => ({ kind: "posts" }), (db) => savePostForm(db, formData));
  if (result.ok && result.created) redirect(`/admin/uudised/${result.id}?loodud=1`);
  return result;
});

/** Post editor "Kustuta postitus": field id. Back to the list with a notice. */
export const deletePost = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  const result = await run("post delete", () => ({ kind: "posts" }), (db) => deletePostForm(db, formData));
  if (result.ok) redirect("/admin/uudised?kustutatud=1");
  return result;
});
