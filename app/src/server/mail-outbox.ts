import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ServerEnv } from "./env";
import { logFailure } from "./log";
import type { Mail, MailOutcome, sendMailResult } from "./notify";

// The e2e run's mail outbox (the simple newsletter, Task 5). The e2e servers (tests/local-secrets.ts) have no RESEND_API_KEY, and must not: the
// login and the forms rely on the mail being "not set up" (a dev link, no notification). So a newsletter campaign's mails (the press, the daily job and
// „Saada proov“: send-deps.ts campaignSendDeps hands the engine this `send`, the seam it already has) are not sent at all: each one is appended to a file
// as a JSON line and counted as accepted, and the e2e test reads the file. The real Resend is never reached, and no other mail of the site is touched.
//
// It is the e2e run's and nothing else's, as the fake Montonio is (server/payments/montonio.ts): E2E_MAIL_OUTBOX, an absolute file path, is the only way
// in; it is ignored on Vercel (VERCEL is set there, build and runtime), whatever the project's variables say, and in a production build (`next start`)
// only together with E2E_MAIL_IN_PRODUCTION=1, which only the e2e run's production build (tests/e2e/prod-build.ts) carries. Ignored means the real
// sender is used, and the log says so once. An outbox that swallowed the real site's newsletter and called it sent would be the worst failure there is,
// so the gate is checked on every campaign send, not once at start-up.

/** The two settings of the outbox (server/env.ts). */
export type OutboxEnv = Partial<Pick<ServerEnv, "E2E_MAIL_OUTBOX" | "E2E_MAIL_IN_PRODUCTION">>;
/** Where the server runs: a production build (`next start`, not `next dev`), and Vercel. */
export type OutboxRuntime = { production: boolean; onVercel: boolean };

export const currentOutboxRuntime = (): OutboxRuntime => ({ production: process.env.NODE_ENV === "production", onVercel: Boolean(process.env.VERCEL) });

const told = new Set<string>();
/** Says once per process why the outbox is not used (the setting's name only, never its value). */
function ignored(reason: string): null {
  if (!told.has(reason)) {
    told.add(reason);
    console.warn(`[mail-outbox] E2E_MAIL_OUTBOX is ignored: ${reason}`);
  }
  return null;
}

/** The outbox file, or null: no outbox (the usual case: the setting is not there), or one the runtime refuses. */
export function outboxFile(env: OutboxEnv, runtime: OutboxRuntime = currentOutboxRuntime()): string | null {
  const file = env.E2E_MAIL_OUTBOX?.trim();
  if (!file) return null;
  if (runtime.onVercel) return ignored("it is refused on Vercel");
  if (runtime.production && env.E2E_MAIL_IN_PRODUCTION !== "1") return ignored("it is refused in a production build without E2E_MAIL_IN_PRODUCTION=1");
  if (!isAbsolute(file)) return ignored("it is not an absolute path");
  return file;
}

/** One line of the outbox file, as the e2e test reads it. */
export type OutboxMail = { at: string; to: string; subject: string; headers: Record<string, string>; text: string; html: string | null };

/**
 * The `send` of an e2e server (newsletter-campaigns.ts SendDeps.send, in place of notify.ts sendMailResult): the mail is appended to `file` and the answer
 * is "accepted". It does not count on the day's mail counter (the e2e run sets the campaign's own room with the settings row instead). A file that cannot
 * be written is `refused`: the batch stops and the page says so, rather than a mail the test would never find.
 */
export function outboxSend(file: string): typeof sendMailResult {
  return async (_env, mail: Mail): Promise<MailOutcome> => {
    const line: OutboxMail = { at: new Date().toISOString(), to: mail.to, subject: mail.subject, headers: mail.headers ?? {}, text: mail.text, html: mail.html ?? null };
    try {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(line)}\n`);
    } catch (e) {
      logFailure("[mail-outbox] the mail could not be written", e);
      return { ok: false, kind: "refused" };
    }
    console.info("[mail-outbox] a mail was written to the e2e outbox, not sent");
    return { ok: true };
  };
}

/** The `send` for the campaign deps: the outbox's when this server may use one, else none (the real sender). */
export function campaignMailSend(env: OutboxEnv, runtime?: OutboxRuntime): typeof sendMailResult | undefined {
  const file = outboxFile(env, runtime);
  return file ? outboxSend(file) : undefined;
}
