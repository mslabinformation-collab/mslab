import { beforeEach, expect, test, vi } from "vitest";

// "Saada hinnang" (server/actions/admin-assessment.ts) passes on what the screen names: the access, the version, the protocol's row (null:
// none yet) and the student's round it showed. The row and the round must survive the action's input check (a zod object drops a key it does
// not list), and anything else is refused before any work. The work itself (server/assessment.ts) is tests/db/assessment.test.ts.

const work = vi.hoisted(() => ({ sendAssessment: vi.fn() }));
// the test review's work and the page refresh: the action file imports both once Task 12 has added its two actions (their tests are Task 12's)
const tests = vi.hoisted(() => ({ reviewAttempt: vi.fn(), reopenTest: vi.fn() }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/server/assessment", () => work);
vi.mock("@/server/test-attempts", () => tests);
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "mslab.example" }) }));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/server/env", () => ({ serverEnv: () => ({ SITE_URL: "https://mslab.example" }) }));
vi.mock("@/server/kv", () => ({ serverKv: () => ({}) }));

const { reopenTestAction, reviewAttemptAction, sendAssessmentAction } = await import("@/server/actions/admin-assessment");

beforeEach(() => {
  work.sendAssessment.mockReset().mockResolvedValue({ kind: "stale", version: 3 });
  tests.reviewAttempt.mockReset();
  tests.reopenTest.mockReset();
  cache.refresh.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

test("a send passes on the access, the version, the row (null: none yet) and the round the screen showed; anything else is notFound and nothing is sent", async () => {
  expect(await sendAssessmentAction({ accessId: 4, version: 2, protocolId: 9, round: 1 })).toEqual({ kind: "stale", version: 3 });
  expect(work.sendAssessment.mock.calls[0][1]).toEqual({ accessId: 4, version: 2, protocolId: 9, round: 1 });
  await sendAssessmentAction({ accessId: 4, version: 0, protocolId: null, round: 0 });
  expect(work.sendAssessment.mock.calls[1][1]).toEqual({ accessId: 4, version: 0, protocolId: null, round: 0 });
  for (const bad of [
    { accessId: 0, version: 1, protocolId: 9, round: 1 },
    { accessId: 4, version: -1, protocolId: 9, round: 1 },
    { accessId: 4, version: 1, round: 1 },
    { accessId: 4, version: 1, protocolId: 0, round: 1 },
    { accessId: 4, version: 1, protocolId: 9 }, // the round is the screen's: a send without it is not one
    { accessId: 4, version: 1, protocolId: 9, round: -1 },
    { accessId: 4, version: 1, protocolId: 9, round: 1.5 },
  ])
    expect(await sendAssessmentAction(bad as never), JSON.stringify(bad)).toEqual({ kind: "notFound" });
  expect(work.sendAssessment).toHaveBeenCalledTimes(2);
});

test("a send that throws is 'failed', logged by the access's id only", async () => {
  work.sendAssessment.mockRejectedValue(new TypeError("boom"));
  expect(await sendAssessmentAction({ accessId: 4, version: 2, protocolId: 9, round: 1 })).toEqual({ kind: "failed" });
  expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("[assessment] access 4: the send failed: TypeError");
});

test("the test review passes on the attempt, the review and the time the page showed; the page is refreshed only once reviewed; bad input is notFound; a throw is 'failed'", async () => {
  const review = { qavatud1: { verdict: "fix", comment: "Lisa puhastamine." } };
  const shown = "2026-10-19T07:00:00.000Z";
  tests.reviewAttempt.mockResolvedValueOnce({ kind: "reviewed", status: "fix", completed: false });
  expect(await reviewAttemptAction({ attemptId: 41, review, submittedAt: shown })).toEqual({ kind: "reviewed", status: "fix", completed: false });
  expect(tests.reviewAttempt.mock.calls[0].slice(1)).toEqual(["admin@example.test", 41, review, shown]);
  expect(cache.refresh).toHaveBeenCalledTimes(1);
  tests.reviewAttempt.mockResolvedValueOnce({ kind: "stale" }); // rewritten since, or reviewed on her other device: nothing changed
  expect(await reviewAttemptAction({ attemptId: 41, review, submittedAt: shown })).toEqual({ kind: "stale" });
  expect(cache.refresh).toHaveBeenCalledTimes(1);
  for (const bad of [{ attemptId: 0, review, submittedAt: shown }, { attemptId: 41, review }, { attemptId: 41, review, submittedAt: "" }])
    expect(await reviewAttemptAction(bad as never), JSON.stringify(bad)).toEqual({ kind: "notFound" });
  expect(tests.reviewAttempt).toHaveBeenCalledTimes(2);
  tests.reviewAttempt.mockRejectedValueOnce(new TypeError("boom"));
  expect(await reviewAttemptAction({ attemptId: 41, review, submittedAt: shown })).toEqual({ kind: "failed" });
  expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("[test] attempt 41: the review failed: TypeError");
  expect(cache.refresh).toHaveBeenCalledTimes(1);
});

test("'Ava test uuesti' passes on the access and never refreshes the page (its row, with the confirmation, stays until the next load); bad input is notFound; a throw is 'failed'", async () => {
  tests.reopenTest.mockResolvedValueOnce({ kind: "reopened", triesLeft: 3 });
  expect(await reopenTestAction({ accessId: 9 })).toEqual({ kind: "reopened", triesLeft: 3 });
  expect(tests.reopenTest.mock.calls[0].slice(1)).toEqual(["admin@example.test", 9]);
  expect(cache.refresh).not.toHaveBeenCalled(); // a refresh would take the row out of "Katsed otsas" and its "Test on uuesti avatud" line with it
  tests.reopenTest.mockResolvedValueOnce({ kind: "notNeeded" });
  expect(await reopenTestAction({ accessId: 9 })).toEqual({ kind: "notNeeded" });
  expect(cache.refresh).not.toHaveBeenCalled();
  for (const bad of [{ accessId: 0 }, { accessId: 1.5 }, {}]) expect(await reopenTestAction(bad as never), JSON.stringify(bad)).toEqual({ kind: "notFound" });
  expect(tests.reopenTest).toHaveBeenCalledTimes(2);
  tests.reopenTest.mockRejectedValueOnce(new TypeError("boom"));
  expect(await reopenTestAction({ accessId: 9 })).toEqual({ kind: "failed" });
  expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("[test] access 9: the reopen failed: TypeError");
  expect(cache.refresh).not.toHaveBeenCalled();
});
