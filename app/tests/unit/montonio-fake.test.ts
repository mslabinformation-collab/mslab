import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { billingAddressOf } from "@/domain/financing";
import { signHs256 } from "@/server/payments/jwt";
import { montonioClient, type MontonioConfig } from "@/server/payments/montonio";
import { refuseOffMachineFetch } from "../fakes";
import { createFakeMontonio, isLocalUrl, startFakeMontonio } from "../e2e/fake-montonio";
import { E2E_MONTONIO } from "../e2e/montonio-values";

// The e2e run's fake Montonio (tests/e2e/fake-montonio.ts) answers the app's real client: an order, the bank's "Makstud", the webhook it
// sends, the return's token and GET /orders all read back as Montonio's would. And it refuses what Montonio refuses, and what spec 4 forbids.

const servers: Server[] = [];
const listen = (server: Server) =>
  new Promise<string>((resolve) => {
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
// Nothing here may reach beyond this machine, whether the fake behaves or not: the fake's webhook goes through the global fetch, which refuses (and
// records) any address that is not localhost, 127.0.0.1 or [::1].
let offMachine: ReturnType<typeof refuseOffMachineFetch>;
beforeEach(() => {
  offMachine = refuseOffMachineFetch();
});
afterEach(async () => {
  offMachine.restore();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

test("the run's fake listens on 127.0.0.1 only (never on the network), and its localhost address still reaches it", async () => {
  const server = await startFakeMontonio(0);
  servers.push(server);
  const { address, port } = server.address() as AddressInfo;
  expect(address).toBe("127.0.0.1");
  // E2E_MONTONIO.url is http://localhost:<port>: Node's fetch tries every address localhost has (::1 and 127.0.0.1), as the browser does
  const res = await fetch(`http://localhost:${port}/health`);
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  expect(E2E_MONTONIO.url).toBe(`http://localhost:${E2E_MONTONIO.port}`);
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
  const config: MontonioConfig = { accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true, referencePrefix: "MSLAB-L" };
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
  const client = montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true, referencePrefix: "MSLAB-L" });
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
  const client = montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true, referencePrefix: "MSLAB-L" });
  const request = { reference: "MSLAB-M13", amountCents: 5000, locale: "et" as const, returnUrl: "https://mslab.example/r", notificationUrl: `${hook}/n` };
  const first = await client.createOrder(request);
  const second = await client.createOrder(request);
  expect(second.uuid).not.toBe(first.uuid);
  expect((await fetch(first.paymentUrl)).status).toBe(404);
  expect((await fetch(second.paymentUrl)).status).toBe(200);
  expect(await client.fetchOrder(first.uuid)).toBeNull();
  expect(await client.fetchOrder(second.uuid)).toMatchObject({ reference: "MSLAB-M13", status: "pending", amountCents: 5000 });
});

test("it refuses what Montonio refuses (another store's key) and what spec 4 forbids (preferredProvider, paymentReference, a method the store does not use)", async () => {
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
  expect((await post({ ...good, payment: { ...good.payment, method: "bnpl" } })).status).toBe(400);
  expect((await post({ ...good, grandTotal: 10.001, payment: { ...good.payment, amount: 10.001 } })).status).toBe(400);
  // järelmaks (Inbank) is a method the store uses: hirePurchase is accepted, with no methodOptions (Montonio's guide has none for it)
  expect((await post({ ...good, merchantReference: "MSLAB-M16", payment: { method: "hirePurchase", amount: 10, currency: "EUR" } })).status).toBe(200);
  // ... and the rules that hold for every method hold for it too
  expect((await post({ ...good, merchantReference: "MSLAB-M17", payment: { method: "hirePurchase", amount: 9, currency: "EUR" } })).status).toBe(400);
  expect((await post({ ...good, merchantReference: "MSLAB-M18", payment: { method: "hirePurchase", amount: 10, currency: "EUR", methodOptions: { preferredProvider: "HABAEE2X" } } })).status).toBe(400);
  expect((await post({ ...good, merchantReference: "MSLAB-M19", paymentReference: "123", payment: { method: "hirePurchase", amount: 10, currency: "EUR" } })).status).toBe(400);
  // the description is the bank order's; the bank order still needs it
  expect((await post({ ...good, merchantReference: "MSLAB-M20", payment: { ...good.payment, methodOptions: {} } })).status).toBe(400);
});

/** A signed order request for the fake, as the app's client would send it (`hirePurchase` unless said otherwise), for the tests below. */
const loanClaims = (extra: Record<string, unknown> = {}, reference = "MSLAB-M40") => ({
  accessKey: E2E_MONTONIO.accessKey, merchantReference: reference, returnUrl: "https://mslab.example/r", notificationUrl: "https://mslab.example/n", currency: "EUR", grandTotal: 250, locale: "et",
  payment: { method: "hirePurchase", amount: 250, currency: "EUR" },
  ...extra,
});
const postOrder = (base: string, claims: Record<string, unknown>) =>
  fetch(`${base}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: signHs256(claims, E2E_MONTONIO.secretKey, { expiresInSeconds: 600 }) }) });
const fakeClient = (base: string) => montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true, referencePrefix: "MSLAB-L" });
/** The value of the pay page's button with this label (the page is what the student sees; the label decides what the press does), or null. */
const buttonValue = (page: string, label: string) => new RegExp(`<button name="status" value="(\\w+)"[^>]*>${label}</button>`).exec(page)?.[1] ?? null;

test("a hirePurchase order: the fake reports the method, keeps its billingAddress and expiresIn for the tests, and its pay page is Inbank's, not the bank's", async () => {
  const base = await listen(createFakeMontonio());
  const { url: hook } = await webhookSink();
  const client = fakeClient(base);
  const billing = billingAddressOf({ name: "Mari Tamm", email: "mari@example.test", phone: "+372 5551 2345" });
  const loan = await client.createOrder({ reference: "MSLAB-M41", amountCents: 25000, locale: "et", returnUrl: "https://mslab.example/api/payments/return", notificationUrl: `${hook}/api/payments/notify`, method: "hirePurchase", billing });
  const bank = await client.createOrder({ reference: "MSLAB-M42", amountCents: 25000, locale: "et", returnUrl: "https://mslab.example/api/payments/return", notificationUrl: `${hook}/api/payments/notify` });

  expect(await client.fetchOrder(loan.uuid)).toEqual({ uuid: loan.uuid, reference: "MSLAB-M41", status: "pending", rawStatus: "PENDING", amountCents: 25000, currency: "EUR", method: "hirePurchase" });
  expect((await client.fetchOrder(bank.uuid))?.method).toBe("paymentInitiation");
  const seen = (await (await fetch(`${base}/_fake/orders/MSLAB-M41`)).json()) as Record<string, unknown>;
  expect(seen).toMatchObject({ reference: "MSLAB-M41", method: "hirePurchase", expiresIn: 60, billingAddress: { firstName: "Mari", lastName: "Tamm", email: "mari@example.test", phoneNumber: "55512345", phoneCountry: "372" } });
  const seenBank = (await (await fetch(`${base}/_fake/orders/MSLAB-M42`)).json()) as Record<string, unknown>;
  expect(seenBank).toMatchObject({ method: "paymentInitiation" });
  expect(seenBank).not.toHaveProperty("billingAddress");
  expect(seenBank).not.toHaveProperty("expiresIn");

  const loanPage = await (await fetch(loan.paymentUrl)).text();
  expect(loanPage).toContain("Inbank (test)");
  expect(loanPage).toContain("MSLAB-M41 · 250.00 EUR");
  expect([buttonValue(loanPage, "Kinnita laen"), buttonValue(loanPage, "Inbank keeldus")]).toEqual(["PAID", "PENDING"]);
  for (const bankLabel of ["Makstud", "Pooleli", "Katkesta"]) expect(buttonValue(loanPage, bankLabel), bankLabel).toBeNull();
  const bankPage = await (await fetch(bank.paymentUrl)).text();
  expect(bankPage).not.toContain("Inbank");
  expect([buttonValue(bankPage, "Makstud"), buttonValue(bankPage, "Pooleli"), buttonValue(bankPage, "Katkesta")]).toEqual(["PAID", "PENDING", "ABANDONED"]);
});

test("'Kinnita laen' signs the loan: PAID, the webhook and the return carry the same token, whose method is hirePurchase", async () => {
  const base = await listen(createFakeMontonio());
  const { hooks, url: hook } = await webhookSink();
  const client = fakeClient(base);
  const order = await client.createOrder({ reference: "MSLAB-M43", amountCents: 25000, locale: "et", returnUrl: "https://mslab.example/api/payments/return", notificationUrl: `${hook}/api/payments/notify`, method: "hirePurchase" });
  const page = await (await fetch(order.paymentUrl)).text();
  const pressed = await fetch(order.paymentUrl, { method: "POST", body: new URLSearchParams({ status: buttonValue(page, "Kinnita laen")! }), redirect: "manual" });
  expect(pressed.status).toBe(303);
  const fromReturn = client.verifyOrderToken(new URL(pressed.headers.get("location")!).searchParams.get("order-token")!);
  expect(fromReturn).toMatchObject({ uuid: order.uuid, reference: "MSLAB-M43", status: "paid", rawStatus: "PAID", amountCents: 25000, method: "hirePurchase", expired: false });
  expect(hooks).toHaveLength(1);
  expect(client.verifyOrderToken((JSON.parse(hooks[0]) as { orderToken: string }).orderToken)).toEqual(fromReturn);
  expect(await client.fetchOrder(order.uuid)).toMatchObject({ status: "paid", method: "hirePurchase" });
  // the token the test hook mints says the same
  const minted = (await (await fetch(`${base}/_fake/token/${order.uuid}?status=PAID`)).json()) as { orderToken: string };
  expect(client.verifyOrderToken(minted.orderToken)).toMatchObject({ method: "hirePurchase", status: "paid" });
});

test("'Inbank keeldus' leaves the order PENDING and sends no webhook, as Montonio does: the browser comes back with a PENDING token, and the loan can still be signed later", async () => {
  const base = await listen(createFakeMontonio());
  const { hooks, url: hook } = await webhookSink();
  const client = fakeClient(base);
  const order = await client.createOrder({ reference: "MSLAB-M44", amountCents: 25000, locale: "et", returnUrl: "https://mslab.example/api/payments/return", notificationUrl: `${hook}/api/payments/notify`, method: "hirePurchase" });
  const page = await (await fetch(order.paymentUrl)).text();
  const declined = await fetch(order.paymentUrl, { method: "POST", body: new URLSearchParams({ status: buttonValue(page, "Inbank keeldus")! }), redirect: "manual" });
  expect(declined.status).toBe(303);
  const back = new URL(declined.headers.get("location")!);
  expect(`${back.origin}${back.pathname}`).toBe("https://mslab.example/api/payments/return");
  expect(client.verifyOrderToken(back.searchParams.get("order-token")!)).toMatchObject({ uuid: order.uuid, status: "pending", rawStatus: "PENDING", method: "hirePurchase", amountCents: 25000 });
  expect(hooks).toHaveLength(0);
  expect(await client.fetchOrder(order.uuid)).toMatchObject({ status: "pending", rawStatus: "PENDING", method: "hirePurchase" });
  // Montonio keeps it PENDING for days: Inbank approving the old application later is a webhook of its own (the test hook)
  expect((await fetch(`${base}/_fake/settle/${order.uuid}`, { method: "POST", body: JSON.stringify({ status: "PAID" }) })).status).toBe(200);
  expect(hooks).toHaveLength(1);
  expect(client.verifyOrderToken((JSON.parse(hooks[0]) as { orderToken: string }).orderToken)).toMatchObject({ status: "paid", method: "hirePurchase" });
});

test("expiresIn is minutes, 5 to 44640 (Montonio's orders guide); billingAddress needs a first name, a last name and an e-mail, and a phone country only with a phone number", async () => {
  const base = await listen(createFakeMontonio());
  const billing = { firstName: "Mari", lastName: "Tamm", email: "mari@example.test" };
  const ok: Record<string, Record<string, unknown>> = {
    "no expiresIn, no billing": loanClaims(),
    "expiresIn 60": loanClaims({ expiresIn: 60 }),
    "expiresIn 5": loanClaims({ expiresIn: 5 }),
    "expiresIn 44640": loanClaims({ expiresIn: 44_640 }),
    "billing without a phone": loanClaims({ billingAddress: billing }),
    "billing with a phone and its country": loanClaims({ billingAddress: { ...billing, phoneNumber: "55512345", phoneCountry: "372" } }),
    "billing with a phone and no country": loanClaims({ billingAddress: { ...billing, phoneNumber: "55512345" } }),
    "a one-digit calling code": loanClaims({ billingAddress: { ...billing, phoneNumber: "2025550123", phoneCountry: "1" } }),
    "a four-digit calling code": loanClaims({ billingAddress: { ...billing, phoneNumber: "2025550123", phoneCountry: "1242" } }),
    "a bank order may carry them too": loanClaims({ expiresIn: 30, billingAddress: billing, payment: { method: "paymentInitiation", amount: 250, currency: "EUR", methodOptions: { paymentDescription: "MS LAB MSLAB-M40" } } }),
  };
  for (const [what, claims] of Object.entries(ok)) expect((await postOrder(base, claims)).status, what).toBe(200);
  const bad: Record<string, Record<string, unknown>> = {
    "expiresIn 4": loanClaims({ expiresIn: 4 }),
    "expiresIn 0": loanClaims({ expiresIn: 0 }),
    "expiresIn 44641": loanClaims({ expiresIn: 44_641 }),
    "expiresIn as text": loanClaims({ expiresIn: "60" }),
    "expiresIn null": loanClaims({ expiresIn: null }),
    "billing is not an object": loanClaims({ billingAddress: "Mari Tamm" }),
    "billing is null": loanClaims({ billingAddress: null }),
    "billing without a first name": loanClaims({ billingAddress: { lastName: "Tamm", email: "mari@example.test" } }),
    "billing without a last name": loanClaims({ billingAddress: { firstName: "Mari", email: "mari@example.test" } }),
    "billing without an e-mail": loanClaims({ billingAddress: { firstName: "Mari", lastName: "Tamm" } }),
    "an empty first name": loanClaims({ billingAddress: { ...billing, firstName: "" } }),
    "a phone country without a phone number": loanClaims({ billingAddress: { ...billing, phoneCountry: "372" } }),
    // Montonio's guide: phoneCountry "e.g 372", the calling code; an ISO country, a plus sign, spaces or more than four digits are no code
    "an ISO country as the phone country": loanClaims({ billingAddress: { ...billing, phoneNumber: "55512345", phoneCountry: "EE" } }),
    "a calling code with a plus": loanClaims({ billingAddress: { ...billing, phoneNumber: "55512345", phoneCountry: "+372" } }),
    "a calling code with a space": loanClaims({ billingAddress: { ...billing, phoneNumber: "55512345", phoneCountry: "37 2" } }),
    "a calling code of five digits": loanClaims({ billingAddress: { ...billing, phoneNumber: "55512345", phoneCountry: "37200" } }),
    "an empty calling code": loanClaims({ billingAddress: { ...billing, phoneNumber: "55512345", phoneCountry: "" } }),
    "a phone number that is a number": loanClaims({ billingAddress: { ...billing, phoneNumber: 55512345 } }),
  };
  for (const [what, claims] of Object.entries(bad)) expect((await postOrder(base, claims)).status, what).toBe(400);
});

test("a student whose name or phone doesn't fit Inbank: the fake still takes the order, and keeps only an Estonian phone", async () => {
  const base = await listen(createFakeMontonio());
  const client = fakeClient(base);
  const students = [
    { name: "Madonna", email: "madonna@example.test", phone: "5551 2345" },
    { name: "Anna Ivanova", email: "anna@example.test", phone: "+7 912 345 67 89" },
    { name: "Mari Liis Tamm", email: "mari@example.test", phone: "(+372) 555-12345" },
    { name: "", email: "nameless@example.test", phone: "" },
  ];
  for (const [i, s] of students.entries()) {
    const reference = `MSLAB-M5${i}`;
    await client.createOrder({ reference, amountCents: 25000, locale: "et", returnUrl: "https://mslab.example/r", notificationUrl: "https://mslab.example/n", method: "hirePurchase", billing: billingAddressOf(s) });
  }
  const stored = async (reference: string) => ((await (await fetch(`${base}/_fake/orders/${reference}`)).json()) as { billingAddress: unknown }).billingAddress;
  expect(await stored("MSLAB-M50")).toEqual({ firstName: "Madonna", lastName: "Madonna", email: "madonna@example.test", phoneNumber: "55512345", phoneCountry: "372" });
  expect(await stored("MSLAB-M51")).toEqual({ firstName: "Anna", lastName: "Ivanova", email: "anna@example.test" });
  expect(await stored("MSLAB-M52")).toEqual({ firstName: "Mari Liis", lastName: "Tamm", email: "mari@example.test", phoneNumber: "55512345", phoneCountry: "372" });
  expect(await stored("MSLAB-M53")).toEqual({ firstName: "nameless", lastName: "nameless", email: "nameless@example.test" });
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
  const client = montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true, referencePrefix: "MSLAB-L" });
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
  const client = montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true, referencePrefix: "MSLAB-L" });
  const elsewhere = ["https://shop.example/api/payments/notify", "http://localhost.evil.example/n", "http://127.0.0.1.evil.example/n", "http://localhost@evil.example/n", "not a url"];
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
    expect(offMachine.refused, "the fake tried to reach beyond this machine (the call was refused here, and went nowhere)").toEqual([]);
    const noted = logged.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("[fake-montonio]") && line.includes("not sent"));
    expect(noted).toHaveLength(elsewhere.length + 1);
    expect(noted.join("\n")).not.toContain("shop.example/api"); // the host is named, not the whole address
  } finally {
    logged.mockRestore();
  }
});

test("isLocalUrl: localhost, 127.0.0.1 and [::1] (any port, http or https) are this machine; a name that only starts or ends like it, credentials and junk are not", () => {
  for (const url of ["http://localhost:3000/api/payments/notify", "http://LOCALHOST/n", "http://127.0.0.1:3100/n", "http://[::1]:3000/n", "https://localhost/n"]) expect(isLocalUrl(url), url).toBe(true);
  for (const url of ["https://shop.example/n", "http://localhost.evil.example/n", "http://evil.example/localhost", "http://localhost@evil.example/n", "http://user:pw@localhost/n", "http://0.0.0.0/n", "ftp://localhost/n", "localhost:3000", "", "not a url"])
    expect(isLocalUrl(url), url).toBe(false);
});

test("the test hook mints the token Montonio would sign for an order without settling it: the app's client reads it, the order stays as it is", async () => {
  const base = await listen(createFakeMontonio());
  const client = montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true, referencePrefix: "MSLAB-L" });
  const order = await client.createOrder({ reference: "MSLAB-M31", amountCents: 17500, locale: "et", returnUrl: "https://mslab.example/r", notificationUrl: "http://127.0.0.1:1/n" });
  const minted = await fetch(`${base}/_fake/token/${order.uuid}?status=PAID`);
  expect(minted.status).toBe(200);
  const { orderToken } = (await minted.json()) as { orderToken: string };
  expect(client.verifyOrderToken(orderToken)).toMatchObject({ uuid: order.uuid, reference: "MSLAB-M31", status: "paid", amountCents: 17500, currency: "EUR", bank: "Testpank", method: "paymentInitiation", expired: false });
  expect((await client.fetchOrder(order.uuid))?.status).toBe("pending"); // nothing was settled
  expect((await fetch(`${base}/_fake/token/${order.uuid}`)).status).toBe(400); // a status is needed
  expect((await fetch(`${base}/_fake/token/no-such-order?status=PAID`)).status).toBe(404);
});

test("the refund hook refunds an order as Montonio does (GET /orders says REFUNDED, or PARTIALLY_REFUNDED for a part) and answers the refund token Montonio would send, sending nothing itself", async () => {
  const sink = await webhookSink();
  const base = await listen(createFakeMontonio());
  const client = montonioClient({ accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: base, live: false, mock: true, referencePrefix: "MSLAB-L" });
  const order = await client.createOrder({ reference: "MSLAB-M32", amountCents: 17500, locale: "et", returnUrl: "https://mslab.example/r", notificationUrl: sink.url });
  const part = await fetch(`${base}/_fake/refund/${order.uuid}`, { method: "POST", body: JSON.stringify({ amount: 50 }) });
  expect(part.status).toBe(200);
  const { refundToken: partial } = (await part.json()) as { refundToken: string };
  expect(client.verifyRefundToken(partial)).toMatchObject({ orderUuid: order.uuid, rawStatus: "SUCCESSFUL", accessKey: E2E_MONTONIO.accessKey, expired: false });
  expect(await client.fetchOrder(order.uuid)).toMatchObject({ status: "refunded", rawStatus: "PARTIALLY_REFUNDED" });
  const full = await fetch(`${base}/_fake/refund/${order.uuid}`, { method: "POST", body: "{}" });
  expect(client.verifyRefundToken(((await full.json()) as { refundToken: string }).refundToken)).toMatchObject({ orderUuid: order.uuid });
  expect(await client.fetchOrder(order.uuid)).toMatchObject({ status: "refunded", rawStatus: "REFUNDED" });
  expect(sink.hooks).toEqual([]); // the test posts the token itself
  expect((await fetch(`${base}/_fake/refund/no-such-order`, { method: "POST", body: "{}" })).status).toBe(404);
});
