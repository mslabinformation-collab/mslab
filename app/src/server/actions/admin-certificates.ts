"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { adminAction } from "../auth";
import { reissueCertificate } from "../certificates";
import { logFailure } from "../log";

// The e-course certificate's admin actions (phase 3d, spec §6): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in
// ../certificates.ts. Seaded's "Tunnistus" card autosaves on its route (api/admin/seaded/certificate, admin UX pass piece 3b); "Paranda nimi"
// refreshes the open page (the drawer's line and the register show the new name). There is no signature to upload: the signature is the trainer's
// name, one of the card's fields (owner, 15.10).

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
