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
 * A campaign as Maria writes it, checked: every optional text is "" (an `I18n` always holds both languages) or null, the code is in capitals, and a
 * button has all of its label (Estonian) and its address or none of them. The database row (schema.ts NewsletterCampaign) has these fields and more.
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

/**
 * The editor's form, checked. `raw` is a `NewsletterCampaignDraft` as the form holds it: texts as typed, an optional one empty, absent or null, a bilingual one
 * `{ et, ru }`. Required: `name`, `subject.et` and `body.et`. The code is raised to capitals and must have the welcome code's shape
 * (domain/welcome-code.ts); the button needs both its Estonian label and its address (any of its fields typed starts it), and the address is an
 * https:// address or a path of this site (isCampaignHref); a button (its address set) with a Russian text (`body.ru`) needs its Russian label too, so that it never
 * drops out of the Russian mail. The picture's key must be one the site stores (lib/media.ts isStorableImageKey: an upload or a /seed/ picture, never an
 * address of another site). Texts come back cleaned (see `textOf`) and trimmed; nothing is cut.
 * A wrong field is named in `fields` by its key ("name", "subject.et", "buttonLabel.ru", "buttonHref", …) with "required", "tooLong" or "invalid",
 * or with "ruLabel" on "buttonLabel.ru" (a button and a Russian text without the Russian label, ruling R2); anything but an object is
 * `{ form: "invalid" }`. Keys it does not know are left out.
 */
export function checkCampaignDraft(raw: unknown): { ok: true; value: NewsletterCampaignDraft } | { ok: false; fields: Record<string, string> } {
  if (!isObject(raw)) return { ok: false, fields: { form: "invalid" } };
  const errors: Errors = {};
  const L = CAMPAIGN_LIMITS;
  const name = field(raw.name, "name", L.name, true, true, errors);
  const subject = bilingual(raw.subject, "subject", L.subject, true, true, errors);
  const preheader = bilingual(raw.preheader, "preheader", L.preheader, false, true, errors);
  const body = bilingual(raw.body, "body", L.body, true, false, errors);
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
  const button = label.et !== "" || label.ru !== "" || href !== "";
  if (button) {
    if (label.et === "" && !errors.buttonLabel && !errors["buttonLabel.et"]) errors["buttonLabel.et"] = "required";
    if (href === "" && !errors.buttonHref) errors.buttonHref = "required";
    if (href !== "" && body.ru !== "" && label.ru === "" && !errors.buttonLabel && !errors["buttonLabel.ru"]) errors["buttonLabel.ru"] = "ruLabel";
  }

  if (Object.keys(errors).length > 0) return { ok: false, fields: errors };
  return {
    ok: true,
    value: {
      name,
      subject,
      preheader,
      imageKey: imageKey === "" ? null : imageKey,
      body,
      code: code === "" ? null : code,
      buttonLabel: button ? label : null,
      buttonHref: button ? href : null,
    },
  };
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
