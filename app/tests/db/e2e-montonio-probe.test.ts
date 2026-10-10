import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { payments } from "@/db/schema";
import { montonioClient } from "@/server/payments/montonio";
import { handleNotify } from "@/server/payments/routes";
import { probeOrderToken } from "../e2e/montonio-guard";
import { E2E_MONTONIO } from "../e2e/montonio-values";
import { settleDeps, SITE } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// The contract the e2e run's guard relies on (tests/e2e/montonio-guard.ts): the probe's webhook token, sent to the app's own webhook, is
// answered 200 by an app configured with the e2e run's made-up keys, and 400 by an app with any other keys (the owner's sandbox keys in
// .env.local, say); and it changes nothing in the database.

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const answer = async (secretKey: string, accessKey = E2E_MONTONIO.accessKey): Promise<number> => {
  const montonio = montonioClient({ accessKey, secretKey, baseUrl: "http://127.0.0.1:1", live: false, mock: true });
  const { deps } = settleDeps(db, montonio, new Date());
  const request = new Request(`${SITE}/api/payments/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderToken: probeOrderToken() }) });
  return (await handleNotify(request, deps)).status;
};

test("the e2e keys: 200 and nothing stored; any other secret: 400", async () => {
  expect(await answer(E2E_MONTONIO.secretKey)).toBe(200);
  expect(await db.select().from(payments)).toEqual([]);
  expect(await answer("a-sandbox-secret-that-is-not-the-fakes-0123456789")).toBe(400);
});
