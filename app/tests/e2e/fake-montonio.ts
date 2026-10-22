import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { signHs256, verifyHs256 } from "../../src/server/payments/jwt";
import { E2E_MONTONIO } from "./montonio-values";

// A stand-in for Montonio's Stargate API in the e2e run (phase 2b): the app's server gets PAYMENT_PROVIDER=mock and MONTONIO_FAKE_URL = this
// address (tests/local-secrets.ts, server/payments/montonio.ts), and the app's own client talks to it as it would to Montonio. It checks what
// Montonio checks, and spec 4's rules the app must keep:
// - POST /orders { data: <jwt> }: the HS256 signature with the store's secret and its accessKey (else 401 STORE_NOT_FOUND, as Montonio);
//   merchantReference, returnUrl, notificationUrl, currency EUR, grandTotal > 0 with at most two decimals, locale et/ru, and payment
//   { method "paymentInitiation" or "hirePurchase" (the järelmaks, Inbank; nothing else), amount = grandTotal, currency EUR } with no
//   preferredProvider and no paymentReference (else 400); a bank order also needs methodOptions.paymentDescription, a hirePurchase order has
//   no methodOptions of Montonio's. The top-level `expiresIn`, when present, is minutes, a number from 5 to 44640; `billingAddress`, when
//   present, is an object with a string firstName, lastName and e-mail (docs.montonio.com/api/stargate/guides/orders, checked 22.10.2026),
//   and a phoneCountry only beside a phoneNumber. The decoded method, billingAddress and expiresIn are kept on the order for the tests
//   (GET /_fake/orders/<reference>). A reference reused for an unpaid order replaces it; for a paid one it is a 400, as at Montonio. Answers
//   { uuid, paymentStatus: "PENDING", merchantReference, paymentUrl } (the paymentUrl on this server's own address).
// - GET /orders/<uuid> with "Authorization: Bearer <jwt>" ({ accessKey }): the order as Montonio's reference prints it, grandTotal a string,
//   paymentMethodType the order's method.
// - The bank: GET /pay/<uuid> is a page with three buttons, "Makstud" (PAID), "Pooleli" (PENDING) and "Katkesta" (ABANDONED). The form posts
//   back here: a status other than PENDING is sent to the app's notificationUrl as Montonio's webhook ({ orderToken }, signed for 10 minutes)
//   and awaited, then the browser gets a 303 to returnUrl?order-token=<the same token>.
// - Inbank (a hirePurchase order): the same URL is „Inbank (test)“ with two buttons, „Kinnita laen“ (the loan is signed: PAID, the webhook,
//   the return) and „Inbank keeldus“ (declined or abandoned: the order STAYS PENDING, NO webhook, and the browser still goes back to the
//   returnUrl with a PENDING token, as Montonio keeps such an order PENDING for 7 days, Montonio 22.10.2026). The token's paymentMethod is
//   the order's method, and its provider name Inbank.
// - The webhook goes only to this machine: a notificationUrl whose host is not localhost, 127.0.0.1 or [::1] is logged and skipped (the app's
//   siteUrl is the public site's when a run is started by hand; a test must never post to it).
// - For the tests: GET /_fake/orders/<reference> (the order, or 404); POST /_fake/settle/<uuid> { status } (the bank decides later: the
//   status and the webhook, without the browser); GET /_fake/token/<uuid>?status=PAID (the token Montonio would sign for the order with
//   that status, nothing settled and no webhook: for a test that sends a webhook itself, twice at once); POST /_fake/refund/<uuid>
//   { amount? } (Maria refunds in the Partner System: the order becomes REFUNDED, or PARTIALLY_REFUNDED for less than its total, and the
//   answer is { refundToken }, the refund notice Montonio would send, which is NOT sent: the test posts it); GET /health.
// Run: npx tsx tests/e2e/fake-montonio.ts (Playwright starts it: tests/e2e/server.ts), on E2E_MONTONIO.port of 127.0.0.1 only. The keys are
// E2E_MONTONIO's.

type Order = {
  uuid: string;
  reference: string;
  grandTotal: number;
  currency: string;
  locale: string;
  returnUrl: string;
  notificationUrl: string;
  status: string;
  /** payment.method as decoded from the request: "paymentInitiation" or "hirePurchase". */
  method: string;
  /** The top-level expiresIn (minutes) and billingAddress as decoded, kept for the tests; absent when the request had none. */
  expiresIn?: number;
  billingAddress?: Record<string, unknown>;
};
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

/** Is this Inbank's järelmaks (a hirePurchase order), not a bank link? */
const isLoan = (o: Order) => o.method === "hirePurchase";

/**
 * The bank's page: the order and its outcomes (44 px buttons, so the e2e run's phone project can press them). A bank link has three.
 * Inbank's järelmaks has two: the loan signed, or Inbank's no, which (as at Montonio) leaves the order PENDING.
 */
const bankPage = (o: Order) => {
  const name = isLoan(o) ? "Inbank (test)" : "Testpank";
  const outcomes = isLoan(o) ? [["PAID", "Kinnita laen"], ["PENDING", "Inbank keeldus"]] : [["PAID", "Makstud"], ["PENDING", "Pooleli"], ["ABANDONED", "Katkesta"]];
  return [
    `<!doctype html><html lang="et"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title></head>`,
    '<body style="margin:24px;font:16px/1.5 system-ui,sans-serif">',
    `<h1>${name}</h1><p data-fake-order="${esc(o.reference)}">${esc(o.reference)} · ${o.grandTotal.toFixed(2)} ${esc(o.currency)}</p>`,
    `<form method="post" action="/pay/${o.uuid}">`,
    ...outcomes.map(([value, label]) => `<button name="status" value="${value}" style="min-height:44px;margin:4px">${label}</button>`),
    "</form></body></html>",
  ].join("");
};

/** The order token Montonio signs: the decoded payload of its orders guide, with this order's values. */
const orderToken = (o: Order, keys: Keys) =>
  signHs256(
    {
      uuid: o.uuid,
      accessKey: keys.accessKey,
      merchantReference: o.reference,
      merchantReferenceDisplay: o.reference,
      paymentStatus: o.status,
      paymentMethod: o.method,
      grandTotal: o.grandTotal,
      currency: o.currency,
      senderIban: null,
      senderName: null,
      paymentProviderName: isLoan(o) ? "Inbank" : "Testpank",
    },
    keys.secretKey,
    { expiresInSeconds: 600 },
  );

/**
 * The refund notice's token Montonio signs (its refunds guide's decoded payload: refundUuid, refundStatus, refundStatusDescription, accessKey,
 * refundAmount, orderUuid; valid for 7 days), for a refund of `amount` euros of the order that went through.
 */
const refundToken = (o: Order, keys: Keys, amount: number) =>
  signHs256(
    { refundUuid: randomUUID(), refundStatus: "SUCCESSFUL", refundStatusDescription: null, accessKey: keys.accessKey, refundAmount: amount, orderUuid: o.uuid },
    keys.secretKey,
    { expiresInSeconds: 7 * 86_400 },
  );

/** The names of this machine: the only places the fake posts a webhook to. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Is `value` an http(s) address on this machine (localhost, 127.0.0.1 or [::1]) with no user name or password in it? Junk is not. */
export function isLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTS.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The host of an address for the log (never the whole address: a path can carry a secret); "?" for junk. */
const hostOf = (value: string): string => {
  try {
    return new URL(value).hostname || "?";
  } catch {
    return "?";
  }
};

/**
 * Montonio's webhook: POST { orderToken } to the order's notificationUrl, awaited; a failure is only noted (Montonio would retry). Only to
 * this machine: any other host (the public site's, when the app was started with its SITE_URL) is logged and skipped, never posted to.
 */
async function notify(o: Order, keys: Keys): Promise<void> {
  if (!isLocalUrl(o.notificationUrl)) {
    console.error(`[fake-montonio] the webhook of ${o.reference} was not sent: its notificationUrl is not on this machine (host ${hostOf(o.notificationUrl)})`);
    return;
  }
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
  if (payment.method !== "paymentInitiation" && payment.method !== "hirePurchase") return "payment.method";
  // the description is the bank link's option; Montonio's guide has no methodOptions for hirePurchase
  if (payment.method === "paymentInitiation" && (typeof options.paymentDescription !== "string" || !options.paymentDescription)) return "paymentDescription";
  if ("preferredProvider" in options || "paymentReference" in options || "paymentReference" in c) return "preferredProvider/paymentReference";
  // expiresIn: the minutes the order can be paid, 5 to 44640 (Montonio's guide); billingAddress: what Inbank's form is filled in from
  if (c.expiresIn !== undefined && !(typeof c.expiresIn === "number" && c.expiresIn >= 5 && c.expiresIn <= 44_640)) return "expiresIn";
  if (c.billingAddress !== undefined) return billingProblem(c.billingAddress);
  return null;
}

/** The keys of Montonio's billingAddress (its orders guide): every one a string when present. */
const BILLING_KEYS = ["firstName", "lastName", "email", "phoneNumber", "phoneCountry", "addressLine1", "addressLine2", "locality", "region", "postalCode", "country"];

/** What is wrong with a billingAddress: not an object, a first name, last name or e-mail missing, a key that is no string, or a phone country without a phone number. */
function billingProblem(b: unknown): string | null {
  if (typeof b !== "object" || b === null || Array.isArray(b)) return "billingAddress";
  const a = b as Record<string, unknown>;
  for (const key of ["firstName", "lastName", "email"]) if (typeof a[key] !== "string" || !(a[key] as string).trim()) return `billingAddress.${key}`;
  for (const key of BILLING_KEYS) if (a[key] !== undefined && typeof a[key] !== "string") return `billingAddress.${key}`;
  if (a.phoneCountry !== undefined && !a.phoneNumber) return "billingAddress.phoneCountry";
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
      const o: Order = {
        uuid: randomUUID(),
        reference,
        grandTotal: c.grandTotal as number,
        currency: "EUR",
        locale: c.locale as string,
        returnUrl: c.returnUrl as string,
        notificationUrl: c.notificationUrl as string,
        status: "PENDING",
        method: (c.payment as Record<string, unknown>).method as string,
        ...(c.expiresIn !== undefined ? { expiresIn: c.expiresIn as number } : {}),
        ...(c.billingAddress !== undefined ? { billingAddress: c.billingAddress as Record<string, unknown> } : {}),
      };
      orders.set(o.uuid, o);
      return send(res, 200, { uuid: o.uuid, paymentStatus: "PENDING", merchantReference: reference, paymentUrl: `http://${req.headers.host}/pay/${o.uuid}` });
    }

    const get = /^\/orders\/([^/]+)$/.exec(path);
    if (get && req.method === "GET") {
      if (!trusted(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "")) return send(res, 401, { message: "INVALID_TOKEN - double check your secret key" });
      const o = orders.get(get[1]);
      if (!o) return send(res, 404, { message: "Order not found" });
      return send(res, 200, { uuid: o.uuid, paymentStatus: o.status, locale: o.locale, merchantReference: o.reference, merchantReferenceDisplay: o.reference, grandTotal: o.grandTotal.toFixed(2), currency: o.currency, paymentMethodType: o.method });
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
    const mint = /^\/_fake\/token\/([^/]+)$/.exec(path);
    if (mint && req.method === "GET") {
      const o = orders.get(mint[1]);
      const status = url.searchParams.get("status");
      if (!o) return send(res, 404, { message: "no order" });
      if (!status) return send(res, 400, { message: "status needed" });
      return send(res, 200, { orderToken: orderToken({ ...o, status }, keys) });
    }
    const refund = /^\/_fake\/refund\/([^/]+)$/.exec(path);
    if (refund && req.method === "POST") {
      const o = orders.get(refund[1]);
      if (!o) return send(res, 404, { message: "no order" });
      let amount: unknown;
      try {
        amount = (JSON.parse((await read(req)) || "{}") as { amount?: unknown }).amount;
      } catch {
        amount = undefined;
      }
      const part = typeof amount === "number" && amount > 0 && amount < o.grandTotal;
      o.status = part ? "PARTIALLY_REFUNDED" : "REFUNDED";
      return send(res, 200, { refundToken: refundToken(o, keys, part ? (amount as number) : o.grandTotal) });
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

/**
 * The fake on `port`, listening on 127.0.0.1 only: never on the network, whatever this machine's firewall says. Its address stays
 * E2E_MONTONIO.url, http://localhost:<port>: the app's fetch and the browser try 127.0.0.1 among localhost's addresses.
 */
export function startFakeMontonio(port: number): Promise<Server> {
  const server = createFakeMontonio();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tests/e2e/fake-montonio.ts")) void startFakeMontonio(E2E_MONTONIO.port);
