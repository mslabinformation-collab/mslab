// The home page's popup: the newsletter sign-up (phase 2c; admin UX pass piece 4b, spec D3: the one popup there is — the campaign offer's popup and the
// three-way choice are gone, ruling R-d), which card it shows and when it opens (R-e). Pure: no database, no React.

import type { Campaign } from "@/db/schema";
import { pick } from "@/i18n/field";
import type { Locale } from "@/i18n/locales";
import { mediaUrl } from "@/lib/media";

/** localStorage key, set when the popup is shown: the time (ms since 1970) — it shows once in 30 days per browser (R-e). */
export const POPUP_SEEN_KEY = "mslab-popup";
/** It opens 8 s after the home page appears (R-e; S4-25 „Avaneb uuele külastajale 8 s pärast“). */
export const POPUP_DELAY_MS = 8000;
/** Once in this many days per browser (S4-25 „üks kord 30 päeva jooksul“). */
export const POPUP_EVERY_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * The delay before the popup opens: 8 s, unless the page carries a test's own (window.__mslabCampaignDelay, set by the e2e tests' init script so that
 * they need not wait 8 s each) — a finite number of ms, 0 or more.
 */
export function popupDelay(testValue: unknown): number {
  return typeof testValue === "number" && Number.isFinite(testValue) && testValue >= 0 ? testValue : POPUP_DELAY_MS;
}

/**
 * The popup was shown in this browser less than 30 days before `now`: `stamp` is POPUP_SEEN_KEY's value, the time it was shown in whole ms. Anything
 * else is no stamp (none, the old once-per-visit "1", a time in the future: the clock was set back, and the popup is not kept away longer than 30 days).
 */
export function popupSeenWithin(stamp: string | null, now: number): boolean {
  if (stamp === null || !/^\d{10,16}$/.test(stamp)) return false;
  const age = now - Number(stamp);
  return age >= 0 && age < POPUP_EVERY_DAYS * DAY_MS;
}

/**
 * Whether the popup is due in this browser (R-e), from what its storage holds: never again after a sign-up here (`signed`, NEWSLETTER_SIGNED_KEY's
 * value "1"), and not within 30 days of its last showing (`seen`, POPUP_SEEN_KEY's). The admin's draft preview (`preview`) skips both, so it shows the
 * popup at once in any browser (ruling c2: her own browser may well have signed up).
 */
export function popupDue(stored: { seen: string | null; signed: string | null }, now: number, o: { preview?: boolean } = {}): boolean {
  if (o.preview === true) return true;
  if (stored.signed === "1") return false;
  return !popupSeenWithin(stored.seen, now);
}

/**
 * Hüpikaken's „Eelvaade ↗“ (admin UX pass piece 4b, ruling c1): the home page with `?riba=hupikaken`, whose preview bar is the popup's (popup/0: its
 * count, its „Loobu muudatustest“), not Avaleht's. Read only in the admin's preview (app/[locale]/(site)/page.tsx), never for a visitor.
 */
export const PREVIEW_BAR_PARAM = "riba";
export const POPUP_PREVIEW_BAR = "hupikaken";
export const POPUP_PREVIEW_PATH = `/?${PREVIEW_BAR_PARAM}=${POPUP_PREVIEW_BAR}`;

/** What the newsletter popup's card shows (components/site/NewsletterPopupCard), in the page's language (phase 2c). */
export type NewsletterPopupView = { image: string; kicker: string; title: string; text: string };

/** localStorage key, set after a sign-up from the newsletter popup, and by the confirmed landing: this browser never sees that popup again (spec 5). */
export const NEWSLETTER_SIGNED_KEY = "mslab-nl";

/** The query parameter the newsletter's links land on the home page with: ?uudiskiri=loobutud (the unsubscribe link), kinnitatud | vigane (the old confirmation link) | viga (FlashNotice's `param`). */
export const NEWSLETTER_LANDING_PARAM = "uudiskiri";

/** The value of the landing parameter in an address's query string (`location.search`): any value, empty too; null when the address has none. */
export function newsletterLanding(search: string): string | null {
  return new URLSearchParams(search).get(NEWSLETTER_LANDING_PARAM);
}

/**
 * The popup's card for the home page, or null: no row, a switched-off one, one without a title (the dialog is named by its title), or a row of another
 * kind — the old campaign offer's row 1, which the site no longer shows, active or not (R-d). The welcome code is never in it: it comes in the welcome
 * mail; the popup's button only says one is coming (S4-Q4, components/site/NewsletterPopupCard.tsx popupFormTexts).
 */
export function newsletterPopupView(c: Campaign | null | undefined, locale: Locale): NewsletterPopupView | null {
  if (!c?.active || c.kind !== "newsletter") return null;
  const title = pick(c.title, locale).trim();
  if (!title) return null;
  return { image: mediaUrl(c.imageKey), kicker: pick(c.kicker, locale), title, text: pick(c.text, locale) };
}
