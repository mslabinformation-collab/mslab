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

const { sendAssessmentAction } = await import("@/server/actions/admin-assessment");

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
