import { after } from "next/server";
import { getDb } from "@/db/client";
import { testerOf, type AnswersDoc, type Ping } from "@/domain/testplan";
import { withAdmin } from "@/server/auth";
import { serverEnv } from "@/server/env";
import { readBody } from "@/server/feedback";
import { serverKv } from "@/server/kv";
import { logFailure, logNote } from "@/server/log";
import { sendTelegram, type Env } from "@/server/notify";
import { linkBase, requestOrigin } from "@/server/site";
import { pageView, pingText, readAnswers, saveAnswers, testPlan, testplanYou } from "@/server/testplan";

export const dynamic = "force-dynamic";

/** A save is at most this many bytes (about 300 answers with the longest notes is far under it). */
const BODY_MAX = 128 * 1024;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * GET /api/admin/testplan — the test page's plan and everybody's answers (phase 4, piece 1, spec §5): signed-in admins only (withAdmin: 401 JSON
 * without a session). 200 `{ ok: true, plan, answers, auto, you }`: `answers` are the plan's checks' answers by id, each `{ status, note, at, byName }`
 * (never the answerer's e-mail address), `you` is `{ name, tester }`, whose tester the page's „Kes“ choice „Mina“ follows (server/testplan.ts
 * testplanYou; the page's own copy comes with its HTML). A 401 is the page's signed-out state (admin UX pass piece 4c, R-i). Dim 25.10: `auto`
 * is Automaattest's answers, kept apart (a chip in each check's row, and since Dim 29.10 the check's state where no person's answer stands); for
 * Automaattest's own session `answers` are its own (server/testplan.ts pageView). When the answers cannot be read, 503 `{ ok: false, error:
 * "unavailable", plan, answers: null, you }`: the page still shows the plan and keeps its answers on the device. Never cached.
 */
export const GET = withAdmin(async (_request, _ctx, { email }) => {
  const names = serverEnv().ADMIN_NAMES;
  const you = testplanYou(email, names);
  try {
    const doc = await readAnswers(getDb());
    return json({ ok: true, plan: testPlan, ...pageView(doc, testPlan, names, you.tester), you });
  } catch (e) {
    logFailure("[testplan] the answers could not be read", e);
    return json({ ok: false, error: "unavailable", plan: testPlan, answers: null, you }, 503);
  }
});

/**
 * The Telegram messages a save earned, once the answer has gone: one after the other, each send awaited, with no pause between them (so a long
 * offline outbox carrying several Vead sends them in one burst, and Telegram may refuse the later ones, about a message a second per chat). A
 * send that fails or is refused is logged with the check's id and nothing else and is not tried again (the messages were recorded as sent with
 * the save); it never changes the answer or stops the messages after it.
 */
async function sendPings(env: Env, pings: Ping[], doc: AnswersDoc, names: string, base: string): Promise<void> {
  for (const ping of pings) {
    try {
      if (!(await sendTelegram(env, pingText(ping, testPlan, doc, names, base)))) logNote(`[testplan] a Telegram message failed (check ${ping.id})`);
    } catch (e) {
      logFailure(`[testplan] a Telegram message failed (check ${ping.id})`, e);
    }
  }
}

/**
 * PUT /api/admin/testplan — a save of answers, body `{ answers: { <id>: { status: ok | bad | skip, note } } }` (`clientAt` is allowed and
 * ignored: the server stamps `at`, and `by` is the session's e-mail address, never the body's). Dim 29.10: `{ status: "clear" }` (note absent or
 * any text, ignored) takes the check's answer back from the session's own side (the shared answers, or Automaattest's `auto`); it earns no
 * message, and a clear of a check with no answer is a save that changes nothing. Signed-in admins only; a cross-site PUT is
 * 403 (withAdmin). 200 `{ ok: true, answers }`: all the plan's answers as GET gives them, merged (Automaattest's own for its session, Dim 25.10:
 * its saves go into the row's `auto` and never into the shared answers). 400 `{ ok: false, error: "invalid" }`
 * for a body that is not a save; 413 `{ ok: false, error: "tooLarge" }` over 128 KB; 503 `{ ok: false, error: "unavailable" }` when the
 * database fails (the device keeps the answers and tries again). The Telegram messages of a new Viga and of the first note on any answer (a Viga's, an OK's or a Jäta vahele's: "· {status}"
 * ends it) go out after the answer (server/testplan.ts saveAnswers). Never cached.
 */
export const PUT = withAdmin(async (request, _ctx, { email }) => {
  let body: unknown;
  try {
    // (read from the stream up to the cap: a body over it is refused by its declared length, or as soon as it passes the cap, never read whole)
    const text = await readBody(request, BODY_MAX);
    if (text === null) return json({ ok: false, error: "tooLarge" }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "invalid" }, 400);
  }

  const config = serverEnv();
  let saved;
  try {
    saved = await saveAnswers(getDb(), email, body, new Date(), config.ADMIN_NAMES);
  } catch (e) {
    logFailure("[testplan] the save failed", e);
    return json({ ok: false, error: "unavailable" }, 503);
  }
  if (!saved.ok) return json({ ok: false, error: saved.error }, 400);

  const { doc, pings } = saved;
  if (pings.length > 0) {
    const env = { ...config, KV: serverKv() };
    const base = linkBase(requestOrigin(request.headers), config.SITE_URL);
    after(() => sendPings(env, pings, doc, config.ADMIN_NAMES, base));
  }
  return json({ ok: true, answers: pageView(doc, testPlan, config.ADMIN_NAMES, testerOf(email, config.ADMIN_NAMES)).answers });
});
