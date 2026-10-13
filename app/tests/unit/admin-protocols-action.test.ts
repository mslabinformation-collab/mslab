import { beforeEach, expect, test, vi } from "vitest";

// The send actions (server/actions/admin-protocols.ts) pass on what the screen names: the registration, the version and the protocol's row. The
// row must survive the action's input check (a zod object drops a key it does not list), else the server could not tell a protocol deleted with
// the account and made again from the one the screen showed. The work itself (server/protocols.ts) is tests/db/protocols-send.test.ts.

const work = vi.hoisted(() => ({ sendProtocol: vi.fn(), sendProtocols: vi.fn() }));
vi.mock("@/server/protocols", () => work);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "mslab.example" }) }));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/server/env", () => ({ serverEnv: () => ({ SITE_URL: "https://mslab.example" }) }));
vi.mock("@/server/kv", () => ({ serverKv: () => ({}) }));

const { sendProtocolAction, sendProtocolsAction } = await import("@/server/actions/admin-protocols");

beforeEach(() => {
  work.sendProtocol.mockReset().mockResolvedValue({ kind: "stale", version: 1 });
  work.sendProtocols.mockReset().mockResolvedValue([]);
});

test("a send passes on the protocol's row the screen showed; one without it (an older screen) is passed on without it", async () => {
  await sendProtocolAction({ registrationId: 7, version: 2, protocolId: 9 });
  expect(work.sendProtocol.mock.calls[0][1]).toEqual({ registrationId: 7, version: 2, protocolId: 9 });
  await sendProtocolAction({ registrationId: 7, version: 2 });
  expect(work.sendProtocol.mock.calls[1][1]).toEqual({ registrationId: 7, version: 2 });
});

test("the bulk send passes on each protocol's row", async () => {
  await sendProtocolsAction([
    { registrationId: 7, version: 2, protocolId: 9 },
    { registrationId: 8, version: 1 },
  ]);
  expect(work.sendProtocols.mock.calls[0][1]).toEqual([
    { registrationId: 7, version: 2, protocolId: 9 },
    { registrationId: 8, version: 1 },
  ]);
});
