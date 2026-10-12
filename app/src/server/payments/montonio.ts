import { isReferencePrefix, LOCAL_REFERENCE_PREFIX, ORDER_REFERENCE_PREFIX, PREVIEW_REFERENCE_PREFIX } from "@/domain/payments";
import { paymentsEnv, type PaymentsEnv } from "../env";
import { logFailure, logNote } from "../log";
import { JwtError, signHs256, verifyHs256 } from "./jwt";

// Montonio's Stargate API (phase 2b, spec 4 and 7.1–7.3; docs.montonio.com checked 09.10.2026), ported from Rempire's integration:
// - every request is a JWT, HS256 with the store's secret key, with `accessKey`, `iat` and `exp` (10 minutes for a POST, an hour for a GET);
//   a POST body is { "data": "<jwt>" }, a GET carries "Authorization: Bearer <jwt>";
// - POST /orders creates an order: merchantReference (ours, MSLAB-M<id> in production, a new one for every attempt; the prefix is the
//   environment's, montonioConfig), returnUrl, notificationUrl, grandTotal and payment.amount in euros (a number with at most two decimals;
//   cents everywhere else in this app), currency EUR, locale et/ru, and payment.method "paymentInitiation" with NO preferredProvider, so
//   Montonio's own page lists every bank and every method the store has on (D4), and methodOptions.paymentDescription "MS LAB <reference>".
//   We never send paymentReference: banks check it strictly and a bad one fails the payment. The window is Montonio's default 30 minutes (domain/sessions.ts SEAT_HOLD_MS holds the seat as long);
// - the webhook (POST notificationUrl { orderToken }) and the return (returnUrl?order-token=…) carry the same signed order token, in any
//   order; GET /orders/:uuid answers what Montonio itself believes (its grandTotal is a string there);
// - a refund's status change is a webhook of its own to the same notificationUrl, { refundToken }: a JWT signed the same way, whose claims
//   are refundUuid, refundStatus, refundStatusDescription, accessKey, refundAmount, orderUuid (valid 7 days; docs.montonio.com, Stargate
//   refunds guide and webhooks guide, checked 10.10.2026). The order's own paymentStatus then reads REFUNDED or PARTIALLY_REFUNDED.
// Without both keys there are no online payments (paymentsConfigured). PAYMENT_PROVIDER=mock points this same client at the e2e run's fake
// Montonio (tests/e2e/fake-montonio.ts) and is refused on Vercel and, without PAYMENT_MOCK_IN_PRODUCTION=1, in a production build: the mock
// is never a fallback. The fake's address must be plain http on this machine (localhost, 127.0.0.1, [::1]), in every runtime that allows
// the mock at all. Logs carry no key, no token and no address; Montonio's own error text is kept (it names no person), with any token in
// it replaced.

export const LIVE_BASE = "https://stargate.montonio.com/api";
export const SANDBOX_BASE = "https://sandbox-stargate.montonio.com/api";
/** Montonio has 15 s to answer, headers and body together. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** The lifetime of a POST's token (10 minutes) and of a GET's Bearer token (an hour), as Montonio's reference asks. */
const POST_TOKEN_SEC = 600;
const GET_TOKEN_SEC = 3600;
/** How far past its `exp` an order token is still taken as it is (spec 7.1); an older one is confirmed with GET /orders/:uuid (spec 7.4). */
const CLOCK_TOLERANCE_SEC = 60;

export type MontonioStatus = "paid" | "pending" | "failed" | "refunded";

/**
 * Montonio's paymentStatus in our words (spec 7.3): PAID is paid; PENDING, AUTHORIZED and any status this code has not been taught change
 * nothing; ABANDONED (unpaid after the window), VOIDED (a bank reversal), CANCELLED and FAILED are failed; REFUNDED and PARTIALLY_REFUNDED
 * are refunded. settle.ts keeps paid as a floor.
 */
export function mapMontonioStatus(raw: unknown): MontonioStatus {
  // only a string is a status: String(["PAID"]) or an object's toString() must not read as one
  switch ((typeof raw === "string" ? raw : "").trim().toUpperCase()) {
    case "PAID":
      return "paid";
    case "ABANDONED":
    case "VOIDED":
    case "CANCELLED":
    case "FAILED":
      return "failed";
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return "refunded";
    default:
      return "pending";
  }
}

/**
 * Euros as Montonio writes them — a number (99.99) or, in GET /orders, a string ("100.00") — in cents; null when it is no amount. Exact: a
 * number with a third decimal (175.504) is no amount either, never rounded into one that would pass the check (spec 7.4: exact in cents).
 */
export function toCents(euros: unknown): number | null {
  const n = typeof euros === "number" ? euros : typeof euros === "string" && /^\d+(\.\d{1,2})?$/.test(euros.trim()) ? Number(euros) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const cents = Math.round(n * 100);
  // past the safe integers a count of cents is no longer exact, and could not be compared with what was asked
  if (!Number.isSafeInteger(cents)) return null;
  // 99.99 * 100 is 9998.999…: a float's own error is far below a millionth of a cent; a third decimal is not
  return Math.abs(n * 100 - cents) < 1e-6 ? cents : null;
}

/** Cents as the euros Montonio takes: a number with at most two decimals (17550 → 175.5). */
export const toEuros = (cents: number): number => Math.round(cents) / 100;

/** `vercelEnv`: Vercel's VERCEL_ENV ("production", "preview", "development"), set with VERCEL; undefined elsewhere. */
export type Runtime = { production: boolean; onVercel: boolean; vercelEnv?: string };

/** This process: a production build (`next start`, Vercel) or not, on Vercel or not (VERCEL is set there, build and run time), and which of Vercel's environments. */
export const currentRuntime = (): Runtime => ({ production: process.env.NODE_ENV === "production", onVercel: Boolean(process.env.VERCEL), vercelEnv: process.env.VERCEL_ENV?.trim() || undefined });

/** `referencePrefix`: what this environment's merchantReferences start with (domain/payments.ts orderReference; referencePrefixOf). */
export type MontonioConfig = { accessKey: string; secretKey: string; baseUrl: string; live: boolean; mock: boolean; referencePrefix: string };

/** The names of this machine: the only places the fake Montonio is ever reached, whatever MONTONIO_FAKE_URL says. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `value` parsed, when it is plain http on this machine (localhost, 127.0.0.1 or [::1]) with no user name or password in it; else null. */
function localHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname) && !url.username && !url.password ? url : null;
}

/**
 * This environment's reference prefix: MONTONIO_REFERENCE_PREFIX when it is set (null when it is no prefix: domain/payments.ts
 * isReferencePrefix); else MSLAB-M on Vercel's production only, MSLAB-P on a Vercel preview, and MSLAB-L anywhere else (this machine, the e2e
 * run, a local production build, `vercel dev`). Production keeps the MSLAB-M its rows and Montonio's orders already carry; nowhere else can
 * make a reference of production's by default, whatever keys it holds.
 */
function referencePrefixOf(env: PaymentsEnv, runtime: Runtime): string | null {
  const set = env.MONTONIO_REFERENCE_PREFIX;
  if (set !== undefined) return isReferencePrefix(set) ? set : null;
  if (runtime.onVercel && runtime.vercelEnv === "production") return ORDER_REFERENCE_PREFIX;
  if (runtime.onVercel && runtime.vercelEnv === "preview") return PREVIEW_REFERENCE_PREFIX;
  return LOCAL_REFERENCE_PREFIX;
}

/** "payments are off" is noted once per instance, not on every request. */
let notedOff = false;
function off(why: string): null {
  if (!notedOff) {
    notedOff = true;
    logNote(`[payments] ${why}: online payments are off`);
  }
  return null;
}

/**
 * The store, the address and the reference prefix (referencePrefixOf; one that is no prefix turns payments off, noted once by name), or null:
 * no online payments. Both keys are needed (a blank one counts as not set: paymentsEnv); only one of
 * them is noted once ("online payments are off"), by name. MONTONIO_ENV
 * "live" (exactly) is production, anything else the sandbox. PAYMENT_PROVIDER unset or "montonio" is Montonio; "mock" is the fake at
 * MONTONIO_FAKE_URL, refused on Vercel and in a production build without PAYMENT_MOCK_IN_PRODUCTION=1, and only when that address is plain
 * http on localhost, 127.0.0.1 or [::1] (a remote, https, credentialed or junk address turns payments off, it is never used); any other
 * PAYMENT_PROVIDER value turns payments off. MONTONIO_FAKE_URL is not looked at unless PAYMENT_PROVIDER is "mock".
 */
export function montonioConfig(env: PaymentsEnv = paymentsEnv(), runtime: Runtime = currentRuntime()): MontonioConfig | null {
  const accessKey = env.MONTONIO_ACCESS_KEY;
  const secretKey = env.MONTONIO_SECRET_KEY;
  // neither key is the normal "no payments" and says nothing; one alone is a setting forgotten or mistyped (the names only, never a value)
  if (!accessKey !== !secretKey) return off("only one of MONTONIO_ACCESS_KEY and MONTONIO_SECRET_KEY is set");
  if (!accessKey || !secretKey) return null;
  const referencePrefix = referencePrefixOf(env, runtime);
  if (referencePrefix === null) return off("MONTONIO_REFERENCE_PREFIX must be 2 to 16 capitals, digits or hyphens, not ending in a digit");
  const provider = env.PAYMENT_PROVIDER;
  if (provider === undefined || provider === "montonio") {
    const live = env.MONTONIO_ENV === "live";
    return { accessKey, secretKey, baseUrl: live ? LIVE_BASE : SANDBOX_BASE, live, mock: false, referencePrefix };
  }
  if (provider !== "mock") return off("PAYMENT_PROVIDER is neither montonio nor mock");
  if (runtime.onVercel) return off("PAYMENT_PROVIDER=mock is refused on Vercel");
  if (runtime.production && env.PAYMENT_MOCK_IN_PRODUCTION !== "1") return off("PAYMENT_PROVIDER=mock is refused in a production build without PAYMENT_MOCK_IN_PRODUCTION=1");
  if (!env.MONTONIO_FAKE_URL) return off("PAYMENT_PROVIDER=mock needs MONTONIO_FAKE_URL");
  // in every runtime the mock is allowed in, a dev machine and a flagged production build alike: the fake is on this machine or it is not used
  const fake = localHttpUrl(env.MONTONIO_FAKE_URL);
  if (!fake) return off("MONTONIO_FAKE_URL must be plain http on localhost, 127.0.0.1 or [::1]");
  return { accessKey, secretKey, baseUrl: `${fake.origin}${fake.pathname.replace(/\/+$/, "")}`, live: false, mock: true, referencePrefix };
}

/** Are online payments on (spec 7.2)? Without them the "Maksa" buttons are hidden, the cart keeps its interest form and /api/payments/* are 404. */
export const paymentsConfigured = (env?: PaymentsEnv, runtime?: Runtime): boolean => montonioConfig(env, runtime) !== null;

/** Montonio said no (`rejected`, with its own text in `detail`), could not be reached, or answered something that is no order. */
export class MontonioError extends Error {
  constructor(
    readonly op: "create" | "fetch",
    readonly code: "unreachable" | "rejected" | "bad_response",
    readonly detail = "",
  ) {
    super(`Montonio ${op} ${code}`);
    this.name = "MontonioError";
  }
}

/** Three base64url parts joined by dots, the first starting like a JSON header: a JSON Web Token (an empty signature is still one). */
const JWT_SHAPE = /eyJ[\w-]+\.[\w-]+\.[\w-]*/g;

/**
 * What Montonio said when it refused: the HTTP status and its own message, one short line ("HTTP 401 · STORE_NOT_FOUND - double check your
 * access key"). Its error bodies are not of one shape, so the usual keys are tried and the raw text is the fallback (Rempire's lesson: a bare
 * code hid the reason for weeks). Anything that looks like a token in it is replaced with "[jwt]".
 */
export function montonioErrorText(status: number, body: string): string {
  const raw = String(body ?? "").trim();
  let message = "";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const key of ["message", "error", "detail", "description"]) {
        const v = parsed[key];
        if (typeof v === "string" && v.trim()) {
          message = v.trim();
          break;
        }
        if (Array.isArray(v) && typeof v[0] === "string") {
          message = v.join("; ");
          break;
        }
      }
    } catch {
      // not JSON after all: the raw text below is all there is
    }
  }
  if (!message) message = raw;
  // a gateway can echo the request back, token and all: a token is never kept or logged. It goes out before the text is cut to length (a
  // cut first would leave a readable piece of it), and the text is capped before the scan so that a body of "eyJeyJ…" cannot make it slow
  message = message.slice(0, 2000).replace(JWT_SHAPE, "[jwt]");
  return `HTTP ${status}${message ? ` · ${message.slice(0, 300)}` : ""}`;
}

export type OrderRequest = { reference: string; amountCents: number; locale: "et" | "ru"; returnUrl: string; notificationUrl: string };

/** An order token's facts (the webhook's `orderToken`, the return's `order-token`). `accessKey` null: the token carries none. */
export type OrderToken = {
  uuid: string;
  accessKey: string | null;
  reference: string;
  status: MontonioStatus;
  rawStatus: string;
  amountCents: number | null;
  currency: string | null;
  method: string;
  bank: string;
  /** Past its exp by more than the tolerance (a late webhook retry): settle.ts confirms it with GET /orders/:uuid. */
  expired: boolean;
};

/** What GET /orders/:uuid says about an order. */
export type OrderSnapshot = { uuid: string; reference: string; status: MontonioStatus; rawStatus: string; amountCents: number | null; currency: string | null; method: string };

/**
 * A refund notice's token (the webhook's `{ refundToken }`, sent to the order's notificationUrl when a refund's status changes; Montonio's
 * refunds guide): the order it is about (`orderUuid`), the refund's own id and status (PENDING, PROCESSING, SUCCESSFUL, REJECTED, CANCELED).
 * Its `refundAmount` is not read: what the order is now is asked with GET /orders/:uuid (settle.ts settleRefund), never taken from here.
 */
export type RefundToken = { orderUuid: string; refundUuid: string; accessKey: string | null; rawStatus: string; expired: boolean };

export type Montonio = {
  /** The store's access key: an order token must name it (settle.ts). */
  readonly accessKey: string;
  /** This environment's reference prefix (montonioConfig): a payment is started under it (start.ts), and a token of another is no payment of ours (settle.ts). */
  readonly referencePrefix: string;
  /** POST /orders: the order's Montonio uuid and the page to send the payer to. Throws a MontonioError. */
  createOrder(order: OrderRequest): Promise<{ uuid: string; paymentUrl: string }>;
  /** GET /orders/:uuid, or null on anything at all (no answer, a refusal, no order): never a throw. */
  fetchOrder(uuid: string): Promise<OrderSnapshot | null>;
  /** The facts of an order token. Throws a JwtError when it cannot be trusted (the webhook's 400). */
  verifyOrderToken(token: string): OrderToken;
  /** The facts of a refund notice's token, verified as an order token is. Throws a JwtError when it cannot be trusted (the webhook's 400). */
  verifyRefundToken(token: string): RefundToken;
};

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const UUID = /^[A-Za-z0-9-]{1,100}$/;

/**
 * The client of one store. `fetchImpl` is the platform's fetch, looked up at each call (tests stub it); `clock` is the time the tokens are
 * signed and checked against (ms). Every call carries a 15 s signal and refuses redirects: an API call that redirects is not Montonio's.
 */
export function montonioClient(config: MontonioConfig, fetchImpl: typeof fetch = (input, init) => fetch(input, init), clock: () => number = () => Date.now()): Montonio {
  const nowSec = () => Math.floor(clock() / 1000);

  async function call(op: "create" | "fetch", url: string, init: RequestInit): Promise<{ status: number; body: string }> {
    try {
      const res = await fetchImpl(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return { status: res.status, body: await res.text() };
    } catch {
      throw new MontonioError(op, "unreachable");
    }
  }

  return {
    accessKey: config.accessKey,
    referencePrefix: config.referencePrefix,

    async createOrder(order) {
      if (!Number.isInteger(order.amountCents) || order.amountCents <= 0) throw new RangeError("amountCents must be a positive whole number");
      const amount = toEuros(order.amountCents);
      const data = signHs256(
        {
          accessKey: config.accessKey,
          merchantReference: order.reference,
          returnUrl: order.returnUrl,
          notificationUrl: order.notificationUrl,
          currency: "EUR",
          grandTotal: amount,
          locale: order.locale,
          payment: { method: "paymentInitiation", amount, currency: "EUR", methodOptions: { paymentDescription: `MS LAB ${order.reference}` } },
        },
        config.secretKey,
        { expiresInSeconds: POST_TOKEN_SEC, nowSec: nowSec() },
      );
      const res = await call("create", `${config.baseUrl}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ data }),
      });
      if (res.status < 200 || res.status >= 300) throw new MontonioError("create", "rejected", montonioErrorText(res.status, res.body));
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(res.body);
        if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
        body = parsed as Record<string, unknown>;
      } catch {
        throw new MontonioError("create", "bad_response");
      }
      const uuid = text(body.uuid);
      const paymentUrl = text(body.paymentUrl);
      // the payer is sent there: https only (the e2e run's fake answers on plain http, on this machine, and a mock config takes that only)
      const fine = paymentUrl.startsWith("https://") || (config.mock && localHttpUrl(paymentUrl) !== null);
      if (!uuid || !fine) throw new MontonioError("create", "bad_response");
      return { uuid, paymentUrl };
    },

    async fetchOrder(uuid) {
      const id = uuid.trim();
      if (!UUID.test(id)) return null;
      const bearer = signHs256({ accessKey: config.accessKey }, config.secretKey, { expiresInSeconds: GET_TOKEN_SEC, nowSec: nowSec() });
      let res: { status: number; body: string };
      try {
        res = await call("fetch", `${config.baseUrl}/orders/${encodeURIComponent(id)}`, { headers: { accept: "application/json", authorization: `Bearer ${bearer}` } });
      } catch (e) {
        logFailure("[payments] GET /orders: no answer", e);
        return null;
      }
      if (res.status !== 200) {
        logNote(`[payments] GET /orders: ${montonioErrorText(res.status, res.body)}`);
        return null;
      }
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(res.body);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        body = parsed as Record<string, unknown>;
      } catch {
        return null;
      }
      const raw = text(body.paymentStatus).toUpperCase();
      return { uuid: text(body.uuid) || id, reference: text(body.merchantReference), status: mapMontonioStatus(raw), rawStatus: raw, amountCents: toCents(body.grandTotal), currency: text(body.currency) || null, method: text(body.paymentMethodType) };
    },

    verifyOrderToken(token) {
      const { claims, expired } = verifyHs256<Record<string, unknown>>(token, config.secretKey, { toleranceSec: CLOCK_TOLERANCE_SEC, nowSec: nowSec() });
      const reference = text(claims.merchantReference);
      if (!reference) throw new JwtError("payload");
      const raw = text(claims.paymentStatus).toUpperCase();
      return {
        uuid: text(claims.uuid),
        accessKey: text(claims.accessKey) || null,
        reference,
        status: mapMontonioStatus(raw),
        rawStatus: raw,
        amountCents: toCents(claims.grandTotal),
        currency: text(claims.currency) || null,
        method: text(claims.paymentMethod),
        bank: text(claims.paymentProviderName),
        expired,
      };
    },

    verifyRefundToken(token) {
      // the same check as an order token's: HS256 only (any other alg is refused before the signature is looked at), constant-time compare
      const { claims, expired } = verifyHs256<Record<string, unknown>>(token, config.secretKey, { toleranceSec: CLOCK_TOLERANCE_SEC, nowSec: nowSec() });
      const orderUuid = text(claims.orderUuid);
      if (!orderUuid) throw new JwtError("payload");
      return { orderUuid, refundUuid: text(claims.refundUuid), accessKey: text(claims.accessKey) || null, rawStatus: text(claims.refundStatus).toUpperCase(), expired };
    },
  };
}

/** The app's Montonio (the settings of this process), or null: no online payments. */
export function paymentProvider(env: PaymentsEnv = paymentsEnv(), runtime: Runtime = currentRuntime()): Montonio | null {
  const config = montonioConfig(env, runtime);
  return config ? montonioClient(config) : null;
}
