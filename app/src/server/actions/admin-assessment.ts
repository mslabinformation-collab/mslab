"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { sendAssessment, type AssessmentInput, type AssessmentResult } from "../assessment";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import { adminSendDeps } from "../send-deps";
import { reopenTest, reviewAttempt, type ReviewResult } from "../test-attempts";

// Maria's assessment (phase e-course completion, spec §5.3): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in
// ../assessment.ts. "Saada hinnang" refreshes nothing: the screen keeps its own state. The test review's "Saada" and "Ava test uuesti" refresh the open admin page once they changed something (the attempt is read-only now, Hindamine's badge has one less).

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

const attemptInput = z.object({
  attemptId: z.number().int().positive().max(2_147_483_647),
  review: z.unknown(),
  // the attempt's submittedAt (ISO) as the review page showed it: a review of answers the student has rewritten since is stale
  submittedAt: z.string().min(1).max(64),
});
const accessInput = z.object({ accessId: z.number().int().positive().max(2_147_483_647) });

/**
 * The test review's "Saada" (spec §5.4): Maria's verdicts and comments on the open answers of one attempt waiting for her (the checks are
 * server/test-attempts.ts reviewAttempt's), for the answers the page showed (`submittedAt`; another time is `stale`); the student is mailed
 * after the answer. The open page is refreshed once reviewed: the attempt is read-only now, and Hindamine's badge has one less.
 */
export const reviewAttemptAction = adminAction(
  async ({ email }, input: { attemptId: number; review: unknown; submittedAt: string }): Promise<ReviewResult | { kind: "failed" }> => {
    const parsed = attemptInput.safeParse(input);
    if (!parsed.success) return { kind: "notFound" };
    try {
      const result = await reviewAttempt(await adminSendDeps("[test]"), email, parsed.data.attemptId, parsed.data.review, parsed.data.submittedAt);
      if (result.kind === "reviewed") refresh();
      return result;
    } catch (e) {
      logFailure(`[test] attempt ${parsed.data.attemptId}: the review failed`, e);
      return { kind: "failed" };
    }
  },
);

type ReopenOutcome = Awaited<ReturnType<typeof reopenTest>> | { kind: "failed" };

/** "Ava test uuesti" (spec §5.2, §5.5), after its confirmation: the course's tries once more for an access whose tries are used up; she is mailed while her access runs. */
export const reopenTestAction = adminAction(async ({ email }, input: { accessId: number }): Promise<ReopenOutcome> => {
  const parsed = accessInput.safeParse(input);
  if (!parsed.success) return { kind: "notFound" };
  try {
    const result = await reopenTest(await adminSendDeps("[test]"), email, parsed.data.accessId);
    if (result.kind === "reopened") refresh();
    return result;
  } catch (e) {
    logFailure(`[test] access ${parsed.data.accessId}: the reopen failed`, e);
    return { kind: "failed" };
  }
});
