"use server";

import { getDb } from "@/db/client";
import { adminAction } from "../auth";
import { lastIssued, saveCertificateSettings } from "../certificates";
import { logFailure } from "../log";

// The e-course certificate's admin actions (phase 3d, spec §6): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in
// ../certificates.ts. Seaded's "Tunnistus" card keeps its own state, so its save refreshes nothing. There is no signature to upload: the
// signature is the trainer's name, one of the card's fields (owner, 15.10).

/**
 * Seaded → "Tunnistus" → "Salvesta tunnistuse andmed": the card's fields as typed (`{ place, registryCode, practicalLine, trainerName, nextYear,
 * nextSeq }`, the two numbers as text), checked by saveCertificateSettings (the trainer's name by the student's name rules, "letters" or
 * "length"; a next number at or below one already issued in that year is refused on `nextSeq`, "taken": Review Focus 4). Saved: the settings
 * as stored and the number last issued in the saved year. A throw is { ok: false, error: "server" }, logged by its label only.
 */
export const saveCertificateSettingsAction = adminAction(async (_admin, raw: unknown) => {
  try {
    const db = getDb();
    const result = await saveCertificateSettings(db, raw);
    if (!result.ok) return { ok: false as const, fields: result.fields };
    const { settings } = result;
    return { ok: true as const, settings, last: await lastIssued(db, settings.nextYear) };
  } catch (e) {
    logFailure("[certificate] the settings save failed", e);
    return { ok: false as const, error: "server" as const };
  }
});
