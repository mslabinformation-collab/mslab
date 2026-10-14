"use server";

import { z } from "zod";
import { sendAssessment, type AssessmentInput, type AssessmentResult } from "../assessment";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import { adminSendDeps } from "../send-deps";

// Maria's assessment (phase e-course completion, spec §5.3): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in
// ../assessment.ts. The screen keeps its own state, so nothing is refreshed here. Task 12 adds the test review's actions to this file.

const item = z.object({
  accessId: z.number().int().positive().max(2_147_483_647),
  // the notes' version the screen confirmed (0: no protocol yet, which the server answers as nothing to send)
  version: z.number().int().min(0).max(2_147_483_647),
  // the protocol's row the screen showed (null: none yet): a zod object drops a key it does not list, so it is listed
  protocolId: z.number().int().positive().max(2_147_483_647).nullable(),
  // the student's round the screen showed: a new submission since then is "stale" (R3 leaves the version)
  round: z.number().int().min(0).max(2_147_483_647),
});

const deps = () => adminSendDeps("[assessment]");

/** "Saada hinnang" (and an e-course's notes-only "Saada"): one access, at the version and round the screen showed; a throw is "failed", logged by the access's id. */
export const sendAssessmentAction = adminAction(async (_admin, input: AssessmentInput): Promise<AssessmentResult | { kind: "failed" }> => {
  const parsed = item.safeParse(input);
  if (!parsed.success) return { kind: "notFound" };
  try {
    return await sendAssessment(await deps(), parsed.data);
  } catch (e) {
    logFailure(`[assessment] access ${parsed.data.accessId}: the send failed`, e);
    return { kind: "failed" };
  }
});
