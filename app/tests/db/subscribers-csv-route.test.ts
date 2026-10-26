import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { subscribers } from "@/db/schema";
import { createSession } from "@/server/auth";
import { makeTestDb } from "./helpers";

// „Laadi alla (CSV)“ of Uudiskiri → Tellijad (admin UX pass, piece 3b Task 7; README B5, piece3-texts P-13): GET /api/admin/subscribers.csv?otsi=…&olek=…
// holds exactly the rows the screen shows for the same address — the search by a part of an address (a percent sign or an underscore is itself) and
// the state (kinnitatud | ootab) — all of them, not a page of 50 — and names its file after the state. On PGlite, with the admin's session cookie faked
// (as tests/db/registration-note-route.test.ts does).

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import { GET } from "@/app/api/admin/subscribers.csv/route";

const ORIGIN = "https://mslab.example";
let db: Db;
let tokens = 0;

const at = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));
const sub = (email: string, confirmed: boolean, hour: number, locale = "et") =>
  db.insert(subscribers).values({ email, locale, token: `tok${++tokens}`, consentAt: at(hour), confirmedAt: confirmed ? at(hour) : null });

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.cookie = await createSession(db, "admin@example.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const get = (query = "") => GET(new Request(`${ORIGIN}/api/admin/subscribers.csv${query}`), undefined);
/** The addresses in the file, in order (the first cell of each row after the header). */
const addressesOf = (csv: string) =>
  csv
    .split("\r\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => line.split(",")[0]);

describe("the subscribers' CSV is the current filter of Tellijad", () => {
  beforeEach(async () => {
    await sub("kati.kask@example.test", true, 1);
    await sub("kaie@example.test", false, 2);
    await sub("mari@sample.test", false, 3, "ru");
    await sub("juta@sample.test", true, 4);
    await sub("a_b@example.test", true, 5);
    await sub("axb@example.test", false, 6);
    await sub("50%off@example.test", true, 7);
    await sub("500off@example.test", true, 8);
  });

  test("without a filter every row, newest consent first; the file is named mslab-uudiskiri and is never cached", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="mslab-uudiskiri-\d{4}-\d{2}-\d{2}\.csv"$/);
    // (the file starts with a byte order mark for spreadsheets; Response.text() would take it off, so the bytes are read)
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).slice(1);
    expect(csv.split("\r\n")[0]).toBe("E-post,Keel,Nõusolek,Kinnitatud,Kinnitamise aeg");
    expect(addressesOf(csv)).toEqual(["500off@example.test", "50%off@example.test", "axb@example.test", "a_b@example.test", "juta@sample.test", "mari@sample.test", "kaie@example.test", "kati.kask@example.test"]);
  });

  test("?olek= keeps one state and names the file after it: kinnitatud, ootab (mslab-uudiskiri-kinnitatud, mslab-uudiskiri-ootab-kinnitust)", async () => {
    const confirmed = await get("?olek=kinnitatud");
    expect(confirmed.headers.get("content-disposition")).toMatch(/^attachment; filename="mslab-uudiskiri-kinnitatud-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(addressesOf(await confirmed.text())).toEqual(["500off@example.test", "50%off@example.test", "a_b@example.test", "juta@sample.test", "kati.kask@example.test"]);
    const pending = await get("?olek=ootab");
    expect(pending.headers.get("content-disposition")).toMatch(/^attachment; filename="mslab-uudiskiri-ootab-kinnitust-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(addressesOf(await pending.text())).toEqual(["axb@example.test", "mari@sample.test", "kaie@example.test"]);
  });

  test("?otsi= keeps the addresses that hold the text, in either case; with ?olek= both; a percent sign or an underscore is itself", async () => {
    expect(addressesOf(await (await get("?otsi=KA")).text())).toEqual(["kaie@example.test", "kati.kask@example.test"]);
    expect(addressesOf(await (await get("?otsi=ka&olek=ootab")).text())).toEqual(["kaie@example.test"]);
    expect(addressesOf(await (await get("?otsi=sample&olek=kinnitatud")).text())).toEqual(["juta@sample.test"]);
    expect(addressesOf(await (await get("?otsi=%25")).text())).toEqual(["50%off@example.test"]);
    expect(addressesOf(await (await get("?otsi=_")).text())).toEqual(["a_b@example.test"]);
    expect(addressesOf(await (await get("?otsi=a_b&olek=ootab")).text())).toEqual([]);
    expect(addressesOf(await (await get("?otsi=%25%25")).text())).toEqual([]);
    expect(addressesOf(await (await get("?otsi=nobody")).text())).toEqual([]);
    // (a search of spaces is no search, as on the page)
    expect(addressesOf(await (await get("?otsi=%20%20")).text())).toHaveLength(8);
  });

  test("the screen and the file agree: the same address gives the same rows (the page's own query is the file's)", async () => {
    const { listSubscribers } = await import("@/db/queries/admin");
    const { subscriberFilterOf } = await import("@/domain/subscribers");
    for (const query of ["", "?olek=kinnitatud", "?olek=ootab", "?otsi=ka", "?otsi=example&olek=ootab", "?otsi=%25", "?kinnitatud=1", "?olek=x", "?olek=constructor&otsi=ka"]) {
      const filter = subscriberFilterOf(Object.fromEntries(new URL(`${ORIGIN}/x${query}`).searchParams));
      const onScreen = (await listSubscribers(db, filter)).map((r) => r.email);
      expect(addressesOf(await (await get(query)).text()), query).toEqual(onScreen);
    }
  });

  test("the former „Lae alla kinnitatud (CSV)“ link, ?kinnitatud=1, still gives the confirmed ones only (a page left open before the change)", async () => {
    const res = await get("?kinnitatud=1");
    expect(res.headers.get("content-disposition")).toMatch(/filename="mslab-uudiskiri-kinnitatud-/);
    const list = addressesOf(await res.text());
    expect(list).toContain("kati.kask@example.test");
    expect(list).not.toContain("kaie@example.test");
    expect(list).toHaveLength(5);
  });

  test("a word that is no state is no state (the page shows every row for it too); the whole filtered list, not a page of 50", async () => {
    expect(addressesOf(await (await get("?olek=x")).text())).toHaveLength(8);
    expect(addressesOf(await (await get("?olek=constructor")).text())).toHaveLength(8);
    expect(addressesOf(await (await get("?olek=kinnitatud&olek=ootab")).text())).toHaveLength(8); // (twice: Next gives the page a list, which is no state)
    expect(addressesOf(await (await get("?otsi=ka&otsi=sample")).text())).toHaveLength(8); // (and no search)
    for (let i = 0; i < 60; i++) await sub(`bulk${i}@bulk.test`, i % 3 === 0, 9 + (i % 10));
    expect(addressesOf(await (await get("?otsi=bulk")).text())).toHaveLength(60);
    expect(addressesOf(await (await get("?otsi=bulk&olek=kinnitatud")).text())).toHaveLength(20);
  });

  test("only a signed-in admin: 401 JSON with no address in it", async () => {
    state.cookie = undefined;
    const res = await get("?otsi=ka");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).not.toContain("@");
  });
});
