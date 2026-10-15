"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { adminAction } from "../auth";
import { lastIssued, reissueCertificate, saveCertificateSettings } from "../certificates";
import { logFailure } from "../log";

// The e-course certificate's admin actions (phase 3d, spec §6): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in
// ../certificates.ts. Seaded's "Tunnistus" card keeps its own state, so its save refreshes nothing; "Paranda nimi" refreshes the open page (the
// drawer's line and the register show the new name). There is no signature to upload: the signature is the trainer's name, one of the card's
// fields (owner, 15.10).

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

const reissueInput = z.object({ certificateId: z.number().int().positive().max(2_147_483_647), name: z.string().max(1024) });

/**
 * The drawer's "Paranda nimi" (spec §6, D3): one certificate, the name as typed; reissueCertificate checks it with the student's rules and
 * re-issues under the same number (`reissued_at`), mailing nobody. Re-issued: the open page is refreshed. Bad input is notFound; a throw is
 * "failed", logged by the certificate's id only (never the name).
 */
export const reissueCertificateAction = adminAction(async (_admin, input: { certificateId: number; name: string }) => {
  const parsed = reissueInput.safeParse(input);
  if (!parsed.success) return { kind: "notFound" as const };
  try {
    const result = await reissueCertificate(getDb(), parsed.data.certificateId, parsed.data.name, new Date());
    if (result.kind === "reissued") refresh();
    return result;
  } catch (e) {
    logFailure(`[certificate] ${parsed.data.certificateId}: the re-issue failed`, e);
    return { kind: "failed" as const };
  }
});
