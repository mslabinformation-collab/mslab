// The server's configuration, read from process.env (Vercel project settings; `.env.local` under `next dev`; see
// .env.example). This is the one place the server reads it, so a missing variable fails the same way everywhere.

import { previewKey } from "@/lib/preview-cookie";

/** The local development database (docker: postgres/postgres on this machine). Never a shared one. */
export const LOCAL_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/mslab";

export type ServerEnv = {
  /** Postgres connection URL (Railway's TCP proxy in production). */
  DATABASE_URL: string;
  /** The site's own address, for links that leave the site and the link preview tags. */
  SITE_URL: string;
  /** The sign-in allow-list, comma-separated. */
  ADMIN_EMAILS: string;
  /** The greeting name of each admin: `<address>=<name>`, comma-separated. */
  ADMIN_NAMES: string;
  /** Where form notifications go. */
  MARIA_EMAIL: string;
  /** The From header of outgoing mail. */
  MAIL_FROM: string;
  RESEND_API_KEY?: string;
  /**
   * The newsletter's Resend key (newsletter campaigns, spec §4 as amended, ruling R15), a full-access key: contacts, segments and broadcasts need
   * one. It alone switches the newsletter on: unset or blank, nothing is synced or sent (server/resend-marketing.ts marketingKey), whatever
   * RESEND_API_KEY is (that one is the site's own mails' key only).
   */
  RESEND_MARKETING_KEY?: string;
  /** The signing secret of Resend's webhook (/api/resend/webhook, `whsec_…`). Unset: every event is refused (400). */
  RESEND_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  /** Overrides the chat id stored in the KV under `tg:chat`. */
  TELEGRAM_CHAT_ID?: string;
  /** The access key of the review comment list. */
  ADMIN_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  /** "1": without R2, a production build keeps uploads in the local folder too (`next start` on this machine only). */
  MEDIA_LOCAL?: string;
  /** The daily cron's secret: Vercel sends `Authorization: Bearer <it>` (app/api/cron/sweep). Unset, the cron is refused. */
  CRON_SECRET?: string;
  /** Bunny Stream (lesson videos): the library's id, its API key (server only), its embed token authentication key (server only). All three or no video. */
  BUNNY_LIBRARY_ID?: string;
  BUNNY_API_KEY?: string;
  BUNNY_TOKEN_KEY?: string;
  /** The query secret of the webhook URL (/api/bunny/webhook?secret=…). Optional: the webhook only triggers a status read. */
  BUNNY_WEBHOOK_SECRET?: string;
  /** The e2e run's fake Bunny server (tests/e2e/fake-bunny.ts). Ignored on Vercel (server/bunny.ts). */
  BUNNY_FAKE_URL?: string;
  /** The coming-soon gate (lib/site-gate.ts): "1" until the launch, and visitors see only the coming-soon page. The middleware reads it (gateEnv). */
  SITE_GATE?: string;
  /** The key of the admins' preview cookie (lib/preview-cookie.ts). Unset with the gate on: nobody gets past the gate. */
  PREVIEW_SECRET?: string;
  /** Montonio (phase 2b, docs/deploy.md section 2): only the exact "live" is production; anything else is the sandbox. */
  MONTONIO_ENV?: string;
  /** The Montonio store's access key and secret key, per store and environment. Both, or no online payments. */
  MONTONIO_ACCESS_KEY?: string;
  MONTONIO_SECRET_KEY?: string;
  /**
   * "mock": the e2e run's fake Montonio at MONTONIO_FAKE_URL (tests/e2e/fake-montonio.ts). Refused on Vercel; in a production build only with
   * PAYMENT_MOCK_IN_PRODUCTION=1. MONTONIO_FAKE_URL must be plain http on localhost, 127.0.0.1 or [::1]: any other address turns payments off.
   */
  PAYMENT_PROVIDER?: string;
  MONTONIO_FAKE_URL?: string;
  PAYMENT_MOCK_IN_PRODUCTION?: string;
  /**
   * What this environment's Montonio references start with (server/payments/montonio.ts): 2 to 16 capitals, digits or hyphens, not ending in a
   * digit. Unset: MSLAB-M on Vercel's production, MSLAB-P on a preview, MSLAB-L anywhere else. Any other value turns payments off.
   */
  MONTONIO_REFERENCE_PREFIX?: string;
};

type Source = Record<string, string | undefined>;
type RequiredName = "DATABASE_URL" | "SITE_URL" | "ADMIN_EMAILS" | "ADMIN_NAMES" | "MARIA_EMAIL" | "MAIL_FROM";

/**
 * The required variables, in the order an error lists them, each with the value `next dev` and the tests fall back to
 * when it is not set (never in production). The local database is a default so `next dev` and the e2e run need no setup.
 * SITE_URL and MAIL_FROM default to the public production values.
 * The addresses default to empty: nobody can sign in and nothing is sent until `.env.local` sets them (.env.example).
 */
const REQUIRED: readonly [RequiredName, string][] = [
  ["DATABASE_URL", LOCAL_DATABASE_URL],
  ["SITE_URL", "https://mslab.ee"],
  ["ADMIN_EMAILS", ""],
  ["ADMIN_NAMES", ""],
  ["MARIA_EMAIL", ""],
  ["MAIL_FROM", "MS LAB <info@send.mslab.ee>"],
];

/** The error for a DATABASE_URL that cannot be used. It never holds the value. */
export const BAD_DATABASE_URL = "DATABASE_URL is not a valid postgres:// or postgresql:// URL";

/**
 * Is it a postgres:// or postgresql:// URL that `new URL` accepts? (A postgres.js URL with several hosts or a socket path
 * does not parse, and is not used here.) Any other scheme is a mistake too (an http or redis address pasted by accident).
 */
function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
}

const OPTIONAL = [
  "RESEND_API_KEY",
  "RESEND_MARKETING_KEY",
  "RESEND_WEBHOOK_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "ADMIN_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "MEDIA_LOCAL",
  "CRON_SECRET",
  "BUNNY_LIBRARY_ID",
  "BUNNY_API_KEY",
  "BUNNY_TOKEN_KEY",
  "BUNNY_WEBHOOK_SECRET",
  "BUNNY_FAKE_URL",
  "SITE_GATE",
  "PREVIEW_SECRET",
  "MONTONIO_ENV",
  "MONTONIO_ACCESS_KEY",
  "MONTONIO_SECRET_KEY",
  "PAYMENT_PROVIDER",
  "MONTONIO_FAKE_URL",
  "PAYMENT_MOCK_IN_PRODUCTION",
  "MONTONIO_REFERENCE_PREFIX",
] as const;

/**
 * The configuration, typed. A variable that is empty or only spaces counts as not set (a settings form can save an
 * empty one).
 *
 * In production every required variable must be set: otherwise this throws an error that names the missing variables
 * (all of them) and never shows a value. Outside production (`next dev`, the tests) the required ones fall back to the
 * local values above. A DATABASE_URL that is not a postgres:// or postgresql:// URL is an error too (no value shown):
 * left to postgres.js, its own TypeError would quote the whole string, password included. `source` and `production`
 * are for the tests; the defaults are process.env and NODE_ENV.
 */
export function serverEnv(source: Source = process.env, production: boolean = process.env.NODE_ENV === "production"): ServerEnv {
  const read = (name: string): string | undefined => source[name]?.trim() || undefined;
  const missing: string[] = [];
  const env: Partial<ServerEnv> = {};
  for (const [name, fallback] of REQUIRED) {
    const value = read(name) ?? (production ? undefined : fallback);
    if (value === undefined) missing.push(name);
    else env[name] = value;
  }
  if (missing.length) throw new Error(`Missing required environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  if (!isPostgresUrl(env.DATABASE_URL!)) throw new Error(BAD_DATABASE_URL); // no cause: the URL error carries the input
  for (const name of OPTIONAL) env[name] = read(name);
  return env as ServerEnv;
}

/**
 * The coming-soon gate's two settings, for the middleware (lib/site-gate.ts). Not serverEnv(): that would also insist on
 * the six required ones, which the gate does not need. Blank counts as not set, as above; so does a PREVIEW_SECRET
 * shorter than 32 characters (lib/preview-cookie.ts previewKey): with the gate on, nobody passes then.
 */
export function gateEnv(source: Source = process.env): Pick<ServerEnv, "SITE_GATE" | "PREVIEW_SECRET"> {
  return { SITE_GATE: source.SITE_GATE?.trim() || undefined, PREVIEW_SECRET: previewKey(source.PREVIEW_SECRET) };
}

/** The payment settings (server/payments/montonio.ts montonioConfig). */
export type PaymentsEnv = Partial<
  Pick<ServerEnv, "MONTONIO_ENV" | "MONTONIO_ACCESS_KEY" | "MONTONIO_SECRET_KEY" | "PAYMENT_PROVIDER" | "MONTONIO_FAKE_URL" | "PAYMENT_MOCK_IN_PRODUCTION" | "MONTONIO_REFERENCE_PREFIX">
>;

const PAYMENT_NAMES = ["MONTONIO_ENV", "MONTONIO_ACCESS_KEY", "MONTONIO_SECRET_KEY", "PAYMENT_PROVIDER", "MONTONIO_FAKE_URL", "PAYMENT_MOCK_IN_PRODUCTION", "MONTONIO_REFERENCE_PREFIX"] as const;

/**
 * The payment settings alone, trimmed, blank as not set (phase 2b). Not serverEnv(): the static cart page reads them while it renders, and a
 * build or a render must not depend on the six required variables for that.
 */
export function paymentsEnv(source: Source = process.env): PaymentsEnv {
  const out: PaymentsEnv = {};
  for (const name of PAYMENT_NAMES) out[name] = source[name]?.trim() || undefined;
  return out;
}
