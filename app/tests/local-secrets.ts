import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { E2E_BUNNY } from "./e2e/bunny-values";
import { E2E_MONTONIO } from "./e2e/montonio-values";

// The settings of local development and the tests, read from .env.example: placeholders, never a real address (the real
// ones are Environment Variables of the Vercel project). The Playwright configs hand them to the server they start
// (tests/e2e/server.ts).

/** KEY=VALUE lines of a .env-style file (comments and blank lines skipped; `export KEY=VALUE` counts). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const vars = parseEnvFile(readFileSync(join(process.cwd(), ".env.example"), "utf8"));
for (const key of ["DATABASE_URL", "SITE_URL", "ADMIN_EMAILS", "ADMIN_NAMES", "MARIA_EMAIL", "MAIL_FROM"]) if (!vars[key]) throw new Error(`.env.example: ${key} is missing`);

/**
 * The e2e servers' mail outbox (server/mail-outbox.ts): a newsletter campaign's mails are written here, one JSON line each, instead of being sent
 * (the servers have no RESEND_API_KEY, and the run refuses to start with one). In the production build's own folder, which `next build` empties; the
 * newsletter e2e test reads it (tests/e2e/newsletter-campaigns.spec.ts).
 */
export const E2E_MAIL_OUTBOX = resolve(process.cwd(), ".next", "e2e-mail-outbox.jsonl");

/** The daily jobs' secret on the e2e servers (`Authorization: Bearer <it>`, /api/cron/*): made up, local only, never a real project's. */
export const E2E_CRON_SECRET = "e2e-cron-secret-local-only-9f3a6c1d";

/**
 * What the server of an e2e run is started with (server/env.ts): the six required settings, so the production build
 * (whose configuration must be complete) starts too: the local database and the admin allow-list the tests sign in with.
 * These win over a .env.local of your own, so a run is the same on every machine. The R2 variables are blank
 * (server/env.ts counts a blank one as not set), so the server keeps uploads in its local folder whatever a .env.local
 * says; global-setup also refuses to run when one is set anywhere (FORBIDDEN_SETTINGS). The Bunny settings point at the
 * fake Bunny on this machine (tests/e2e/fake-bunny.ts, BUNNY_FAKE_URL) with made-up keys, never the real library.
 * The payments go to the fake Montonio on this machine (tests/e2e/fake-montonio.ts, PAYMENT_PROVIDER=mock) with made-up keys: these win
 * over the sandbox keys of your own .env.local, so a run never reaches the real sandbox. A newsletter campaign's mails go to the outbox file
 * (E2E_MAIL_OUTBOX), never to Resend, and the daily jobs have a CRON_SECRET of their own (E2E_CRON_SECRET) for the test that calls them.
 */
export const LOCAL_ENV = {
  DATABASE_URL: vars.DATABASE_URL,
  SITE_URL: vars.SITE_URL,
  ADMIN_EMAILS: vars.ADMIN_EMAILS,
  ADMIN_NAMES: vars.ADMIN_NAMES,
  MARIA_EMAIL: vars.MARIA_EMAIL,
  MAIL_FROM: vars.MAIL_FROM,
  R2_ACCOUNT_ID: "",
  R2_ACCESS_KEY_ID: "",
  R2_SECRET_ACCESS_KEY: "",
  R2_BUCKET: "",
  BUNNY_LIBRARY_ID: E2E_BUNNY.libraryId,
  BUNNY_API_KEY: E2E_BUNNY.apiKey,
  BUNNY_TOKEN_KEY: E2E_BUNNY.tokenKey,
  BUNNY_WEBHOOK_SECRET: E2E_BUNNY.webhookSecret,
  BUNNY_FAKE_URL: E2E_BUNNY.url,
  MONTONIO_ENV: "sandbox",
  MONTONIO_ACCESS_KEY: E2E_MONTONIO.accessKey,
  MONTONIO_SECRET_KEY: E2E_MONTONIO.secretKey,
  PAYMENT_PROVIDER: "mock",
  MONTONIO_FAKE_URL: E2E_MONTONIO.url,
  E2E_MAIL_OUTBOX,
  CRON_SECRET: E2E_CRON_SECRET,
};

/**
 * Settings an e2e run must not have, each with what it would do: the form tests would reach real people, the upload
 * tests would write to the real image bucket (the server of an e2e run keeps images in a local folder), and the video
 * tests would create videos in the real Bunny library (the server of an e2e run talks to the fake Bunny).
 */
export const FORBIDDEN_SETTINGS: Record<string, string> = {
  RESEND_API_KEY: "the form tests would send real e-mails",
  TELEGRAM_BOT_TOKEN: "the form tests would send real Telegram messages",
  R2_ACCOUNT_ID: "the upload tests would write to the real image bucket",
  R2_ACCESS_KEY_ID: "the upload tests would write to the real image bucket",
  R2_SECRET_ACCESS_KEY: "the upload tests would write to the real image bucket",
  R2_BUCKET: "the upload tests would write to the real image bucket",
  BUNNY_API_KEY: "the video tests would create videos in the real Bunny library",
};

/** The value of a .env line without its quotes: `R2_BUCKET=""` sets nothing. */
const unquoted = (value: string | undefined) => (value ?? "").replace(/^(["'])(.*)\1$/, "$2").trim();

/** The env files the server of an e2e run reads (`next dev` the development ones, `next start` the production ones). */
export const SERVER_ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"];

/**
 * The reason a run must stop, or undefined when it may go on. `files` are the texts of the env files the server would
 * read (name -> text; a missing file is undefined), `env` the environment the run starts in. A setting counts when it
 * has a value: a commented-out or empty one does not. The message names the setting, never its value.
 */
export function forbiddenSettingError(files: Record<string, string | undefined>, env: Record<string, string | undefined>): string | undefined {
  for (const [file, text] of Object.entries(files)) {
    const set = text === undefined ? {} : parseEnvFile(text);
    const name = Object.keys(FORBIDDEN_SETTINGS).find((n) => unquoted(set[n]));
    if (name) return `e2e: ${file} sets ${name} — ${FORBIDDEN_SETTINGS[name]}`;
  }
  const name = Object.keys(FORBIDDEN_SETTINGS).find((n) => env[n]?.trim());
  if (name) return `e2e: ${name} is set in the environment — ${FORBIDDEN_SETTINGS[name]}`;
  return undefined;
}

/** The local allow-list, in order: the e2e tests sign in as the first one only. */
export const LOCAL_ADMINS = vars.ADMIN_EMAILS.split(",").map((a) => a.trim());
