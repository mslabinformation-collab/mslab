import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { payments } from "@/db/schema";
import { signHs256 } from "@/server/payments/jwt";
import { handleNotify, MAX_NOTIFY_BODY } from "@/server/payments/routes";
import { contactCourse, orderToken, pendingPayment, registrationOn, settleDeps, SITE, stubMontonio, TEST_MONTONIO } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// POST /api/payments/notify, Montonio's webhook (phase 2b, spec 4, 7.4): 400 only for a token it cannot verify, 200 for everything it
// understands (an unknown reference and a refund webhook too), 503 when the database fails or a token in doubt cannot be confirmed (Montonio
// retries 13 times over 48 hours). 404 without payments. The body is at most 8 KB. Never a redirect.

const NOW = new Date("2026-10-09T10:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const post = (body: unknown, init: RequestInit = {}) => new Request(`${SITE}/api/payments/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...init });
const answer = async (res: Response) => [res.status, await res.json(), res.headers.get("cache-control")];
const redirected = (res: Response) => res.status >= 300 && res.status < 400;

test("without payments: 404", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(await answer(await handleNotify(post({ orderToken: "x" }), { ...deps, montonio: null }))).toEqual([404, { ok: false }, "no-store"]);
});

test("a token it cannot verify is 400: none, not JSON, another secret, alg none, no merchantReference, a body over 8 KB", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"merchantReference":"MSLAB-M1","paymentStatus":"PAID"}').toString("base64url")}.`;
  for (const body of [{}, "not json", { orderToken: 42 }, { orderToken: "a.b.c" }, { orderToken: none },
    { orderToken: orderToken({ reference: "MSLAB-M1", amountCents: 100, providerUuid: "u" }, {}, { secret: "another-secret-0123456789abcdef" }) },
    { orderToken: signHs256({ paymentStatus: "PAID" }, TEST_MONTONIO.secretKey, { expiresInSeconds: 600 }) },
    { orderToken: "x".repeat(MAX_NOTIFY_BODY + 1) }])
    expect((await handleNotify(post(body), deps)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
});

test("a refund webhook ({ refundToken }) is understood and not used: 200", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(await answer(await handleNotify(post({ refundToken: "anything" }), deps))).toEqual([200, { ok: true }, "no-store"]);
});

test("a good token: 200 and settled; again: 200 and nothing new; an unknown reference: 200", async () => {
  const m = stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const { deps, flush } = settleDeps(db, m.montonio, NOW);
  expect(await answer(await handleNotify(post({ orderToken: orderToken(p) }), deps))).toEqual([200, { ok: true }, "no-store"]);
  expect((await handleNotify(post({ orderToken: orderToken(p) }), deps)).status).toBe(200);
  await flush();
  expect(m.mails()).toHaveLength(2); // her mail and Maria's, once
  expect((await handleNotify(post({ orderToken: orderToken({ reference: "MSLAB-M999", amountCents: 100, providerUuid: "u" }) }), deps)).status).toBe(200);
});

test("a token in doubt that Montonio cannot confirm: 503 (Montonio retries)", async () => {
  const m = stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const { deps } = settleDeps(db, m.montonio, NOW);
  expect(await answer(await handleNotify(post({ orderToken: orderToken(p, { accessKey: "someone-else" }) }), deps))).toEqual([503, { ok: false }, "no-store"]);
});

test("a database failure: 503, logged without details", async () => {
  const m = stubMontonio();
  const { deps } = settleDeps(db, m.montonio, NOW);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const broken = { select: () => { throw Object.assign(new Error("connect ECONNREFUSED db.example.com"), { code: "ECONNREFUSED" }); } } as unknown as Db;
  const res = await handleNotify(post({ orderToken: orderToken({ reference: "MSLAB-M1", amountCents: 100, providerUuid: "u" }) }), { ...deps, db: broken });
  expect(res.status).toBe(503);
  expect(log.mock.calls.map((c) => c[0])).toEqual(["[payments] webhook: not settled: Error (code ECONNREFUSED)"]);
});

describe("the body is at most 8 KB, counted in bytes and read no further than that", () => {
  test("a good token with padding past the limit is refused, though the token itself would have been paid", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    expect((await handleNotify(post({ orderToken: orderToken(p), pad: "x".repeat(MAX_NOTIFY_BODY) }), deps)).status).toBe(400);
    expect((await handleNotify(post({ orderToken: orderToken(p), pad: "ä".repeat(MAX_NOTIFY_BODY / 2) }), deps)).status).toBe(400); // under 8 192 characters, over 8 192 bytes
    expect((await db.select().from(payments))[0]?.status).toBe("pending");
    expect((await handleNotify(post({ orderToken: orderToken(p), pad: "x".repeat(2000) }), deps)).status).toBe(200); // a normal body still passes
  });

  test("a declared length over the limit is refused without reading", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    const res = await handleNotify(post({ orderToken: orderToken(p) }, { headers: { "content-type": "application/json", "content-length": String(MAX_NOTIFY_BODY + 1) } }), deps);
    expect(res.status).toBe(400);
    expect((await db.select().from(payments))[0]?.status).toBe("pending");
  });

  test("a stream that never says how long it is, is cut off at the limit instead of being read to the end", async () => {
    const m = stubMontonio();
    const { deps } = settleDeps(db, m.montonio, NOW);
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulled > 1000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await handleNotify(new Request(`${SITE}/api/payments/notify`, { method: "POST", body, duplex: "half" } as RequestInit & { duplex: "half" }), deps);
    expect(res.status).toBe(400);
    expect(pulled).toBeLessThan(10);
  });
});

describe("never a redirect, whatever the answer", () => {
  test("every answer is 200, 400, 404 or 503, with no Location header", async () => {
    const m = stubMontonio();
    const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
    const { deps } = settleDeps(db, m.montonio, NOW);
    const broken = { select: () => { throw new Error("down"); } } as unknown as Db;
    const answers = [
      await handleNotify(post({ orderToken: orderToken(p) }), deps),
      await handleNotify(post({ orderToken: orderToken(p) }), deps),
      await handleNotify(post({ orderToken: orderToken(p, { accessKey: "someone-else" }) }), deps),
      await handleNotify(post({ orderToken: orderToken({ reference: "MSLAB-M999", amountCents: 100, providerUuid: "u" }) }), deps),
      await handleNotify(post({ refundToken: "anything" }), deps),
      await handleNotify(post("not json"), deps),
      await handleNotify(post({ orderToken: "a.b.c" }), deps),
      await handleNotify(post({ orderToken: orderToken(p) }), { ...deps, db: broken }),
      await handleNotify(post({ orderToken: orderToken(p) }), { ...deps, montonio: null }),
    ];
    expect(answers.map((r) => r.status)).toEqual([200, 200, 503, 200, 200, 400, 400, 503, 404]);
    for (const res of answers) {
      expect(redirected(res), String(res.status)).toBe(false);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

test("the webhook's logs name no token, address or key (a refused token, a database failure, a token in doubt)", async () => {
  const lines: string[] = [];
  for (const method of ["info", "error", "warn", "log"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  const m = stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const { deps } = settleDeps(db, m.montonio, NOW);
  const refused = orderToken(p, {}, { secret: "another-secret-0123456789abcdef" });
  const doubtful = orderToken(p, { accessKey: "someone-else" });
  const good = orderToken(p);
  const broken = { select: () => { throw Object.assign(new Error("connect ECONNREFUSED kati@example.com"), { code: "ECONNREFUSED" }); } } as unknown as Db;
  await handleNotify(post({ orderToken: refused }), deps);
  await handleNotify(post({ orderToken: doubtful }), deps);
  await handleNotify(post({ orderToken: good }), { ...deps, db: broken });
  await handleNotify(post({ orderToken: good }), deps);
  const log = lines.join("\n");
  expect(lines.length).toBeGreaterThan(2);
  for (const secret of [refused, doubtful, good, ...good.split("."), "kati@example.com", "kati@example.test", TEST_MONTONIO.secretKey, TEST_MONTONIO.accessKey]) expect(log).not.toContain(secret);
});
