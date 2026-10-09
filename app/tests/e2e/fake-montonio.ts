import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { signHs256, verifyHs256 } from "../../src/server/payments/jwt";
import { E2E_MONTONIO } from "./montonio-values";

// A stand-in for Montonio's Stargate API in the e2e run (phase 2b): the app's server gets PAYMENT_PROVIDER=mock and MONTONIO_FAKE_URL = this
// address (tests/local-secrets.ts, server/payments/montonio.ts), and the app's own client talks to it as it would to Montonio. It checks what
// Montonio checks, and spec 4's rules the app must keep:
// - POST /orders { data: <jwt> }: the HS256 signature with the store's secret and its accessKey (else 401 STORE_NOT_FOUND, as Montonio);
//   merchantReference, returnUrl, notificationUrl, currency EUR, grandTotal > 0 with at most two decimals, locale et/ru, and payment
//   { method "paymentInitiation", amount = grandTotal, currency EUR, methodOptions.paymentDescription } with no preferredProvider and no
//   paymentReference (else 400). A reference reused for an unpaid order replaces it; for a paid one it is a 400, as at Montonio. Answers
//   { uuid, paymentStatus: "PENDING", merchantReference, paymentUrl } (the paymentUrl on this server's own address).
// - GET /orders/<uuid> with "Authorization: Bearer <jwt>" ({ accessKey }): the order as Montonio's reference prints it, grandTotal a string.
// - The bank: GET /pay/<uuid> is a page with three buttons, "Makstud" (PAID), "Pooleli" (PENDING) and "Katkesta" (ABANDONED). The form posts
//   back here: a status other than PENDING is sent to the app's notificationUrl as Montonio's webhook ({ orderToken }, signed for 10 minutes)
//   and awaited, then the browser gets a 303 to returnUrl?order-token=<the same token>.
// - For the tests: GET /_fake/orders/<reference> (the order, or 404); POST /_fake/settle/<uuid> { status } (the bank decides later: the
//   status and the webhook, without the browser); GET /health.
// Run: npx tsx tests/e2e/fake-montonio.ts (Playwright starts it: tests/e2e/server.ts), on E2E_MONTONIO.port. The keys are E2E_MONTONIO's.

type Order = { uuid: string; reference: string; grandTotal: number; currency: string; locale: string; returnUrl: string; notificationUrl: string; status: string };
type Keys = { accessKey: string; secretKey: string };

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const html = typeof body === "string";
  res.writeHead(status, { "cache-control": "no-store", "content-type": html ? "text/html; charset=utf-8" : "application/json", ...headers });
  res.end(html ? body : JSON.stringify(body));
}

const read = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The bank's page: the order and its three outcomes (44 px buttons, so the e2e run's phone project can press them). */
const bankPage = (o: Order) =>
  [
    '<!doctype html><html lang="et"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Testpank</title></head>',
    '<body style="margin:24px;font:16px/1.5 system-ui,sans-serif">',
    `<h1>Testpank</h1><p data-fake-order="${esc(o.reference)}">${esc(o.reference)} · ${o.grandTotal.toFixed(2)} ${esc(o.currency)}</p>`,
    `<form method="post" action="/pay/${o.uuid}">`,
    ...[["PAID", "Makstud"], ["PENDING", "Pooleli"], ["ABANDONED", "Katkesta"]].map(([value, label]) => `<button name="status" value="${value}" style="min-height:44px;margin:4px">${label}</button>`),
    "</form></body></html>",
  ].join("");

/** The order token Montonio signs: the decoded payload of its orders guide, with this order's values. */
const orderToken = (o: Order, keys: Keys) =>
  signHs256(
    {
      uuid: o.uuid,
      accessKey: keys.accessKey,
      merchantReference: o.reference,
      merchantReferenceDisplay: o.reference,
      paymentStatus: o.status,
      paymentMethod: "paymentInitiation",
      grandTotal: o.grandTotal,
      currency: o.currency,
      senderIban: null,
      senderName: null,
      paymentProviderName: "Testpank",
    },
    keys.secretKey,
    { expiresInSeconds: 600 },
  );

/** Montonio's webhook: POST { orderToken } to the order's notificationUrl, awaited; a failure is only noted (Montonio would retry). */
async function notify(o: Order, keys: Keys): Promise<void> {
  try {
    await fetch(o.notificationUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderToken: orderToken(o, keys) }), redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch {
    console.error("[fake-montonio] the webhook did not reach the app");
  }
}

/** What is wrong with an order request (Montonio's own checks and spec 4's rules); null when nothing is. */
function orderProblem(c: Record<string, unknown>): string | null {
  const payment = (c.payment ?? {}) as Record<string, unknown>;
  const options = (payment.methodOptions ?? {}) as Record<string, unknown>;
  const euros = (n: unknown) => typeof n === "number" && n > 0 && Math.round(n * 100) / 100 === n;
  if (typeof c.merchantReference !== "string" || !c.merchantReference) return "merchantReference";
  if (typeof c.returnUrl !== "string" || typeof c.notificationUrl !== "string") return "returnUrl/notificationUrl";
  if (c.currency !== "EUR" || payment.currency !== "EUR") return "currency";
  if (!euros(c.grandTotal) || payment.amount !== c.grandTotal) return "grandTotal/amount";
  if (c.locale !== "et" && c.locale !== "ru") return "locale";
  if (payment.method !== "paymentInitiation") return "payment.method";
  if (typeof options.paymentDescription !== "string" || !options.paymentDescription) return "paymentDescription";
  if ("preferredProvider" in options || "paymentReference" in options || "paymentReference" in c) return "preferredProvider/paymentReference";
  return null;
}

/** The fake on `keys` (E2E_MONTONIO's by default): a server to listen on any port. */
export function createFakeMontonio(keys: Keys = { accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey }): Server {
  const orders = new Map<string, Order>();
  const byReference = (reference: string) => [...orders.values()].find((o) => o.reference === reference);
  const trusted = (token: string): Record<string, unknown> | null => {
    try {
      const { claims, expired } = verifyHs256(token, keys.secretKey);
      return !expired && claims.accessKey === keys.accessKey ? claims : null;
    } catch {
      return null;
    }
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    if (path === "/health") return send(res, 200, { ok: true });

    if (path === "/orders" && req.method === "POST") {
      let data = "";
      try {
        data = String((JSON.parse(await read(req)) as { data?: unknown }).data ?? "");
      } catch {
        // not JSON: no token
      }
      const c = trusted(data);
      if (!c) return send(res, 401, { message: "STORE_NOT_FOUND - double check your access key" });
      const problem = orderProblem(c);
      if (problem) return send(res, 400, { message: `Invalid order: ${problem}` });
      const reference = c.merchantReference as string;
      const old = byReference(reference);
      if (old?.status === "PAID") return send(res, 400, { message: `The order ${reference} is already paid` });
      if (old) orders.delete(old.uuid);
      const o: Order = { uuid: randomUUID(), reference, grandTotal: c.grandTotal as number, currency: "EUR", locale: c.locale as string, returnUrl: c.returnUrl as string, notificationUrl: c.notificationUrl as string, status: "PENDING" };
      orders.set(o.uuid, o);
      return send(res, 200, { uuid: o.uuid, paymentStatus: "PENDING", merchantReference: reference, paymentUrl: `http://${req.headers.host}/pay/${o.uuid}` });
    }

    const get = /^\/orders\/([^/]+)$/.exec(path);
    if (get && req.method === "GET") {
      if (!trusted(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "")) return send(res, 401, { message: "INVALID_TOKEN - double check your secret key" });
      const o = orders.get(get[1]);
      if (!o) return send(res, 404, { message: "Order not found" });
      return send(res, 200, { uuid: o.uuid, paymentStatus: o.status, locale: o.locale, merchantReference: o.reference, merchantReferenceDisplay: o.reference, grandTotal: o.grandTotal.toFixed(2), currency: o.currency, paymentMethodType: "paymentInitiation" });
    }

    const pay = /^\/pay\/([^/]+)$/.exec(path);
    const order = pay ? orders.get(pay[1]) : undefined;
    if (pay && !order) return send(res, 404, "<!doctype html><title>Testpank</title><p>Tellimust ei leitud.</p>");
    if (order && req.method === "GET") return send(res, 200, bankPage(order));
    if (order && req.method === "POST") {
      const status = new URLSearchParams(await read(req)).get("status");
      if (status !== "PAID" && status !== "PENDING" && status !== "ABANDONED") return send(res, 400, "status");
      order.status = status;
      if (status !== "PENDING") await notify(order, keys);
      const back = new URL(order.returnUrl);
      back.searchParams.set("order-token", orderToken(order, keys));
      return send(res, 303, "", { location: back.toString() });
    }

    const find = /^\/_fake\/orders\/([^/]+)$/.exec(path);
    if (find && req.method === "GET") {
      const o = byReference(decodeURIComponent(find[1]));
      return o ? send(res, 200, o) : send(res, 404, { message: "no order" });
    }
    const later = /^\/_fake\/settle\/([^/]+)$/.exec(path);
    if (later && req.method === "POST") {
      const o = orders.get(later[1]);
      let status: unknown;
      try {
        status = (JSON.parse(await read(req)) as { status?: unknown }).status;
      } catch {
        status = undefined;
      }
      if (!o || typeof status !== "string") return send(res, 404, { message: "no order" });
      o.status = status;
      await notify(o, keys);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { message: "not found" });
  }

  return createServer((req, res) => void handle(req, res).catch(() => send(res, 500, { message: "fake error" })));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tests/e2e/fake-montonio.ts")) createFakeMontonio().listen(E2E_MONTONIO.port);
