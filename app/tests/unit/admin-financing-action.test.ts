import { beforeEach, describe, expect, test, vi } from "vitest";

// Seaded's „Salvesta“ on the card „Järelmaks (Inbank)“ (server/actions/admin-financing.ts, instalments Task 5, spec D4): a boolean is stored as
// settings.financing = { enabled }, the course pages and the carts are revalidated through the settings' path, the page refreshes; anything
// that is not a boolean is refused before anything is written; a throw is `server`, logged by its label and the class only.

const queries = vi.hoisted(() => ({ setSetting: vi.fn() }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/db/queries/admin", () => queries);
vi.mock("next/cache", () => cache);
vi.mock("@/server/public-cache", () => pub);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
vi.mock("@/db/client", () => ({ getDb: () => ({ marker: "db" }) }));

const { saveFinancingSettingsAction } = await import("@/server/actions/admin-financing");

beforeEach(() => {
  for (const fn of [queries.setSetting, cache.refresh, pub.revalidatePublic]) fn.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("saveFinancingSettingsAction", () => {
  test.each([true, false])("{ enabled: %s } is stored under the key `financing`, the course pages and the carts are revalidated, the page refreshes", async (enabled) => {
    queries.setSetting.mockResolvedValue(undefined);
    expect(await saveFinancingSettingsAction({ enabled })).toEqual({ ok: true, enabled });
    expect(queries.setSetting).toHaveBeenCalledTimes(1);
    expect(queries.setSetting).toHaveBeenCalledWith({ marker: "db" }, "financing", { enabled });
    // the part is named: server/cache-targets.ts maps "financing" to the course pages and the carts
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "settings", parts: ["financing"] });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  test("the pages are revalidated only after the setting is stored", async () => {
    const order: string[] = [];
    queries.setSetting.mockImplementation(async () => void order.push("store"));
    pub.revalidatePublic.mockImplementation(() => void order.push("revalidate"));
    cache.refresh.mockImplementation(() => void order.push("refresh"));
    await saveFinancingSettingsAction({ enabled: true });
    expect(order).toEqual(["store", "revalidate", "refresh"]);
  });

  test.each([
    ["a string", { enabled: "true" }],
    ["a number", { enabled: 1 }],
    ["zero", { enabled: 0 }],
    ["null", { enabled: null }],
    ["no field", {}],
    ["a bare boolean", true],
    ["a string body", "yes"],
    ["null", null],
    ["undefined", undefined],
    ["an array", [true]],
  ])("anything but a boolean is refused (%s): nothing stored, nothing revalidated, no refresh", async (_name, raw) => {
    expect(await saveFinancingSettingsAction(raw)).toEqual({ ok: false, error: "invalid" });
    expect(queries.setSetting).not.toHaveBeenCalled();
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("only `enabled` is stored: nothing else the browser sent goes into the setting", async () => {
    queries.setSetting.mockResolvedValue(undefined);
    await saveFinancingSettingsAction({ enabled: true, price: 1, extra: "x" });
    expect(queries.setSetting).toHaveBeenCalledWith({ marker: "db" }, "financing", { enabled: true });
  });

  test("a throw is `server`, logged by its label and the class only (never its text); nothing is revalidated and the page is not refreshed", async () => {
    queries.setSetting.mockRejectedValue(new TypeError("boom: kati@example.test"));
    expect(await saveFinancingSettingsAction({ enabled: true })).toEqual({ ok: false, error: "server" });
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain("[financing] the settings save failed: TypeError");
    expect(logged).not.toContain("kati");
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});
