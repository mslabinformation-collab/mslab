import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { newsletterCampaigns } from "@/db/schema";
import { makeTestDb } from "./helpers";

// Maria's campaign actions on a real (PGlite) database (newsletter campaigns, Task 4; the sending half is the 20.10 design's): „Salvesta“ and „Kopeeri“
// through their actions: what they answer, that a change refreshes the open page and a refusal does not, and that a failure is logged by its class
// only. The admin session and the cache are stand-ins (the guard is tests/unit/admin-guards.test.ts's).

const state = vi.hoisted(() => ({ db: null as unknown }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));

const actions = await import("@/server/actions/admin-newsletter");

let db: Db;

beforeAll(async () => {
  db = await makeTestDb();
  state.db = db;
});
beforeEach(async () => {
  await db.delete(newsletterCampaigns);
  cache.refresh.mockReset();
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Every line the actions logged, joined. */
const logged = () =>
  (["info", "error", "warn", "log"] as const)
    .flatMap((m) => (console[m] as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat())
    .map(String)
    .join("\n");

const CAMPAIGN = {
  name: "Oktoobri pakkumine",
  subject: { et: "Sügispakkumine", ru: "" },
  preheader: { et: "", ru: "" },
  imageKey: "",
  body: { et: "Esimene lõik.", ru: "" },
  code: "",
  buttonLabel: { et: "", ru: "" },
  buttonHref: "",
};

describe("the campaigns' actions: save and copy", () => {
  const saved = async () => {
    const r = await actions.saveCampaignAction({ id: null, draft: CAMPAIGN });
    if (!r.ok || !("id" in r)) throw new Error(JSON.stringify(r));
    cache.refresh.mockReset();
    return r.id;
  };

  test("saveCampaignAction: a new draft (`id: null`) and the same again in place; the page is refreshed; refused fields come back by name", async () => {
    const r = await actions.saveCampaignAction({ id: null, draft: CAMPAIGN });
    expect(r).toEqual({ ok: true, id: expect.any(Number) });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    const id = (r as { id: number }).id;
    expect(await actions.saveCampaignAction({ id, draft: { ...CAMPAIGN, name: "Uus nimi" } })).toEqual({ ok: true, id });
    expect((await db.select().from(newsletterCampaigns)).map((c) => c.name)).toEqual(["Uus nimi"]);
    cache.refresh.mockReset();
    expect(await actions.saveCampaignAction({ id, draft: { ...CAMPAIGN, name: "" } })).toEqual({ ok: false, fields: { name: "required" } });
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("saveCampaignAction: an id the page never sends is refused without a write; a sent campaign is `sent`, one that is gone `notFound`", async () => {
    for (const id of [0, -1, 1.5, "7" as unknown as number]) expect(await actions.saveCampaignAction({ id, draft: CAMPAIGN }), String(id)).toEqual({ ok: false, error: "notFound" });
    const id = await saved();
    await db.update(newsletterCampaigns).set({ status: "sent" }).where(eq(newsletterCampaigns.id, id));
    expect(await actions.saveCampaignAction({ id, draft: CAMPAIGN })).toEqual({ ok: false, error: "sent" });
    expect(await actions.saveCampaignAction({ id: id + 100, draft: CAMPAIGN })).toEqual({ ok: false, error: "notFound" });
  });

  test("copyCampaignAction: the new draft's id, the page refreshed; a campaign that is gone is `notFound`", async () => {
    const id = await saved();
    const copied = await actions.copyCampaignAction({ id });
    expect(copied).toEqual({ ok: true, id: expect.any(Number) });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    expect(await actions.copyCampaignAction({ id: id + 100 })).toEqual({ ok: false, error: "notFound" });
  });

  test("an id the page never sends to „Kopeeri“ is `notFound` without a read", async () => {
    for (const id of [0, -1, 1.5, "7" as unknown as number]) expect(await actions.copyCampaignAction({ id }), String(id)).toEqual({ ok: false, error: "notFound" });
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a throw: `server`, logged by its class only (never the message, which can hold an address)", async () => {
    state.db = new Proxy({}, {
      get() {
        throw new TypeError("boom: kati@example.com");
      },
    });
    try {
      expect(await actions.saveCampaignAction({ id: null, draft: CAMPAIGN })).toEqual({ ok: false, error: "server" });
      expect(await actions.copyCampaignAction({ id: 1 })).toEqual({ ok: false, error: "server" });
    } finally {
      state.db = db;
    }
    expect(logged()).toContain("TypeError");
    for (const secret of ["boom", "kati"]) expect(logged()).not.toContain(secret);
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});
