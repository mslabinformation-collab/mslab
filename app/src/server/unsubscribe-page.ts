import { adminEt } from "@/i18n/dict/admin";
import { getDict, type Locale } from "@/i18n/locales";
import { esc } from "./account-mail";

// The page behind the unsubscribe link of the welcome mail (GET /api/newsletter/loobu?t=<token>). Opening the link only shows it; the
// button posts the token back, and that POST is what unsubscribes (so a mail gateway that fetches every link of a mail unsubscribes no
// one). Standalone HTML built here, as the e-mails are: no React, no script, no external resource. The colours are the site's tokens
// (src/styles/tokens.css: --ink, --paper, --canvas, --line); the site's fonts are loaded by the site's own pages, so here they are only
// named, with the system fonts behind them.

const CSS = [
  ":root{--ink:#222222;--paper:#ffffff;--canvas:#f6f4f5;--line:#e6e1e3}",
  "*{box-sizing:border-box}",
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--canvas);color:var(--ink);font:400 16px/1.5 Manrope,system-ui,sans-serif}",
  "main{width:100%;max-width:480px;background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:32px 24px}",
  ".brand{margin:0 0 24px;font:600 14px/1 Jost,system-ui,sans-serif;letter-spacing:.14em}",
  "h1{margin:0 0 12px;font:600 24px/1.3 Jost,system-ui,sans-serif}",
  "p{margin:0 0 24px}",
  "form{margin:0}",
  "button{display:block;width:100%;min-height:48px;padding:0 32px;border:0;border-radius:99px;background:var(--ink);color:var(--paper);font:600 16px/1 Jost,system-ui,sans-serif;cursor:pointer}",
  "button:focus-visible{outline:2px solid var(--ink);outline-offset:3px}",
  "@media (min-width:480px){main{padding:40px 36px}button{width:auto}}",
].join("");

/**
 * The page in `locale`, with the form that posts `token` to the same route (`token` null: the link has no usable token, so no form and no
 * button, only the heading and the lead line). The token is escaped into the hidden input.
 */
export function unsubscribePage(locale: Locale, token: string | null): string {
  const t = getDict(locale).newsletter.unsubscribePage;
  const form = token === null ? "" : `<form method="post" action="/api/newsletter/loobu"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">${esc(t.button)}</button></form>`;
  return page(locale, t.heading, t.lead, form);
}

/**
 * The page behind the unsubscribe link of a test campaign that went to an address which is no subscriber (?proov=1, newsletter campaigns ruling
 * R4): the heading and the line that it is a test (adminEt: only an admin gets a test), no form. In Estonian.
 */
export function testUnsubscribePage(): string {
  return page("et", getDict("et").newsletter.unsubscribePage.heading, adminEt.newsletter.campaigns.testPage, "");
}

function page(locale: Locale, heading: string, lead: string, form: string): string {
  return [
    "<!doctype html>",
    `<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">`,
    `<title>${esc(heading)} – MS LAB</title><style>${CSS}</style></head>`,
    `<body><main><p class="brand">MS LAB</p><h1>${esc(heading)}</h1><p>${esc(lead)}</p>${form}</main></body></html>`,
  ].join("");
}
