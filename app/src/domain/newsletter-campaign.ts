// The newsletter campaign's pure rules (newsletter campaigns, Task 1; spec D4, D5, §5): the limits, the draft Maria's editor sends checked field by
// field, and the text a subscriber of each language gets. No database, no React: the server (the send, the test mail), Maria's editor and its preview
// share them. It runs in the browser too (the editor), on iOS Safari before 16.4 as well: no lookbehind here nor in what it imports
// (tests/unit/old-safari.test.ts), and no builtin newer than Safari 15. Not to be confused with domain/campaign.ts, the home page's popup.

import type { I18n } from "@/i18n/field";
import { isStorableImageKey } from "@/lib/media";
import { toStorable } from "@/lib/to-storable";
import { paragraphs } from "./catalogue";
import { WELCOME_CODE_MAX, isWelcomeCode, normalizeWelcomeCode } from "./welcome-code";

/** The longest each text may be, in characters; `href` is the button's address and the picture's key. */
export const CAMPAIGN_LIMITS = { name: 80, subject: 150, preheader: 150, body: 10000, buttonLabel: 40, href: 500 } as const;

/**
 * How many mails the site may have sent in a UTC day for a campaign to send another: a campaign sends only while the day's count of every mail
 * (server/client-auth.ts mailsSentToday) is below this. It leaves 30 of Resend's free 100 a day for the site's other mails (logins, confirmations,
 * protocols, invoices, contracts, Maria's notices, welcome mails); what does not fit goes out the next day (spec §3).
 */
export const CAMPAIGN_DAILY_ROOM = 70;

/**
 * The `settings` row that lowers the room of a campaign, and only lowers it: the most mails ONE campaign may send in a UTC day (on top of the day's
 * CAMPAIGN_DAILY_ROOM for every mail). It is read only when it is there. Dim sets it by hand in the database for the check "a campaign larger than the
 * day's room continues the next day" (src/data/testplan.json) and deletes it after; it is per campaign so that the check is "set it to 2", whatever
 * else the site or the earlier checks sent that day. Maria never sees it, and the editor knows nothing of it.
 */
export const CAMPAIGN_ROOM_KEY = "newsletter_daily_room";

/**
 * The value of the row CAMPAIGN_ROOM_KEY as a room: a whole number from 1 to CAMPAIGN_DAILY_ROOM (a fraction is cut, a smaller number is 1, a larger one
 * is the room itself, so a slip of the hand never raises the room above Resend's limit). Anything that is no number is no setting: null.
 */
export function campaignRoomSetting(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(CAMPAIGN_DAILY_ROOM, Math.max(1, Math.floor(value)));
}

/**
 * A campaign as Maria writes it, checked: every optional text is "" (an `I18n` always holds both languages) or null, the code is in capitals, and a
 * button checked for a send has all of its label (Estonian) and its address or none of them (a saved draft may hold a button half typed: the autosave
 * stores what is typed, piece 3b R-g). The database row (schema.ts NewsletterCampaign) has these fields and more.
 */
export type NewsletterCampaignDraft = {
  name: string;
  subject: I18n;
  preheader: I18n;
  imageKey: string | null;
  body: I18n;
  code: string | null;
  buttonLabel: I18n | null;
  buttonHref: string | null;
};

/**
 * Why a field is refused: nothing in it, more than its limit, something that is no value of its kind, or (`ruLabel`, on "buttonLabel.ru") a button with
 * a Russian text and no Russian label (the admin says „Lisa nupu tekst ka vene keeles.“).
 */
type FieldError = "required" | "tooLong" | "invalid" | "ruLabel";
type Errors = Record<string, FieldError>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A text as stored: what Postgres cannot hold is cleaned away (toStorable: control characters go, Word's line and page breaks become line breaks)
 * and the ends are trimmed. A body keeps its line breaks (Windows ones become "\n"; a blank line starts a paragraph); a one-line text (the name, the
 * subject, the preview line, the label) has none: a break or a tab becomes one space. Nothing is "" and anything but a text is null.
 */
function textOf(raw: unknown, oneLine: boolean): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const clean = toStorable(raw);
  return oneLine ? clean.replace(/[ \t]*[\r\n]+[ \t]*|\t/g, " ").trim() : clean.replace(/\r\n?/g, "\n").trim();
}

/** One text field: its cleaned text, with `errors[key]` set when it is missing (and required), over `max` or no text. */
function field(raw: unknown, key: string, max: number, required: boolean, oneLine: boolean, errors: Errors): string {
  const text = textOf(raw, oneLine);
  if (text === null) {
    errors[key] = "invalid";
    return "";
  }
  if (text === "" && required) errors[key] = "required";
  else if (text.length > max) errors[key] = "tooLong";
  return text;
}

/** A text in both languages as the form sends it, `{ et, ru }`; only the Estonian one can be required. Nothing sent is { et: "", ru: "" }. */
function bilingual(raw: unknown, key: string, max: number, required: boolean, oneLine: boolean, errors: Errors): { et: string; ru: string } {
  const sent = raw === undefined || raw === null ? {} : raw;
  if (!isObject(sent)) {
    errors[key] = "invalid";
    return { et: "", ru: "" };
  }
  return { et: field(sent.et, `${key}.et`, max, required, oneLine, errors), ru: field(sent.ru, `${key}.ru`, max, false, oneLine, errors) };
}

const UNSAFE_CHARS = /[\s\\<>"'`\u0000-\u001f\u007f]/;

/**
 * An address the button may open: an https:// address with a host (no user name or password in it) or a path of this site, which starts with one "/"
 * ("//host" is another site to a browser), at most CAMPAIGN_LIMITS.href long. Anything else (javascript:, data:, http:, mailto:, text) is refused.
 */
export function isCampaignHref(value: string): boolean {
  if (value === "" || value.length > CAMPAIGN_LIMITS.href || UNSAFE_CHARS.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  if (!/^https:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.includes(".") && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** What a check gives back: the texts cleaned (always, refused or not) and the refused fields by key ("subject.et", "buttonHref", …). */
type Checked = { value: NewsletterCampaignDraft; errors: Errors };

/**
 * The rules of one letter, for a save (`send` false) or for a send (`send` true; ruling R-g of piece 3b: the required texts are the sends' now).
 * - Every field's own rule, for both: a text no longer than its limit, the code in the welcome code's shape, the picture a key the site stores, the
 *   button's address an https:// address or a path of this site (isCampaignHref); the name is required for both (the list's line).
 * - The button's rule, for both, as before (ruling R2): any of its fields typed starts it, and then its Estonian label and its address are required,
 *   and its Russian label too when there is a Russian text. Each refusal falls on the field that breaks it.
 * - Required for a send only: the subject's and the text's Estonian (an empty draft, „Uus kiri +“, saves).
 * The value: for a send as stored for a mail (a button whole or null); for a save as typed (a label without its address is kept: the autosave stores
 * what she has typed so far, and the send refuses it).
 */
function check(raw: Record<string, unknown>, send: boolean): Checked {
  const errors: Errors = {};
  const L = CAMPAIGN_LIMITS;
  const name = field(raw.name, "name", L.name, true, true, errors);
  const subject = bilingual(raw.subject, "subject", L.subject, send, true, errors);
  const preheader = bilingual(raw.preheader, "preheader", L.preheader, false, true, errors);
  const body = bilingual(raw.body, "body", L.body, send, false, errors);
  const imageKey = field(raw.imageKey, "imageKey", L.href, false, true, errors);
  if (imageKey !== "" && !errors.imageKey && !isStorableImageKey(imageKey)) errors.imageKey = "invalid";

  let code = field(raw.code, "code", WELCOME_CODE_MAX, false, true, errors);
  if (!errors.code) {
    code = normalizeWelcomeCode(code);
    if (!isWelcomeCode(code)) errors.code = "invalid";
  }

  // the button: its Estonian label and its address together, or neither
  const label = bilingual(raw.buttonLabel, "buttonLabel", L.buttonLabel, false, true, errors);
  const href = field(raw.buttonHref, "buttonHref", L.href, false, false, errors);
  if (href !== "" && !errors.buttonHref && !isCampaignHref(href)) errors.buttonHref = "invalid";
  const labelTyped = label.et !== "" || label.ru !== "";
  const button = labelTyped || href !== "";
  if (button) {
    if (label.et === "" && !errors.buttonLabel && !errors["buttonLabel.et"]) errors["buttonLabel.et"] = "required";
    if (href === "" && !errors.buttonHref) errors.buttonHref = "required";
    if (href !== "" && body.ru !== "" && label.ru === "" && !errors.buttonLabel && !errors["buttonLabel.ru"]) errors["buttonLabel.ru"] = "ruLabel";
  }
  return {
    value: {
      name,
      subject,
      preheader,
      imageKey: imageKey === "" ? null : imageKey,
      body,
      code: code === "" ? null : code,
      buttonLabel: send ? (button ? label : null) : labelTyped ? label : null,
      buttonHref: send ? (button ? href : null) : href === "" ? null : href,
    },
    errors,
  };
}

const result = (c: Checked): { ok: true; value: NewsletterCampaignDraft } | { ok: false; fields: Record<string, string> } =>
  Object.keys(c.errors).length > 0 ? { ok: false, fields: c.errors } : { ok: true, value: c.value };

/**
 * A letter as it goes out, checked (the sends': „Saada proov“, „Saada kõigile“). `raw` is a `NewsletterCampaignDraft` as the form holds it (texts as
 * typed, an optional one empty, absent or null, a bilingual one `{ et, ru }`) or as stored. Required: `name`, `subject.et` and `body.et`; the button
 * whole (see `check`). The code is raised to capitals. Texts come back cleaned (see `textOf`) and trimmed; nothing is cut. A wrong field is named in
 * `fields` by its key ("name", "subject.et", "buttonLabel.ru", "buttonHref", …) with "required", "tooLong" or "invalid", or with "ruLabel" on
 * "buttonLabel.ru" (a button and a Russian text without the Russian label, ruling R2); anything but an object is `{ form: "invalid" }`. Keys it
 * does not know are left out.
 */
export function checkCampaignDraft(raw: unknown): { ok: true; value: NewsletterCampaignDraft } | { ok: false; fields: Record<string, string> } {
  if (!isObject(raw)) return { ok: false, fields: { form: "invalid" } };
  return result(check(raw, true));
}

/**
 * A letter as it is saved (ruling R-g): checkCampaignDraft's rules but for the required subject and text, and with a half-typed button kept. The
 * whole save (server/newsletter-campaigns.ts saveCampaign) takes it whole; the autosave of a field takes campaignSaveCheck.
 */
export function checkCampaignSave(raw: unknown): { ok: true; value: NewsletterCampaignDraft } | { ok: false; fields: Record<string, string> } {
  if (!isObject(raw)) return { ok: false, fields: { form: "invalid" } };
  return result(check(raw, false));
}

/** The editor's fields (the autosave's: one per form field, a bilingual one whole). */
export const CAMPAIGN_FIELDS = ["name", "subject", "preheader", "imageKey", "body", "code", "buttonLabel", "buttonHref"] as const;
export type CampaignField = (typeof CAMPAIGN_FIELDS)[number];

/** A check's keys as the editor's fields: "subject.et" is the field "subject" (a field's first code stands). */
export function campaignFieldCodes(fields: Record<string, string>): Partial<Record<CampaignField, string>> {
  const out: Partial<Record<CampaignField, string>> = {};
  for (const [key, code] of Object.entries(fields)) {
    const name = key.split(".")[0] as CampaignField;
    if ((CAMPAIGN_FIELDS as readonly string[]).includes(name) && !(name in out)) out[name] = code;
  }
  return out;
}

/**
 * The save's rules over the letter's fields as they stand (the editor's, or the stored ones with a patch over them): the cleaned value, and the
 * refused fields by the editor's field name. One rule for the browser (useAutosave's `validate`: a refused field is held back) and the server (the
 * autosave route refuses the fields of the patch it names): never a hand copy.
 */
export function campaignSaveCheck(fields: Record<string, unknown>): { value: NewsletterCampaignDraft; codes: Partial<Record<CampaignField, string>> } {
  const c = check(fields, false);
  return { value: c.value, codes: campaignFieldCodes(c.errors) };
}

const blank = (text: string | undefined): boolean => text === undefined || text.trim() === "";

/**
 * Does the Russian mail fall back to the Estonian one (Review Focus 5)? Yes when the Russian subject or the Russian text is empty: Maria is told
 * before sending („Vene keeles tellijad saavad eestikeelse kirja.“). The preview line and the button's label are optional and do not decide it.
 */
export const ruFallsBack = (c: NewsletterCampaignDraft): boolean => blank(c.subject.ru) || blank(c.body.ru);

/** What a subscriber reads: the texts of one language, the body in paragraphs. `locale` is the language the texts are in. */
export type CampaignContent = { locale: "et" | "ru"; subject: string; preheader: string; paragraphs: string[]; buttonLabel: string | null };

/**
 * The text of a campaign for a subscriber of `locale`: the Estonian one for an Estonian subscriber, the Russian one for a Russian subscriber, and the
 * Estonian one as a whole for her when the Russian subject or text is empty (ruFallsBack): never a mix, so the returned `locale` says which text was
 * used (the footer follows the subscriber's own language, not this one). In the Russian mail an empty Russian preview line is no line, and an empty
 * Russian label leaves the mail without a button; no Estonian text is borrowed for them. (checkCampaignDraft refuses a button with a Russian text and no
 * Russian label, so only a row stored before that rule can lack one.)
 */
export function campaignContentFor(c: NewsletterCampaignDraft, locale: "et" | "ru"): CampaignContent {
  const used: "et" | "ru" = locale === "ru" && !ruFallsBack(c) ? "ru" : "et";
  const text = (f: I18n | null): string => (f ? ((used === "ru" ? f.ru : f.et) ?? "").trim() : "");
  const buttonLabel = text(c.buttonLabel);
  return { locale: used, subject: text(c.subject), preheader: text(c.preheader), paragraphs: paragraphs(text(c.body)), buttonLabel: buttonLabel === "" ? null : buttonLabel };
}
