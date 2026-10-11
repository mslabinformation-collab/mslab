import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { readSetting } from "@/db/queries/public";
import { hasFreeSeat } from "@/db/queries/seats";
import { courses, courseSessions, registrations } from "@/db/schema";
import { groupIban, hasPrepayment, parsePrepayment, paymentReference, PREPAYMENT_KEY, type PrepaymentInfo } from "@/domain/account-cards";
import { formatEUR } from "@/domain/money";
import { amountDue, type Due } from "@/domain/payments";
import { registrationPrice } from "@/domain/registration";
import { pick, type I18n } from "@/i18n/field";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { getDict, type Locale } from "@/i18n/locales";
import { esc } from "./account-mail";
import { crossSiteFormPost } from "./auth";
import { logFailure, logNote } from "./log";
import type { Montonio } from "./payments/montonio";
import { PAY_STARTS_PER_IP, startRegistrationPayment, type StartResult } from "./payments/start";
import { RATE_WINDOW_SEC, rateKey, rateLimit, type TextKv } from "./ratelimit";
import { isTokenShape } from "./token";

// The page behind the "Maksa" link of the registration mail (phase 2b, spec 6.3): /maksa/<pay_token>. Opening the link only shows it (a mail
// gateway that fetches every link must neither create an order nor hold a seat); its button posts back, and that POST starts the payment.
// Standalone HTML built here, as the unsubscribe page is (server/unsubscribe-page.ts): no React, no script, no external resource, the site's
// colour tokens, its fonts only named. The page's language is the registration's. The token is never logged.

/**
 * What the page shows: the registration's course and session, what is due now, and the bank transfer when Maria's instructions can be followed.
 * `full`: an unconfirmed registration's session has no free seat for her (the start's own check, hers left out): the page says so, with no button
 * and no transfer, as the POST does.
 */
export type PayView = {
  token: string;
  locale: Locale;
  registrationId: number;
  course: I18n;
  session: { startsAt: Date; city: string; venue: string } | null;
  due: Due;
  full: boolean;
  transfer: PrepaymentInfo | null;
};

/** The view of a "Maksa" token, or null: a token that cannot be one, or no registration has it. Reads only. */
export async function loadPayView(db: Db, token: string, now: Date): Promise<PayView | null> {
  if (!isTokenShape(token)) return null;
  const [row] = await db
    .select({ registration: registrations, course: courses, session: courseSessions })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(eq(registrations.payToken, token))
    .limit(1);
  if (!row) return null;
  const { registration: r, course, session } = row;
  const pay = parsePrepayment(await readSetting(db, PREPAYMENT_KEY));
  const due = amountDue(
    { status: r.status, paymentChoice: r.paymentChoice, priceCents: registrationPrice(course, r.kind), paidCents: r.paidCents, startsAt: session?.startsAt ?? null, sessionCancelled: session?.status === "cancelled" },
    now,
  );
  // only a prepayment can be refused for a seat (start.ts): a confirmed registration paying its rest holds its place already
  const full = due.kind === "prepayment" && session !== null && !(await hasFreeSeat(db, session, now, r.id));
  return {
    token,
    locale: r.locale === "ru" ? "ru" : "et",
    registrationId: r.id,
    course: course.title,
    session: session ? { startsAt: session.startsAt, city: session.city, venue: session.venue } : null,
    due,
    full,
    transfer: hasPrepayment(pay) ? pay : null,
  };
}

/** The line a POST leaves on the page: the session is full, too many starts, or the payment did not start. */
export type PayNotice = "full" | "failed" | "rate";

const CSS = [
  ":root{--ink:#222222;--paper:#ffffff;--canvas:#f6f4f5;--line:#e6e1e3}",
  "*{box-sizing:border-box}",
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--canvas);color:var(--ink);font:400 16px/1.5 Manrope,system-ui,sans-serif}",
  "main{width:100%;max-width:480px;background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:32px 24px}",
  ".brand{margin:0 0 24px;font:600 14px/1 Jost,system-ui,sans-serif;letter-spacing:.14em}",
  "h1{margin:0 0 16px;font:600 24px/1.3 Jost,system-ui,sans-serif}",
  "p{margin:0 0 16px}",
  ".course{margin:0 0 4px;font:600 18px/1.4 Jost,system-ui,sans-serif}",
  ".when{font-size:14px}",
  ".amount{font:600 20px/1.3 Jost,system-ui,sans-serif}",
  ".notice{padding:12px 14px;border:1px solid var(--line);border-radius:12px}",
  "form{margin:0 0 8px}",
  "button{display:block;width:100%;min-height:48px;padding:0 32px;border:0;border-radius:99px;background:var(--ink);color:var(--paper);font:600 16px/1 Jost,system-ui,sans-serif;cursor:pointer}",
  "button:focus-visible{outline:2px solid var(--ink);outline-offset:3px}",
  ".or{margin:24px 0 8px;font:600 14px/1.4 Jost,system-ui,sans-serif}",
  "dl{display:grid;gap:10px;margin:0;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--canvas)}",
  "dt{font-size:13px}",
  "dd{margin:0;font-weight:600;word-break:break-word}",
  "@media (min-width:480px){main{padding:40px 36px}button{width:auto}}",
].join("");

/**
 * The page. `online`: payments are on (the button). With something due: the amount, a notice line when a POST left one, "Maksa {summa}" /
 * "Maksa ülejäänud {summa}", and the bank transfer's rows — under "või tasu pangaülekandega" when the button is there. Neither the button
 * nor the rows when the session is full (the "full" notice: `view.full`, or what a POST found). Nothing due, or an unknown token: "Selle registreeringu eest pole praegu midagi tasuda." Every value is escaped.
 */
export function payPage(view: PayView | null, opts: { online: boolean; notice?: PayNotice }): string {
  const locale: Locale = view?.locale ?? "et";
  const d = getDict(locale);
  const t = d.payment;
  const labels = d.account.dashboard.payment;
  const parts = [`<p class="brand">MS LAB</p><h1>${esc(t.page.heading)}</h1>`];
  if (view) {
    parts.push(`<p class="course">${esc(pick(view.course, locale))}</p>`);
    if (view.session) {
      const s = view.session;
      const when = [`${formatDate(s.startsAt, locale)} · ${formatTime(s.startsAt, locale)}`, s.city, s.venue].filter(Boolean).join(", ");
      parts.push(`<p class="when">${esc(when)}</p>`);
    }
  }
  // a full session is said whichever way the page was reached (GET, or a POST that was refused for another reason): nothing can be paid
  const kind: PayNotice | undefined = view?.full ? "full" : opts.notice;
  const notice = kind === "full" ? t.page.full : kind === "rate" ? d.forms.errorTooMany : kind === "failed" ? d.forms.errorGeneric : null;
  if (notice) parts.push(`<p class="notice" role="alert" data-pay-notice="${kind}">${esc(notice)}</p>`);
  const due = view && view.due.kind !== "none" ? view.due : null;
  if (!view || !due) {
    if (!notice) parts.push(`<p data-pay-nothing="">${esc(t.page.nothing)}</p>`);
  } else {
    const amount = formatEUR(due.cents, locale);
    parts.push(`<p class="amount">${esc(labels.amount)}: ${esc(amount)}</p>`);
    const button = opts.online && kind !== "full";
    if (button) parts.push(`<form method="post" action="/maksa/${esc(view.token)}"><button type="submit">${esc(fill(due.kind === "balance" ? t.payRest : t.pay, { amount }))}</button></form>`);
    // (a full session: no button and no bank rows either; a transfer would pay for a place that is gone)
    if (view.transfer && kind !== "full") {
      const pay = view.transfer;
      const rows = ([
        [labels.receiver, pay.receiver],
        [labels.iban, groupIban(pay.iban)],
        [labels.bank, pay.bank],
        [labels.amount, amount],
        [labels.reference, paymentReference(pay, view.registrationId)],
      ] as [string, string][]).filter(([, value]) => value.trim() !== "");
      if (button) parts.push(`<p class="or">${esc(t.transfer)}</p>`);
      parts.push(`<dl data-pay-transfer="">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`);
    }
  }
  return [
    "<!doctype html>",
    `<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">`,
    `<title>${esc(t.page.heading)} – MS LAB</title><style>${CSS}</style></head>`,
    `<body><main>${parts.join("")}</main></body></html>`,
  ].join("");
}

export type PayPageDeps = {
  db: Db;
  /** The rate limits' store (Postgres kv_entries). */
  kv: TextKv;
  now: Date;
  /** The base of the payer's way back (the return): this request's own origin when it is one of ours, else SITE_URL. */
  siteUrl: string;
  /** SITE_URL: the base of Montonio's webhook, never this request's origin (payments/start.ts StartDeps). */
  notifyBase: string;
  montonio: Montonio | null;
  /** The visitor's address (the per-IP limit); null: not limited (never on Vercel). */
  ip: string | null;
};

const html = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

/** The per-IP limit of payment starts (fails open, as the forms' limits). */
async function withinPayLimit(deps: PayPageDeps): Promise<boolean> {
  if (deps.ip === null) return true;
  try {
    return await rateLimit(deps.kv, rateKey("pay", deps.ip), PAY_STARTS_PER_IP, RATE_WINDOW_SEC);
  } catch (e) {
    logFailure("[payments] rate limit unavailable, allowing", e);
    return true;
  }
}

/**
 * GET /maksa/<token>: the page, nothing else. POST (its button): a cross-site POST is 403; else what is due is checked again and the payment
 * starts (server/payments/start.ts): 303 to Montonio's page. Nothing due by now: the page (its sentence). The session full: 409 with its line;
 * 5 starts from this IP in 10 minutes or 5 of this registration in an hour: 429; Montonio down or no payments: 503 "Midagi läks valesti".
 * The hold: what a start refreshes it refreshes together with a pending payment (one transaction), and a failed new order ends it again
 * (db/queries/payments.ts failPayment), so a refusal or a throw here has no hold of its own to release. (A failed re-send keeps its row
 * pending and its hold: that order may be paid already, start.ts order.)
 */
export async function handlePayPage(request: Request, token: string, deps: PayPageDeps): Promise<Response> {
  const online = deps.montonio !== null;
  if (request.method === "POST" && crossSiteFormPost(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  let view: PayView | null;
  try {
    view = await loadPayView(deps.db, token, deps.now);
  } catch (e) {
    logFailure("[payments] the pay page could not be read", e);
    return html(payPage(null, { online, notice: "failed" }), 503);
  }
  if (request.method !== "POST" || !view || view.due.kind === "none") return html(payPage(view, { online }));
  if (!(await withinPayLimit(deps))) {
    logNote("[payments] pay page: starts rate limited");
    return html(payPage(view, { online, notice: "rate" }), 429);
  }
  let result: StartResult;
  try {
    result = await startRegistrationPayment({ db: deps.db, now: deps.now, siteUrl: deps.siteUrl, notifyBase: deps.notifyBase, montonio: deps.montonio }, { payToken: token });
  } catch (e) {
    logFailure("[payments] pay page: the payment did not start", e);
    result = { kind: "failed" };
  }
  switch (result.kind) {
    case "started":
      return new Response(null, { status: 303, headers: { location: result.paymentUrl, "cache-control": "no-store" } });
    case "full":
      return html(payPage(view, { online, notice: "full" }), 409);
    case "rate":
      return html(payPage(view, { online, notice: "rate" }), 429);
    case "nothing":
    case "notFound": {
      // what is due changed between the page and the start (paid meanwhile, called off): the page as it is now
      try {
        return html(payPage(await loadPayView(deps.db, token, deps.now), { online }));
      } catch (e) {
        logFailure("[payments] the pay page could not be read", e);
        return html(payPage(null, { online, notice: "failed" }), 503);
      }
    }
    default:
      return html(payPage(view, { online, notice: "failed" }), 503);
  }
}
