import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { signHs256 } from "@/server/payments/jwt";
import { montonioClient, type MontonioConfig } from "@/server/payments/montonio";
import { createFakeMontonio, isLocalUrl } from "../e2e/fake-montonio";
import { E2E_MONTONIO } from "../e2e/montonio-values";

// The e2e run's fake Montonio (tests/e2e/fake-montonio.ts) answers the app's real client: an order, the bank's "Makstud", the webhook it
// sends, the return's token and GET /orders all read back as Montonio's would. And it refuses what Montonio refuses, and what spec 4 forbids.

const servers: Server[] = [];
const listen = (server: Server) =>
  new Promise<string>((resolve) => {
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A stand-in for the app's notificationUrl: records every body it is sent. */
const webhookSink = async () => {
  const hooks: string[] = [];
  const url = await listen(createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      hooks.push(body);
      res.end("{}");
    });
  }));
  return { hooks, url };
};

test("an order, the bank's 'Makstud': the webhook and the return carry the same PAID token; GET /orders says PAID", async () => {
  const base = await listen(createFakeMontonio());
  const { hooks, url: hook } = await webhookSink();
  const config: MontonioConfig = { accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true };
  const client = montonioClient(config);
  const order = await client.createOrder({ reference: "MSLAB-M9", amountCents: 17550, locale: "et", returnUrl: "https://mslab.example/api/payments/return", notificationUrl: `${hook}/api/payments/notify` });
  expect(order.paymentUrl).toBe(`${base}/pay/${order.uuid}`);
  expect(await (await fetch(order.paymentUrl)).text()).toContain("MSLAB-M9 · 175.50 EUR");

  const paid = await fetch(order.paymentUrl, { method: "POST", body: new URLSearchParams({ status: "PAID" }), redirect: "manual" });
  expect(paid.status).toBe(303);
  const back = new URL(paid.headers.get("location")!);
  expect(`${back.origin}${back.pathname}`).toBe("https://mslab.example/api/payments/return");
  const fromReturn = client.verifyOrderToken(back.searchParams.get("order-token")!);
  expect(fromReturn).toMatchObject({ uuid: order.uuid, reference: "MSLAB-M9", status: "paid", amountCents: 17550, currency: "EUR", bank: "Testpank", expired: false });
  expect(hooks).toHaveLength(1);
  expect(client.verifyOrderToken((JSON.parse(hooks[0]) as { orderToken: string }).orderToken)).toEqual(fromReturn);
  expect(await client.fetchOrder(order.uuid)).toEqual({ uuid: order.uuid, reference: "MSLAB-M9", status: "paid", rawStatus: "PAID", amountCents: 17550, currency: "EUR", method: "paymentInitiation" });
  // a paid reference cannot be ordered again
  await expect(client.createOrder({ reference: "MSLAB-M9", amountCents: 17550, locale: "et", returnUrl: "https://mslab.example/r", notificationUrl: `${hook}/n` })).rejects.toThrow(/rejected/);
});

test("'Pooleli' sends no webhook; the test hook settles it later and sends one; 'Katkesta' is ABANDONED", async () => {
  const base = await listen(createFakeMontonio());
  const { hooks, url: hook } = await webhookSink();
  const client = montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true });
  const urls = { returnUrl: "https://mslab.example/api/payments/return", notificationUrl: `${hook}/api/payments/notify` };
  const a = await client.createOrder({ reference: "MSLAB-M10", amountCents: 1000, locale: "ru", ...urls });
  const pending = await fetch(a.paymentUrl, { method: "POST", body: new URLSearchParams({ status: "PENDING" }), redirect: "manual" });
  expect(client.verifyOrderToken(new URL(pending.headers.get("location")!).searchParams.get("order-token")!).status).toBe("pending");
  expect(hooks).toHaveLength(0);
  expect((await (await fetch(`${base}/_fake/orders/MSLAB-M10`)).json()).uuid).toBe(a.uuid);
  expect((await fetch(`${base}/_fake/settle/${a.uuid}`, { method: "POST", body: JSON.stringify({ status: "PAID" }) })).status).toBe(200);
  expect(hooks).toHaveLength(1);
  const b = await client.createOrder({ reference: "MSLAB-M11", amountCents: 1000, locale: "et", ...urls });
  const cancelled = await fetch(b.paymentUrl, { method: "POST", body: new URLSearchParams({ status: "ABANDONED" }), redirect: "manual" });
  expect(client.verifyOrderToken(new URL(cancelled.headers.get("location")!).searchParams.get("order-token")!)).toMatchObject({ status: "failed", rawStatus: "ABANDONED" });
});

test("a reference reused for an unpaid order replaces it, as at Montonio (the double-payment rule's re-send): the old page is gone, the new one works", async () => {
  const base = await listen(createFakeMontonio());
  const { url: hook } = await webhookSink();
  const client = montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true });
  const request = { reference: "MSLAB-M13", amountCents: 5000, locale: "et" as const, returnUrl: "https://mslab.example/r", notificationUrl: `${hook}/n` };
  const first = await client.createOrder(request);
  const second = await client.createOrder(request);
  expect(second.uuid).not.toBe(first.uuid);
  expect((await fetch(first.paymentUrl)).status).toBe(404);
  expect((await fetch(second.paymentUrl)).status).toBe(200);
  expect(await client.fetchOrder(first.uuid)).toBeNull();
  expect(await client.fetchOrder(second.uuid)).toMatchObject({ reference: "MSLAB-M13", status: "pending", amountCents: 5000 });
});

test("it refuses what Montonio refuses (another store's key) and what spec 4 forbids (preferredProvider, paymentReference, another method)", async () => {
  const base = await listen(createFakeMontonio());
  const post = (claims: Record<string, unknown>, secret: string = E2E_MONTONIO.secretKey) =>
    fetch(`${base}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: signHs256(claims, secret, { expiresInSeconds: 600 }) }) });
  const good = {
    accessKey: E2E_MONTONIO.accessKey, merchantReference: "MSLAB-M12", returnUrl: "https://mslab.example/r", notificationUrl: "https://mslab.example/n", currency: "EUR", grandTotal: 10, locale: "et",
    payment: { method: "paymentInitiation", amount: 10, currency: "EUR", methodOptions: { paymentDescription: "MS LAB MSLAB-M12" } },
  };
  expect((await post(good)).status).toBe(200);
  expect((await post(good, "another-secret-0123456789abcdef")).status).toBe(401);
  expect((await post({ ...good, accessKey: "someone-else" })).status).toBe(401);
  expect((await post({ ...good, payment: { ...good.payment, methodOptions: { paymentDescription: "x", preferredProvider: "HABAEE2X" } } })).status).toBe(400);
  expect((await post({ ...good, payment: { ...good.payment, methodOptions: { paymentDescription: "x", paymentReference: "123" } } })).status).toBe(400);
  expect((await post({ ...good, payment: { ...good.payment, method: "cardPayments" } })).status).toBe(400);
  expect((await post({ ...good, grandTotal: 10.001, payment: { ...good.payment, amount: 10.001 } })).status).toBe(400);
});

test("and the rest of the order's rules: amounts that agree and are positive, EUR, a locale it knows, a description, and a token that is not old", async () => {
  const base = await listen(createFakeMontonio());
  const send = (body: string) => fetch(`${base}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const post = (claims: Record<string, unknown>, opts: { nowSec?: number } = {}) =>
    send(JSON.stringify({ data: signHs256(claims, E2E_MONTONIO.secretKey, { expiresInSeconds: 600, ...opts }) }));
  const good = {
    accessKey: E2E_MONTONIO.accessKey, merchantReference: "MSLAB-M14", returnUrl: "https://mslab.example/r", notificationUrl: "https://mslab.example/n", currency: "EUR", grandTotal: 10, locale: "et",
    payment: { method: "paymentInitiation", amount: 10, currency: "EUR", methodOptions: { paymentDescription: "MS LAB MSLAB-M14" } },
  };
  const { payment } = good;
  const bad: Record<string, Record<string, unknown>> = {
    "amount differs from grandTotal": { ...good, payment: { ...payment, amount: 9 } },
    "zero": { ...good, grandTotal: 0, payment: { ...payment, amount: 0 } },
    "negative": { ...good, grandTotal: -5, payment: { ...payment, amount: -5 } },
    "a string for the amount": { ...good, grandTotal: "10.00", payment: { ...payment, amount: "10.00" } },
    "another currency": { ...good, currency: "USD", payment: { ...payment, currency: "USD" } },
    "a locale the store does not use": { ...good, locale: "en" },
    "no reference": { ...good, merchantReference: "" },
    "no notificationUrl": { ...good, notificationUrl: undefined },
    "no description": { ...good, payment: { ...payment, methodOptions: {} } },
    "a paymentReference beside the payment": { ...good, paymentReference: "123" },
  };
  for (const [what, claims] of Object.entries(bad)) expect((await post(claims)).status, what).toBe(400);
  // a token past its exp, no token and no JSON are 401, not an order
  expect((await post(good, { nowSec: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
  expect((await send(JSON.stringify({ data: "" }))).status).toBe(401);
  expect((await send("not json")).status).toBe(401);
  expect((await post(good)).status).toBe(200);
});

test("GET /orders wants Montonio's Bearer token and knows its orders only; the bank page escapes what it prints; /health answers", async () => {
  const base = await listen(createFakeMontonio());
  expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
  const client = montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true });
  expect(await client.fetchOrder("no-such-order")).toBeNull();
  const get = (token?: string) => fetch(`${base}/orders/x`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  expect((await get()).status).toBe(401);
  expect((await get(signHs256({ accessKey: E2E_MONTONIO.accessKey }, "another-secret-0123456789abcdef", { expiresInSeconds: 3600 }))).status).toBe(401);
  expect((await get(signHs256({ accessKey: "someone-else" }, E2E_MONTONIO.secretKey, { expiresInSeconds: 3600 }))).status).toBe(401);
  expect((await get(signHs256({ accessKey: E2E_MONTONIO.accessKey }, E2E_MONTONIO.secretKey, { expiresInSeconds: 3600 }))).status).toBe(404);
  const order = await client.createOrder({ reference: `MSLAB-M15"><script>`, amountCents: 100, locale: "et", returnUrl: "https://mslab.example/r", notificationUrl: "https://mslab.example/n" });
  const page = await (await fetch(order.paymentUrl)).text();
  expect(page).not.toContain("<script>");
  expect((await fetch(`${base}/no-such-route`)).status).toBe(404);
});

test("the webhook goes only to this machine: a notificationUrl anywhere else is logged and skipped, and the bank still sends the browser back (Task 10)", async () => {
  const base = await listen(createFakeMontonio());
  const client = montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true });
  const elsewhere = ["https://shop.example/api/payments/notify", "http://localhost.evil.example/n", "http://127.0.0.1.evil.example/n", "http://localhost@evil.example/n", "not a url"];
  const real = globalThis.fetch;
  const asked: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    asked.push(String(input instanceof Request ? input.url : input));
    return real(input, init);
  });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const [i, notificationUrl] of elsewhere.entries()) {
      const order = await client.createOrder({ reference: `MSLAB-M2${i}`, amountCents: 1000, locale: "et", returnUrl: "https://mslab.example/r", notificationUrl });
      const paid = await fetch(order.paymentUrl, { method: "POST", body: new URLSearchParams({ status: "PAID" }), redirect: "manual" });
      expect(paid.status, notificationUrl).toBe(303);
      expect(new URL(paid.headers.get("location")!).origin, notificationUrl).toBe("https://mslab.example");
    }
    // a later settle by the test hook is a webhook too
    const later = await client.createOrder({ reference: "MSLAB-M30", amountCents: 1000, locale: "et", returnUrl: "https://mslab.example/r", notificationUrl: elsewhere[0] });
    expect((await fetch(`${base}/_fake/settle/${later.uuid}`, { method: "POST", body: JSON.stringify({ status: "PAID" }) })).status).toBe(200);
    expect(asked.filter((url) => !url.startsWith(base))).toEqual([]); // not one request left this machine
    const noted = logged.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("[fake-montonio]") && line.includes("not sent"));
    expect(noted).toHaveLength(elsewhere.length + 1);
    expect(noted.join("\n")).not.toContain("shop.example/api"); // the host is named, not the whole address
  } finally {
    spy.mockRestore();
    logged.mockRestore();
  }
});

test("isLocalUrl: localhost, 127.0.0.1 and [::1] (any port, http or https) are this machine; a name that only starts or ends like it, credentials and junk are not", () => {
  for (const url of ["http://localhost:3000/api/payments/notify", "http://LOCALHOST/n", "http://127.0.0.1:3100/n", "http://[::1]:3000/n", "https://localhost/n"]) expect(isLocalUrl(url), url).toBe(true);
  for (const url of ["https://shop.example/n", "http://localhost.evil.example/n", "http://evil.example/localhost", "http://localhost@evil.example/n", "http://user:pw@localhost/n", "http://0.0.0.0/n", "ftp://localhost/n", "localhost:3000", "", "not a url"])
    expect(isLocalUrl(url), url).toBe(false);
});
