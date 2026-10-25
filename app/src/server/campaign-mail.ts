import { isCampaignHref, type CampaignContent } from "@/domain/newsletter-campaign";
import { href } from "@/i18n/href";
import { getDict, type Locale } from "@/i18n/locales";
import { FONT, INK, LINE, buttonRow, codeRow, esc, linkRow, mailCard, paragraphRow, row, textStyle } from "./account-mail";

// The newsletter campaign's mail (newsletter campaigns, Task 1; spec D5, D6): the account mails' card (account-mail.ts mailCard) with the school's
// logo on top, Maria's picture at the full width of the card, her paragraphs, the code in its lilac box, the one button, and a footer: why the
// subscriber got the mail, the way out, the school's name and address. One text for all, so no greeting and no signature. A hidden first line (the
// preheader) is what the inbox shows after the subject. HTML with a plain-text fallback made from the same parts; both are the body of an ordinary
// mail: a subscriber's own, or the test mail's.
//
// - Every text of Maria's is escaped (esc): the subject, the preview line, the paragraphs, the code, the label, the school's name and address.
// - The unsubscribe address is placed as it is given (`unsubscribeHref`): in a send it is the subscriber's own link (the site's unsubscribe page with her
//   token), in a test the test page, and it must reach the HTML as written. Only what could end the attribute or open a tag is escaped.
// - The footer follows the subscriber's language (`pageLocale`), the text follows the campaign's (`content.locale`): a Russian subscriber whose
//   campaign has no Russian text gets the Estonian text under a Russian footer, with the Russian unsubscribe page behind its link (Review Focus 5).

/** The test mail's subject starts with this: Maria reads it, whatever the language of the text (spec D6). */
export const TEST_SUBJECT_PREFIX = "[Proov] ";

/** The school's name when Seaded → „Maksmine“ has none. */
const SCHOOL_FALLBACK = "MS LAB";

/** The card's inner width: the account mails' card is 480 px wide (account-mail.ts mailCard) with a 1 px border on each side. Outlook reads the picture's width attribute, so it must not be wider. */
const CARD_INNER = 478;

/** The footer's quiet colour: the site's --muted (src/styles/tokens.css) on the card's white, with its mix worked out (an e-mail has no color-mix). */
const MUTED = "#5d5358";

export type CampaignMailInput = {
  /** The texts of one language (domain/newsletter-campaign.ts campaignContentFor); its `locale` is the language they are in. */
  content: CampaignContent;
  /** The subscriber's language: the footer's, and the language of the site's pages the button opens. */
  pageLocale: Locale;
  /** The picture as an absolute address (siteUrl + lib/media.ts mediaUrl of its key), or null for none. */
  imageUrl: string | null;
  /** The code shown in the box (already in capitals), or null for none. */
  code: string | null;
  /** The button's address as stored: an https:// address or a path of the site without the language; it opens only with `content.buttonLabel`. */
  buttonHref: string | null;
  /** The site's address, no path (site.ts linkBase): the logo and the site paths of the button hang on it. */
  siteUrl: string;
  /** From Seaded → „Maksmine“: the caller passes "MS LAB" and an empty address when there are none. */
  school: { name: string; address: string };
  /** The unsubscribe link's address, as it must appear in href (the subscriber's own link for a send, the site's test page for a test). */
  unsubscribeHref: string;
  /** A test mail („Saada proov“): the subject starts with „[Proov]“. */
  test: boolean;
};

/** The hidden first line: not shown, but the first text a mail program finds; padded so that it does not pull the paragraphs in after it. */
const PREHEADER_PAD = "&zwnj;&nbsp;".repeat(60);
const preheaderBlock = (text: string): string =>
  text === ""
    ? ""
    : `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;">${esc(text)}${PREHEADER_PAD}</div>`;

/** The address of the button for a subscriber of `pageLocale`: a site path gets her language in front (once), an https address stays; null for anything else. */
function buttonUrl(value: string | null, siteUrl: string, pageLocale: Locale): string | null {
  if (value === null || !isCampaignHref(value)) return null;
  if (!value.startsWith("/")) return value;
  const bare = value.replace(/^\/(?:ru|et)(?=$|[/?#])/i, "");
  return `${siteUrl}${href(pageLocale, bare === "" || /^[?#]/.test(bare) ? `/${bare}` : bare)}`;
}

/** The attribute value of the unsubscribe link: as given, but for what could end the attribute or open a tag. */
const attribute = (value: string): string => value.replace(/["<>]/g, (c) => (c === '"' ? "&quot;" : c === "<" ? "&lt;" : "&gt;"));

/**
 * The campaign mail for one subscriber: its subject (with „[Proov] “ in front for a test), the HTML and the plain text. Pure; the caller sends it
 * (as an ordinary mail: its `subject`, `html` and `text`).
 */
export function campaignMail(input: CampaignMailInput): { subject: string; html: string; text: string } {
  const { content } = input;
  const siteUrl = input.siteUrl.replace(/\/+$/, "");
  const footer = getDict(input.pageLocale).mail.campaign;
  const subject = `${input.test ? TEST_SUBJECT_PREFIX : ""}${content.subject}`;
  const schoolName = input.school.name.trim() || SCHOOL_FALLBACK;
  const schoolAddress = input.school.address.trim();
  const button = content.buttonLabel ? buttonUrl(input.buttonHref, siteUrl, input.pageLocale) : null;

  const rows = [
    // the logo, with the hidden first line ahead of it
    row("padding:28px 28px 0;text-align:center;", `${preheaderBlock(content.preheader)}<img src="${esc(siteUrl)}/brand/logo.png" alt="MS LAB" width="130" height="50" style="display:inline-block;width:130px;height:auto;border:0;">`),
    ...(input.imageUrl ? [row("padding:20px 0 0;", `<img src="${esc(input.imageUrl)}" alt="${esc(content.subject)}" width="${CARD_INNER}" style="display:block;width:100%;max-width:${CARD_INNER}px;height:auto;border:0;">`)] : []),
    ...content.paragraphs.map((p, i) => paragraphRow(p, i === 0 ? 24 : 16)),
    ...(input.code ? [codeRow(input.code)] : []),
    ...(button && content.buttonLabel ? [buttonRow(button, content.buttonLabel), linkRow(button)] : []),
    // the footer: a line, why she got the mail, the way out, the school
    row("padding:32px 28px 0;", `<div style="border-top:1px solid ${LINE};font-size:1px;line-height:1px;">&nbsp;</div>`),
    row(`padding:16px 28px 0;${textStyle(12, `color:${MUTED};`)}`, esc(footer.reason)),
    row(`padding:8px 28px 0;${textStyle(12, `color:${MUTED};`)}`, `<a href="${attribute(input.unsubscribeHref)}" style="color:${INK};text-decoration:underline;">${esc(footer.unsubscribe)}</a>`),
    row(`padding:16px 28px ${schoolAddress ? 0 : 32}px;font:600 12px/1.5 ${FONT};color:${MUTED};`, esc(schoolName)),
    ...(schoolAddress ? [row(`padding:0 28px 32px;${textStyle(12, `color:${MUTED};`)}`, esc(schoolAddress))] : []),
  ];

  const text = [
    ...content.paragraphs.flatMap((p) => [p, ""]),
    ...(input.code ? [input.code, ""] : []),
    ...(button && content.buttonLabel ? [`${content.buttonLabel}: ${button}`, ""] : []),
    footer.reason,
    `${footer.unsubscribe}: ${input.unsubscribeHref}`,
    "",
    schoolName,
    ...(schoolAddress ? [schoolAddress] : []),
  ].join("\n");

  return { subject, html: mailCard(subject, content.locale, rows), text };
}
