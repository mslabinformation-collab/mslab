import { contactZoomOf, DEFAULT_CONTACT_POS, isHttpsUrl, parseFocal, portraitFraming } from "@/domain/site-editor";
import type { WelcomeCode } from "@/server/discount-codes";
import { pick, type I18n } from "@/i18n/field";
import type { Locale } from "@/i18n/locales";

// The parts of the settings table the site shell needs, with safe defaults (keys: see db/schema.ts settings).

export type FooterContact = { email: string; phone: string; instagram: string; facebook: string };
/**
 * The footer's sign-up block: the welcome code's value as its row has it („10%“, „15 €“), or null while no welcome code is valid today (F1: the footer
 * then says `newsletter.bodyNoCode`, with no discount to promise).
 */
export type NewsletterSettings = { discount: string | null };
export type ShellSettings = { newsletter: NewsletterSettings; contact: FooterContact; trainerName: string };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const https = (v: unknown): string => (isHttpsUrl(str(v)) ? str(v) : "");

/** `welcome`: the welcome code valid today (server/discount-codes.ts welcomeCode), read by the caller at the edge with the server's own `now`. */
export function shellSettings(settings: Record<string, unknown>, locale: Locale, welcome: WelcomeCode | null): ShellSettings {
  const contact = obj(settings.contact);
  return {
    // (the stored `newsletter` setting says nothing here any more: the welcome code is a row of discount_codes)
    newsletter: { discount: welcome ? welcome.value : null },
    // social links open in a new tab: https addresses only (the admin stores nothing else; anything older is dropped)
    contact: { email: str(contact.email), phone: str(contact.phone), instagram: https(contact.instagram), facebook: https(contact.facebook) },
    trainerName: pick(trainerNameOf(obj(settings.trainer).name), locale),
  };
}

// ---- Trainer (home teaser, contact block): settings key "trainer" ----

export type TrainerStat = { value: string; label: I18n };
/**
 * `portraitPos`: the portrait's focal point (CSS object-position, set in the admin). `portraitZoom`: only the seed
 * portrait (much white space around Maria) is zoomed in; an uploaded one is shown whole, framed by its focal point.
 */
export type TrainerSettings = {
  name: string;
  role: I18n | null;
  portraitKey: string;
  portraitPos: string;
  portraitZoom: boolean;
  contactPhotoKey: string;
  /**
   * How the small round avatars cut the contact photo (Koolitaja's „Suurendus“ and drag, UX pass 11.11 A11/P7: domain/site-editor.ts circleCrop);
   * null while the portrait stands in for it (the avatars' own default framing).
   */
  contactPhotoCrop: { pos: string; zoom: number } | null;
  stats: TrainerStat[];
};

const i18n = (v: unknown): I18n | null => {
  const o = obj(v);
  const et = str(o.et);
  if (!et) return null;
  const ru = str(o.ru);
  return ru ? { et, ru } : { et };
};

/**
 * The trainer's name in both languages ("Maria Sosnina" / "Мария Соснина", round 2 item 1d). A plain string, as written
 * before the name had a Russian version, is the Estonian name; the RU pages fall back to it.
 */
export function trainerNameOf(v: unknown): I18n | null {
  if (typeof v === "string") return str(v) ? { et: str(v) } : null;
  return i18n(v);
}

export function trainerSettings(settings: Record<string, unknown>, locale: Locale = "et"): TrainerSettings {
  const t = obj(settings.trainer);
  const stats = Array.isArray(t.stats) ? t.stats : [];
  const portraitKey = str(t.portraitKey);
  const framing = portraitFraming(portraitKey, str(t.portraitPos));
  return {
    name: pick(trainerNameOf(t.name), locale),
    role: i18n(t.role),
    portraitKey,
    portraitPos: framing.pos,
    portraitZoom: framing.zoom,
    contactPhotoKey: str(t.contactPhotoKey) || str(t.portraitKey),
    contactPhotoCrop: str(t.contactPhotoKey)
      ? { pos: parseFocal(str(t.contactPhotoPos)) ? str(t.contactPhotoPos).trim() : DEFAULT_CONTACT_POS, zoom: contactZoomOf(t.contactPhotoZoom) }
      : null,
    stats: stats.flatMap((s) => {
      const value = str(obj(s).value);
      const label = i18n(obj(s).label);
      return value && label ? [{ value, label }] : [];
    }),
  };
}
