"use server";

import { refresh } from "next/cache";
import { getDb } from "@/db/client";
import type { Db } from "@/db/client";
import { cancel, saveHandled, saveStatus, type AdminResult } from "../admin";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import { revalidatePublic, type PublicChange } from "../public-cache";
import { addManualPayment, manualPaymentForm, type ManualPaymentAnswer } from "../registration-money";

// Admin server actions: every export is wrapped in adminAction (signed-in admin or a redirect to /admin/login; the
// static check in tests/unit/admin-guards.test.ts fails otherwise). The work is in ../admin.ts and ../registration-money.ts.
// After a change the client router is refreshed, so the page, the overview numbers and the menu badges show the new state.
// A registration's status counts towards the seats shown on the public calendar and course pages: those are revalidated
// (server/public-cache.ts).

async function run(what: string, change: PublicChange | null, work: (db: Db) => Promise<AdminResult>): Promise<AdminResult> {
  try {
    const result = await work(getDb());
    if (result.ok && change) revalidatePublic(change);
    // stale: nothing was saved, but the page must show what is stored now
    if (result.ok || result.error === "stale") refresh();
    return result;
  } catch (e) {
    logFailure(`[admin] ${what} failed`, e);
    return { ok: false, error: "server" };
  }
}

/** The refusals of „Lisa laekumine“ that say the stored registration is not what the drawer shows: the page is refreshed to show it. */
const SHOWS_OLD: readonly string[] = ["stale", "overRemainder", "cancelled", "notFound", "sellerMissing"];

/**
 * Registration drawer, Raha → „Lisa laekumine“ (admin UX pass B4): fields registrationId, cents, paidOn ("YYYY-MM-DD"), method (bank | cash |
 * card), receipt ("1" when „Koosta kviitung“ is ticked) and expectedPaidCents (the paid total the panel showed); server/registration-money.ts
 * addManualPayment does the work in one transaction. A press that confirmed the place, or reached 50 % in a full session (its seat hold ends),
 * revalidates the public seats; every press that wrote refreshes the page, and so does a refusal that means the drawer shows an old state
 * (`stale` above all). For useActionState (previous state first).
 */
export const addManualPaymentAction = adminAction(async (_admin, _prev: ManualPaymentAnswer | null, formData: FormData): Promise<ManualPaymentAnswer> => {
  // (the id for the log: known once the form is read, inside the try — a call that is no form answers `invalid`, never a throw)
  let registration = "?";
  try {
    const input = manualPaymentForm(formData);
    if (!Number.isNaN(input.registrationId)) registration = String(input.registrationId);
    const result = await addManualPayment(getDb(), input, new Date());
    if (result.ok && (result.confirmedNow || result.full)) revalidatePublic({ kind: "seats" });
    if (result.ok || SHOWS_OLD.includes(result.error)) refresh();
    return result;
  } catch (e) {
    logFailure(`[admin] registration ${registration}: adding a payment failed`, e);
    return { ok: false, error: "server" };
  }
});

/**
 * Registration drawer, the status pills „Ootab ettemaksu“ / „Kinnitatud“ (saved at once, piece 2 Task 5): fields id, status, expected (the status
 * the pills showed; a different stored one is `stale`, and the page is refreshed to show it). The note is autosaved by its own route
 * (/api/admin/registreering/<id>/markus). For useActionState (previous state first).
 */
export const saveRegistrationStatus = adminAction(async (_admin, _prev: AdminResult | null, formData: FormData) =>
  run("status", { kind: "seats" }, (db) => saveStatus(db, formData)),
);

/** Registration drawer, "Tühista registreerimine": field id. */
export const cancelRegistration = adminAction(async (_admin, _prev: AdminResult | null, formData: FormData) =>
  run("cancel", { kind: "seats" }, (db) => cancel(db, formData)),
);

/** Request inbox, "Märgi tehtuks" / "Märgi tegemata": fields id, handled ("1" | "0"). */
export const toggleRequestHandled = adminAction(async (_admin, _prev: AdminResult | null, formData: FormData) =>
  run("request", null, (db) => saveHandled(db, formData)),
);
