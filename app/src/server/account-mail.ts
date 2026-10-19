import type { Contract, Invoice } from "@/db/schema";
import { firstName, groupIban, hasPrepayment, paymentReference, type PrepaymentInfo } from "@/domain/account-cards";
import { contractFileName } from "@/domain/contract";
import { euro, invoiceFileName } from "@/domain/invoice";
import { formatEUR } from "@/domain/money";
import { prepaymentDue } from "@/domain/registration";
import { pick, type I18n } from "@/i18n/field";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { href } from "@/i18n/href";
import { getDict, type Locale } from "@/i18n/locales";
import type { Mail, MailAttachment } from "./notify";

// The client account's login e-mail: a big 6-digit code and one "Logi sisse" button, both valid 30 minutes
// (server/client-auth.ts LOGIN_TTL_MS). The texts are `account.mail` in the dictionaries, and the e-mail has two bodies made
// from the same parts: HTML (the code large, the button) and, as the fallback for clients that show no HTML, plain text.
// The subject carries the code, so a phone shows it in the notification.
// The deletion e-mail (deletionMail) is the same card with two lines of text and no button.
// The confirmation e-mails to a visitor who registered or sent a request (registrationConfirmationMail,
// requestConfirmationMail) are the same card again: what was received, the next step and one button, "Ava minu konto" or,
// when the visitor ticked "Loo mulle kohe konto", the live login code with "Logi sisse" in its place.
// After an online payment (phase 2b) the same card says what was paid (registrationPaidMail) or that an e-course is open (ecourseOpenMail).
// The e-course completion (completionMail) uses the protocol mail's card without a login: one line, the course, one button to the page.
// Maria's invoice (invoiceMail, invoices Task 5) is the same card again: the course, the amount, the due date and the bank details, the PDF attached.
// The contract (contractMail, contracts Task 4, ruling R1) is the same card: the day she accepted it, the contract and its course, the PDF attached
// with „Leping on lisatud.“; the registration's confirmation and the e-course's paid mail carry the same line when their caller attaches the PDF.
// Maria's ask (contractRequestMail, contracts Task 5, ruling R9) is a short mail with a plain link to the account page, no login in it.
// This module imports the contracts' types only (contracts.ts imports it, through completion.ts too).

/**
 * The link in the login e-mail: it signs in the device that opens it (api/konto verify). `pageLocale` is the language of
 * the login page: "ru" adds `&l=ru` (a new account is Russian, a failed link opens the Russian login page); Estonian adds
 * nothing, as before. `protocolId` (the protocol mail, phase protocols) adds `&p=<registration>`: after the login the link
 * opens that protocol instead of Minu koolitused.
 */
export const verifyLink = (siteUrl: string, token: string, pageLocale: Locale = "et", protocolId?: number): string =>
  `${siteUrl.replace(/\/+$/, "")}/api/konto/verify?t=${encodeURIComponent(token)}${pageLocale === "ru" ? "&l=ru" : ""}${protocolId === undefined ? "" : `&p=${protocolId}`}`;

/**
 * "Ava minu konto": the login page of `locale` with the address filled in (components/account/login-address.ts reads it once).
 * The address is in the FRAGMENT, never a query: a fragment does not reach any server or cache, and an account page with a
 * query is refused by the middleware. encodeURIComponent is needed: a raw "+" in a fragment would be read back as a space.
 * `enterCode` adds `&kood=1`: the page then opens at the code step for that address, without sending a code (the confirmation
 * e-mail that carries a code links there).
 */
export const accountLink = (siteUrl: string, email: string, locale: Locale = "et", enterCode = false): string =>
  `${siteUrl.replace(/\/+$/, "")}${href(locale, "/konto/sisene")}#email=${encodeURIComponent(email)}${enterCode ? "&kood=1" : ""}`;

/** The "Maksa" link of a registration (phase 2b, spec 6.3): its own page, /maksa/<pay_token>, which shows the amount and starts the payment with a button. */
export const payLinkUrl = (siteUrl: string, payToken: string): string => `${siteUrl.replace(/\/+$/, "")}/maksa/${encodeURIComponent(payToken)}`;

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text for an HTML body or attribute: nothing a value holds can open a tag or end an attribute. */
export const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/**
 * The site's colours (src/styles/tokens.css: --ink, --paper, --canvas, --line, --lilac); an e-mail has no CSS variables. The ink, the line and the
 * font are exported with the card's rows for the campaign mail (server/campaign-mail.ts), which builds its own rows on the same card.
 */
export const INK = "#222222";
const PAPER = "#ffffff";
const CANVAS = "#f6f4f5";
export const LINE = "#e6e1e3";
const LILAC = "#e8e0e5";
/** The site's fonts where installed (an e-mail cannot load web fonts), else the client's own. */
export const FONT = "Jost, Manrope, Arial, sans-serif";

/** The texts of the login e-mail (`account.mail`). */
type MailTexts = ReturnType<typeof getDict>["account"]["mail"];

/** The plain-text body: the same parts, one per line. */
function loginText(mail: MailTexts, code: string, link: string): string {
  return [
    mail.greeting, "",
    mail.codeIntro, "",
    code, "",
    `${mail.useCode} ${mail.orLink}`,
    link, "",
    mail.valid,
    mail.ignore, "",
    mail.signature,
  ].join("\n");
}

export const textStyle = (size: number, extra = "") => `font:400 ${size}px/1.5 ${FONT};color:${INK};${extra}`;
/** One row of the card: a `td` with `style` holding `content`, which the caller has escaped. */
export const row = (style: string, content: string) => `<tr><td style="${style}">${content}</td></tr>`;
const greetingRow = (greeting: string) => row(`padding:32px 28px 0;font:600 22px/1.3 ${FONT};color:${INK};`, esc(greeting));
const signatureRow = (mail: MailTexts) => row(`padding:24px 28px 32px;${textStyle(14)}`, esc(mail.signature));

/** A paragraph of 16 px text. */
export const paragraphRow = (text: string, top = 16) => row(`padding:${top}px 28px 0;${textStyle(16)}`, esc(text));

/** The code large on its own line, in the lilac box of the site's newsletter surface; the whole code is selected by one tap. */
export const codeRow = (code: string) =>
  row("padding:12px 28px 0;", `<div style="background:${LILAC};border-radius:12px;padding:16px 0 16px 8px;text-align:center;font:600 32px/1.2 ${FONT};letter-spacing:8px;color:${INK};-webkit-user-select:all;user-select:all;">${esc(code)}</div>`);

/** The one button of an e-mail: an ink pill (the site's primary button), 48 px tall, with Outlook's own padding. */
export const buttonRow = (link: string, label: string) =>
  row(
    "padding:16px 28px 0;",
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" height="48" bgcolor="${INK}" style="background:${INK};border-radius:99px;mso-padding-alt:0 32px;">` +
      `<a href="${esc(link)}" style="display:inline-block;padding:0 32px;height:48px;line-height:48px;font:600 16px/48px ${FONT};color:${PAPER};text-decoration:none;border-radius:99px;">${esc(label)}</a>` +
      "</td></tr></table>",
  );

/** The link written out small below the button, for clients that do not show buttons. */
export const linkRow = (link: string) =>
  row(`padding:12px 28px 0;text-align:center;${textStyle(12, "word-break:break-all;")}`, `<a href="${esc(link)}" style="color:${INK};text-decoration:underline;">${esc(link)}</a>`);

/**
 * The HTML document of an e-mail: a centred card (a 480 px table on the site's canvas colour) holding `rows`. Tables and inline
 * styles only: no external CSS, no web fonts, and no images in the account's own mails (the campaign mail's rows hold the logo and a
 * picture). `subject` is the title, `rows` are built with `row` and escape their own values.
 */
export function mailCard(subject: string, locale: Locale, rows: string[]): string {
  return [
    "<!doctype html>",
    `<html lang="${esc(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:${CANVAS};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;background:${PAPER};border:1px solid ${LINE};border-radius:20px;">`,
    ...rows,
    "</table></td></tr></table></body></html>",
  ].join("");
}

/**
 * The login e-mail's HTML body: the code large on its own line, one button (an ink pill, the site's primary button, at least
 * 44 px tall) and the link written out small below it for clients that do not show buttons. Every value is escaped.
 */
function loginHtml(mail: MailTexts, subject: string, locale: Locale, code: string, link: string): string {
  return mailCard(subject, locale, [
    greetingRow(mail.greeting),
    paragraphRow(mail.codeIntro),
    codeRow(code),
    paragraphRow(mail.useCode),
    paragraphRow(mail.orLink, 12),
    buttonRow(link, mail.button),
    linkRow(link),
    row(`padding:24px 28px 0;${textStyle(14)}`, esc(mail.valid)),
    row(`padding:4px 28px 0;${textStyle(14)}`, esc(mail.ignore)),
    signatureRow(mail),
  ]);
}

/**
 * The login e-mail for `email`, in `locale`: HTML with a plain-text fallback. `siteUrl` is the base of the link (site.ts
 * linkBase), `pageLocale` the language of the login page, carried by the link (verifyLink); it can differ from `locale`,
 * which is the account's own language when the address has one.
 */
export function loginMail(siteUrl: string, email: string, token: string, code: string, locale: Locale, pageLocale: Locale = "et"): Mail {
  const mail = getDict(locale).account.mail;
  const link = verifyLink(siteUrl, token, pageLocale);
  const subject = fill(mail.subject, { code });
  return { to: email, subject, text: loginText(mail, code, link), html: loginHtml(mail, subject, locale, code, link) };
}

/**
 * The e-mail that confirms an account deletion: the account is gone and the registrations stay with Maria. Plain text and a
 * plain HTML body (the same lines, no button). The caller never sends it to a sample address or in development.
 */
export function deletionMail(email: string, locale: Locale): Mail {
  const dict = getDict(locale).account;
  const subject = dict.deleted.subject;
  const text = [dict.mail.greeting, "", dict.deleted.line, dict.deleted.kept, "", dict.mail.signature].join("\n");
  const html = mailCard(subject, locale, [
    greetingRow(dict.mail.greeting),
    paragraphRow(dict.deleted.line),
    paragraphRow(dict.deleted.kept, 8),
    signatureRow(dict.mail),
  ]);
  return { to: email, subject, text, html };
}

/**
 * The mail after the account's password was set, changed or removed (phase 2c): the line, and whom to write to if it was not her
 * (`contactEmail`, Seaded's contact address; "" for none). Plain text and a plain HTML body, no button. The caller never sends it to
 * a sample address or in development.
 */
export function passwordChangedMail(email: string, locale: Locale, contactEmail: string): Mail {
  const dict = getDict(locale).account;
  const p = dict.passwordMail;
  const notYou = contactEmail ? fill(p.notYouAt, { email: contactEmail }) : p.notYou;
  const text = [dict.mail.greeting, "", p.line, notYou, "", dict.mail.signature].join("\n");
  const html = mailCard(p.subject, locale, [greetingRow(dict.mail.greeting), paragraphRow(p.line), paragraphRow(notYou, 8), signatureRow(dict.mail)]);
  return { to: email, subject: p.subject, text, html };
}

/**
 * The welcome mail to a newly subscribed address (one step since 09.10; server/newsletter.ts sendWelcome): the greeting and a line of thanks,
 * then, only when Seaded has a "Tervituskood" (`code`; null for none), the code large (the login code's lilac box) and how to use it, and as
 * the last line before the signature the way out: "loobu siit" with `unsubscribeLink`, the subscriber's own link (newsletter.ts
 * unsubscribeUrl). No button. Plain text and HTML. The caller never sends it to a sample address or in development.
 */
export function welcomeMail(email: string, code: string | null, locale: Locale, unsubscribeLink: string): Mail {
  const w = getDict(locale).mail.welcome;
  const mail = getDict(locale).account.mail;
  const [before, after = ""] = w.unsubscribe.split("{link}");
  const text = [
    mail.greeting, "", w.intro, "",
    ...(code ? [w.codeIntro, "", code, "", w.use, w.invoice, ""] : []),
    fill(w.unsubscribe, { link: unsubscribeLink }), "",
    mail.signature,
  ].join("\n");
  const html = mailCard(w.subject, locale, [
    greetingRow(mail.greeting),
    paragraphRow(w.intro),
    ...(code ? [paragraphRow(w.codeIntro), codeRow(code), paragraphRow(w.use), paragraphRow(w.invoice, 8)] : []),
    row(`padding:24px 28px 0;${textStyle(14)}`, `${esc(before)}<a href="${esc(unsubscribeLink)}" style="color:${INK};text-decoration:underline;word-break:break-all;">${esc(unsubscribeLink)}</a>${esc(after)}`),
    signatureRow(mail),
  ]);
  return { to: email, subject: w.subject, text, html };
}

// ---------- confirmation e-mails to a visitor ----------

/** A live login (server/client-auth.ts issueClientLogin) a confirmation e-mail may carry: the link token and the 6-digit code. */
export type LoginCode = { token: string; code: string };

/** A session of a course: when and where (the time is Estonian time, whatever the server's own). */
export type SessionInfo = { startsAt: Date; city: string; venue: string };

/** What the layout shows, in the order of the page: the lead, the course box, then paragraphs, rows of fields and (phase 2b) a pay button. */
type Section = { text: string } | { fields: [label: string, value: string][] } | { button: { href: string; label: string } };
type Confirmation = {
  email: string;
  name: string;
  locale: Locale;
  siteUrl: string;
  subject: string;
  /** "Registreering on vastu võetud." */
  lead: string;
  /** The course (or the practice package) in bold, and under it when and where. */
  box: { title: string; lines: string[] };
  sections: Section[];
  login: LoginCode | null;
  /**
   * The login follows a purchase she has just paid for (ecourseOpenMail): the mail leaves out "Kui sa ei palunud sisselogimist, võid selle kirja
   * kustutada.", which could make a buyer delete her access mail. Every other mail with a code keeps it.
   */
  afterPurchase?: boolean;
  /**
   * The mail goes to someone who has no account here (the invoice's copy for „Saada ka aadressile“, the final review's m9): no „Ava minu konto“,
   * neither the button nor its line. Without a login only.
   */
  noAccount?: boolean;
};

/** The first line of the e-mail: "Tere, Kati!", or just "Tere!" when the name has no word. */
function hello(dict: ReturnType<typeof getDict>["account"]["dashboard"], name: string): string {
  const first = firstName(name);
  return first ? fill(dict.hello, { name: first }) : dict.helloNoName;
}

/** The date, time and place of a session as the account's cards say them: "14.11.2026 · 10:00" and "Pärnu, MS LAB stuudio". */
function sessionLines(s: SessionInfo, locale: Locale): string[] {
  return [`${formatDate(s.startsAt, locale)} · ${formatTime(s.startsAt, locale)}`, [s.city, s.venue].filter(Boolean).join(", ")].filter(Boolean);
}

/** A subject is one line, whatever the course's title holds (a non-breaking space stays one). */
const oneLine = (s: string): string => s.replace(/[^\S\u00a0]+/g, " ").trim();

/**
 * The two addresses a confirmation can link to: `main` is what the one button opens (the login with a code, else the login page
 * with the address filled in), `code` the login page at its code step (only with a code: the small link under the 30 minutes).
 */
type Links = { main: string; code: string };

/** The plain-text body: the same parts as the HTML, one block each. */
function confirmationText(c: Confirmation, greeting: string, mail: MailTexts, links: Links): string {
  const lines = [greeting, "", c.lead, "", c.box.title, ...c.box.lines, ""];
  for (const section of c.sections) {
    if ("text" in section) lines.push(section.text, "");
    else if ("button" in section) lines.push(`${section.button.label}: ${section.button.href}`, "");
    else lines.push(...section.fields.map(([label, value]) => `${label}: ${value}`), "");
  }
  if (c.login) lines.push(mail.codeIntro, "", c.login.code, "", `${mail.button}:`, links.main, "", mail.valid, ...(c.afterPurchase ? [] : [mail.ignore]), "", mail.confirm.codeHere, links.code, "");
  else if (!c.noAccount) lines.push(`${mail.confirm.open}:`, links.main, "");
  lines.push(mail.signature);
  return lines.join("\n");
}

/** A soft box on the card (the site's canvas colour, a thin line), as the code's box but quieter. */
const boxRow = (inner: string, top: number) =>
  row(`padding:${top}px 28px 0;`, `<div style="background:${CANVAS};border:1px solid ${LINE};border-radius:12px;padding:14px 16px;${textStyle(16)}">${inner}</div>`);

function confirmationHtml(c: Confirmation, greeting: string, mail: MailTexts, links: Links): string {
  const rows = [
    greetingRow(greeting),
    paragraphRow(c.lead),
    boxRow(
      `<div style="font:600 18px/1.4 ${FONT};color:${INK};">${esc(c.box.title)}</div>` + c.box.lines.map((line) => `<div>${esc(line)}</div>`).join(""),
      12,
    ),
  ];
  for (const section of c.sections) {
    if ("text" in section) rows.push(paragraphRow(section.text));
    else if ("button" in section) rows.push(buttonRow(section.button.href, section.button.label));
    else
      rows.push(
        boxRow(
          section.fields
            .map(
              ([label, value], i) =>
                `<div style="${textStyle(13, i ? "padding-top:8px;" : "")}">${esc(label)}</div><div style="font:600 16px/1.4 ${FONT};color:${INK};word-break:break-word;">${esc(value)}</div>`,
            )
            .join(""),
          12,
        ),
      );
  }
  // One button: "Ava minu konto", or with a live login the code and "Logi sisse" (and the link written out, as in the login e-mail),
  // the 30 minutes, the ignore line, and a small text link (no button) to type the code on the login page if the button fails. When the
  // mail has a pay button (phase 2b), "Ava minu konto" is a text link under it: the mail keeps one primary button.
  const payButton = c.sections.some((s) => "button" in s);
  if (c.login)
    rows.push(
      paragraphRow(mail.codeIntro, 24),
      codeRow(c.login.code),
      buttonRow(links.main, mail.button),
      linkRow(links.main),
      row(`padding:24px 28px 0;${textStyle(14)}`, esc(mail.valid)),
      ...(c.afterPurchase ? [] : [row(`padding:4px 28px 0;${textStyle(14)}`, esc(mail.ignore))]),
      row(`padding:12px 28px 0;${textStyle(14)}`, `${esc(mail.confirm.codeHere)} <a href="${esc(links.code)}" style="color:${INK};text-decoration:underline;">${esc(mail.confirm.codeLink)}</a>`),
    );
  else if (c.noAccount) {
    // (no link to an account: the mail's reader has none here)
  } else if (payButton) rows.push(row(`padding:20px 28px 0;text-align:center;${textStyle(14)}`, `<a href="${esc(links.main)}" style="color:${INK};text-decoration:underline;">${esc(mail.confirm.open)}</a>`));
  else rows.push(buttonRow(links.main, mail.confirm.open));
  rows.push(signatureRow(mail));
  return mailCard(c.subject, c.locale, rows);
}

/** The e-mail of a confirmation: HTML with the plain-text fallback. The button's link is the login (with a code) or the login page. */
function confirmationMail(c: Confirmation): Mail {
  const dict = getDict(c.locale).account;
  const greeting = hello(dict.dashboard, c.name);
  const links: Links = {
    main: c.login ? verifyLink(c.siteUrl, c.login.token, c.locale) : accountLink(c.siteUrl, c.email, c.locale),
    code: accountLink(c.siteUrl, c.email, c.locale, true),
  };
  return { to: c.email, subject: c.subject, text: confirmationText(c, greeting, dict.mail, links), html: confirmationHtml(c, greeting, dict.mail, links) };
}

export type RegistrationConfirmationInput = {
  siteUrl: string;
  /** The visitor's address, as stored (trimmed, lower case). */
  email: string;
  name: string;
  locale: Locale;
  registrationId: number;
  course: I18n;
  session: SessionInfo;
  paymentChoice: "full" | "half";
  /** What the registration is measured against (domain/registration.ts registrationPrice), cents; null when the course has no such price. */
  priceCents: number | null;
  /** The admin's prepayment setting (domain/account-cards.ts parsePrepayment); without a receiver and an IBAN Maria sends an invoice. */
  prepayment: PrepaymentInfo | null;
  /** The registration's "Maksa" link (payLinkUrl) when online payments are on (phase 2b); null or absent: today's mail. */
  payLink?: string | null;
  /** A live login for the address, when the visitor ticked "Loo mulle kohe konto" and one could be issued. */
  login: LoginCode | null;
  /** The registration's contract goes with the mail as a PDF (contracts, spec §4, D7): the line „Leping on lisatud.“. */
  contractAttached?: boolean;
};

/**
 * The confirmation of a group registration: what was received, the course and its date and place, the next step (the
 * prepayment amount with "Maksa {summa}" when online payments are on, and where to pay it by transfer, or "Maria saadab sulle arve …")
 * and one button. The next-step sentence is the dashboard card's (`account.next.pay` / `invoice`, domain/account-cards.ts nextStep), the
 * payment rows are the card's own (components/account/PrepaymentInfo.tsx), and "Koht kinnitatakse …" is the registration form's. „Leping on
 * lisatud.“ closes it when the caller attaches the contract (submit.ts).
 */
export function registrationConfirmationMail(input: RegistrationConfirmationInput): Mail {
  const dict = getDict(input.locale);
  const mail = dict.account.mail;
  const title = pick(input.course, input.locale);
  const due = input.priceCents === null ? 0 : prepaymentDue(input.priceCents, input.paymentChoice);
  const transfer = hasPrepayment(input.prepayment) && due > 0 ? input.prepayment : null;
  const sections: Section[] = [];
  const amount = formatEUR(due, input.locale);
  const transferRows = (pay: PrepaymentInfo): Section => {
    const labels = dict.account.dashboard.payment;
    return {
      fields: ([
        [labels.receiver, pay.receiver],
        [labels.iban, groupIban(pay.iban)],
        [labels.bank, pay.bank],
        [labels.amount, amount],
        [labels.reference, paymentReference(pay, input.registrationId)],
      ] as [string, string][]).filter(([, value]) => value.trim() !== ""),
    };
  };
  if (input.payLink && due > 0) {
    // phase 2b (spec 6.1.4): "Maksa {summa}" first, the bank transfer as the second way under it (D6)
    sections.push({ text: fill(dict.account.next.pay, { amount }) }, { button: { href: input.payLink, label: fill(dict.payment.pay, { amount }) } });
    if (transfer) sections.push({ text: dict.payment.transfer }, transferRows(transfer));
  } else if (transfer) {
    sections.push({ text: fill(dict.account.next.pay, { amount }) }, transferRows(transfer));
  } else {
    sections.push({ text: dict.account.next.invoice });
  }
  sections.push({ text: dict.course.confirmAfterPrepayment });
  if (input.contractAttached) sections.push({ text: dict.account.contractMail.attached });
  return confirmationMail({
    email: input.email,
    name: input.name,
    locale: input.locale,
    siteUrl: input.siteUrl,
    subject: oneLine(fill(mail.confirm.subjectRegistration, { title })),
    lead: mail.confirm.registration,
    box: { title, lines: sessionLines(input.session, input.locale) },
    sections,
    login: input.login,
  });
}

export type RegistrationPaidInput = {
  siteUrl: string;
  email: string;
  name: string;
  locale: Locale;
  course: I18n;
  session: SessionInfo | null;
  /** This payment, cents. */
  paidCents: number;
  /** What is left to pay on the registration after it (its price − its paidCents), cents. */
  restCents: number;
  /** The registration is confirmed now. */
  confirmed: boolean;
  /** Paid, but the course was full: the place stayed unconfirmed (D2). */
  full: boolean;
  /** The payment's invoice goes with the mail as a PDF (invoices, spec §4): the line „Arve on lisatud.". */
  invoiceAttached?: boolean;
};

/**
 * The mail after an online payment of a registration (phase 2b, spec 6.2.4): "Koht on kinnitatud — {title}" when the place is confirmed now,
 * else "Makse on kätte saadud — {title}"; the course with its date and place, what was paid, and what is left ("Ülejäänud {amount} tasud
 * koolituspäeval või Minu koolitused lehel.") or "Kogu summa on tasutud."; a place left unconfirmed says why; „Arve on lisatud." when the
 * payment's invoice is attached (settle.ts attaches it). One button: "Ava minu konto".
 * settle.ts never sends it to a sample address and does not count it in the daily caps (it follows a real payment).
 */
export function registrationPaidMail(input: RegistrationPaidInput): Mail {
  const m = getDict(input.locale).payment.mail;
  const title = pick(input.course, input.locale);
  const sections: Section[] = [{ fields: [[m.paid, formatEUR(input.paidCents, input.locale)]] }];
  if (input.full) sections.push({ text: m.full });
  else if (!input.confirmed) sections.push({ text: m.notConfirmed });
  else sections.push({ text: input.restCents > 0 ? fill(m.rest, { amount: formatEUR(input.restCents, input.locale) }) : m.allPaid });
  if (input.invoiceAttached) sections.push({ text: m.invoiceAttached });
  return confirmationMail({
    email: input.email,
    name: input.name,
    locale: input.locale,
    siteUrl: input.siteUrl,
    subject: oneLine(fill(input.confirmed ? m.subjectConfirmed : m.subjectReceived, { title })),
    lead: input.confirmed ? m.leadConfirmed : m.leadReceived,
    box: { title, lines: input.session ? sessionLines(input.session, input.locale) : [] },
    sections,
    login: null,
  });
}

export type EcourseOpenInput = {
  siteUrl: string;
  email: string;
  name: string;
  locale: Locale;
  course: I18n;
  /** The access's last moment (server/payments/grant.ts). */
  expiresAt: Date;
  /** A live login for the address (client-auth.ts issueClientLogin), or null when it has its 3 already: then "Ava minu konto". */
  login: LoginCode | null;
  /** The purchase's invoice goes with the mail as a PDF (invoices, spec §4): the line „Arve on lisatud.". */
  invoiceAttached?: boolean;
  /** The purchase's contract goes with the mail as a PDF, after the invoice (contracts, D7): the line „Leping on lisatud.“. */
  contractAttached?: boolean;
};

/**
 * The mail after a paid e-course purchase (phase 2b, spec 6.2.4): "E-koolitus on avatud — {title}", the course with "Ligipääs kuni {date}.",
 * „Arve on lisatud." when the purchase's invoice is attached and „Leping on lisatud.“ when its contract is (settle.ts attaches both, the invoice
 * first), and the login: the code large and "Logi sisse"
 * (verifyLink, like the code login), which opens Minu koolitused with the course on it. It leaves out the login mail's "Kui sa ei palunud
 * sisselogimist, võid selle kirja kustutada.": the buyer has just paid, and that line could make her delete her access. settle.ts never sends
 * it to a sample address and does not count it in the daily caps (it follows a real payment).
 */
export function ecourseOpenMail(input: EcourseOpenInput): Mail {
  const m = getDict(input.locale).payment.mail;
  const title = pick(input.course, input.locale);
  return confirmationMail({
    email: input.email,
    name: input.name,
    locale: input.locale,
    siteUrl: input.siteUrl,
    subject: oneLine(fill(m.subjectEcourse, { title })),
    lead: m.leadEcourse,
    box: { title, lines: [fill(m.access, { date: formatDate(input.expiresAt, input.locale) })] },
    sections: [
      ...(input.invoiceAttached ? [{ text: m.invoiceAttached }] : []),
      ...(input.contractAttached ? [{ text: getDict(input.locale).account.contractMail.attached }] : []),
    ],
    login: input.login,
    afterPurchase: true,
  });
}

export type InvoiceMailInput = {
  siteUrl: string;
  /** The address this copy goes to: the student's, or the second one Maria typed (D11). */
  email: string;
  /** The buyer's name, for the greeting (its first word). */
  name: string;
  locale: Locale;
  /**
   * The copy for the second address of „Saada ka aadressile“ (D11; the final review's m9): its reader is not the student (say her accountant),
   * so the greeting is the neutral „Tere!“ / «Здравствуйте!», not her first name, and there is no „Ava minu konto“.
   */
  second?: boolean;
  /** The invoice as the PDF prints it: its frozen row. A cancelled invoice is never mailed. */
  invoice: Pick<Invoice, "number" | "status" | "amountCents" | "dueAt" | "paidAt" | "reference" | "line" | "seller">;
  /** The invoice's PDF (server/invoices.ts invoicePdf, rendered now): the mail's one attachment. */
  pdf: Uint8Array;
};

/**
 * Maria's „Saada õpilasele“ (invoices Task 5, ruling R1; spec §4, D11): „MS LAB arve {number}“ (Russian «Счёт MS LAB {number}»), the course
 * with its date, the amount and, of an unpaid invoice, the due date, the bank details and the payment reference (the frozen seller's, as the
 * PDF prints them), or of a paid one the day it was paid and no request for money; the invoice's PDF attached; and one button, „Ava minu
 * konto“. No login in it, and not counted in the daily caps (it follows Maria's own send, like the protocol mail). The labels of the bank
 * rows are the account card's own (`account.dashboard.payment`). The caller attaches nothing: the PDF is in `attachments`. The copy for a
 * second address (`second`) greets no one by name and has no button.
 */
export function invoiceMail(input: InvoiceMailInput): Mail {
  const dict = getDict(input.locale);
  const m = dict.account.invoiceMail;
  const labels = dict.account.dashboard.payment;
  const { invoice: inv } = input;
  const paid = inv.status === "paid";
  const fields: [string, string][] = [[labels.amount, euro(inv.amountCents)]];
  if (paid) {
    if (inv.paidAt) fields.push([m.paidOn, formatDate(inv.paidAt, input.locale)]);
  } else {
    if (inv.dueAt) fields.push([m.due, formatDate(inv.dueAt, input.locale)]);
    fields.push([labels.receiver, inv.seller.receiver], [labels.iban, groupIban(inv.seller.iban)], [labels.bank, inv.seller.bank], [labels.reference, inv.reference]);
  }
  const mail = confirmationMail({
    email: input.email,
    // (a name with no word is the neutral „Tere!“: the second address's reader is not the student)
    name: input.second ? "" : input.name,
    locale: input.locale,
    siteUrl: input.siteUrl,
    subject: oneLine(fill(m.subject, { number: inv.number })),
    lead: fill(paid ? m.leadPaid : m.leadUnpaid, { number: inv.number }),
    box: { title: inv.line.course || inv.number, lines: inv.line.session ? [inv.line.session] : [] },
    sections: [{ fields: fields.filter(([, value]) => value.trim() !== "") }, { text: m.attached }],
    login: null,
    noAccount: input.second === true,
  });
  return { ...mail, attachments: [{ filename: invoiceFileName(inv.number), content: Buffer.from(input.pdf), contentType: "application/pdf" }] };
}

// ---------- the contract (contracts, Task 4; ruling R1; spec D7) ----------

/** A contract's PDF as a mail's attachment: „MS-LAB-leping-{id}.pdf“ (domain/contract.ts contractFileName). */
export const contractAttachment = (id: number, pdf: Uint8Array): MailAttachment => ({ filename: contractFileName(id), content: Buffer.from(pdf), contentType: "application/pdf" });

export type ContractMailInput = {
  siteUrl: string;
  /** The student's address (the contract's frozen one). */
  email: string;
  name: string;
  /** The mail's language: the page she accepted it on, or the contract's. */
  locale: Locale;
  /** The contract as frozen: its id (the file's name), its title, the day she accepted it, its course and session. */
  contract: Pick<Contract, "id" | "title" | "acceptedAt" | "fields">;
  /** The contract's PDF (contracts.ts contractPdfForMail, rendered now); null when it failed to render: no attachment and no line then. */
  pdf: Uint8Array | null;
  /** A student who has no account here (Task 5's „Saada koopia õpilasele“): no „Ava minu konto“. */
  noAccount?: boolean;
};

/**
 * „MS LAB leping“ (Russian «Договор MS LAB»): the mail that carries a contract she has just accepted — the terms gate's (Task 4), „Kinnitan“'s
 * (Task 6) — or a copy Maria sends (Task 5). The greeting, „Kinnitasid lepingu {date}.“ with the day she accepted it, the contract's title with its
 * course and session in the box, „Leping on lisatud.“ with the PDF attached, and one button, „Ava minu konto“ (none for a student without an
 * account). No login in it. The caller decides whom and whether to send it (never to a sample address).
 */
export function contractMail(input: ContractMailInput): Mail {
  const m = getDict(input.locale).account.contractMail;
  const { fields } = input.contract;
  const mail = confirmationMail({
    email: input.email,
    name: input.name,
    locale: input.locale,
    siteUrl: input.siteUrl,
    subject: m.subject,
    lead: fill(m.lead, { date: formatDate(input.contract.acceptedAt, input.locale) }),
    box: { title: oneLine(input.contract.title) || m.subject, lines: [fields.course, fields.session].filter((line) => line.trim() !== "") },
    sections: input.pdf ? [{ text: m.attached }] : [],
    login: null,
    noAccount: input.noAccount === true,
  });
  return input.pdf ? { ...mail, attachments: [contractAttachment(input.contract.id, input.pdf)] } : mail;
}

export type ContractRequestMailInput = {
  siteUrl: string;
  /** The student's address (the registration's). */
  email: string;
  name: string;
  /** The mail's language: the registration's. */
  locale: Locale;
  /** The course's name, in the mail's language. */
  course: string;
};

/**
 * „MS LAB leping kinnitamiseks“ (Russian «Договор MS LAB — подтвердите»; contracts Task 5, ruling R9, spec D4): the mail Maria's „Saada leping
 * kinnitamiseks“ sends. A short greeting, one line saying Maria asks her to confirm the contract for the course, and one button to her account's
 * page in her language (/konto, /ru/konto), where the card shows „Kinnita leping“. A plain link, never a login: no token, no code, no address
 * in it (she signs in as she always does). The caller decides whom and whether to send it (never to a sample address).
 */
export function contractRequestMail(input: ContractRequestMailInput): Mail {
  const dict = getDict(input.locale).account;
  const m = dict.contractRequestMail;
  const greeting = hello(dict.dashboard, input.name);
  const lead = fill(m.lead, { course: oneLine(input.course) });
  const link = `${input.siteUrl.replace(/\/+$/, "")}${href(input.locale, "/konto")}`;
  const text = [greeting, "", lead, "", `${dict.mail.confirm.open}:`, link, "", dict.mail.signature].join("\n");
  const html = mailCard(m.subject, input.locale, [greetingRow(greeting), paragraphRow(lead), buttonRow(link, dict.mail.confirm.open), linkRow(link), signatureRow(dict.mail)]);
  return { to: input.email, subject: m.subject, text, html };
}

export type RequestConfirmationInput = {
  siteUrl: string;
  email: string;
  name: string;
  locale: Locale;
  /** An individual-course request, a practice request or a waitlist entry. */
  kind: "individual" | "practice" | "waitlist";
  /** The course, or the practice package. */
  title: I18n;
  /** The date a waitlist entry is for. */
  session?: SessionInfo;
  /** A live login for the address (only a form with "Loo mulle kohe konto" can ask for one: the individual request). */
  login?: LoginCode | null;
};

/**
 * The short confirmation of an individual, practice or waitlist request: the sentence its dashboard card says, the course (the
 * package) and one button. A request says `account.next.requestNew` ("Päring on saadetud. Maria vastab peagi."), a waitlist entry
 * `account.next.waitlist` ("Oled ootenimekirjas. Anname teada, kui koht vabaneb.") and its date.
 */
export function requestConfirmationMail(input: RequestConfirmationInput): Mail {
  const dict = getDict(input.locale).account;
  const mail = dict.mail;
  const title = pick(input.title, input.locale);
  const waitlist = input.kind === "waitlist";
  return confirmationMail({
    email: input.email,
    name: input.name,
    locale: input.locale,
    siteUrl: input.siteUrl,
    subject: oneLine(fill(waitlist ? mail.confirm.subjectWaitlist : mail.confirm.subjectRequest, { title })),
    lead: waitlist ? dict.next.waitlist : dict.next.requestNew,
    box: { title, lines: input.session ? sessionLines(input.session, input.locale) : [] },
    sections: [],
    login: input.login ?? null,
  });
}

// ---------- the protocol's mails (phase protocols, spec §6) ----------

/** The student's protocol page: /konto/protokoll#id=<registration> (the id in the fragment: an account page never has a query). */
export const protocolUrl = (siteUrl: string, locale: Locale, registrationId: number): string =>
  `${siteUrl.replace(/\/+$/, "")}${href(locale, "/konto/protokoll")}#id=${registrationId}`;

/** A registration's feedback form: /konto/tagasiside#id=<registration>. */
export const feedbackUrl = (siteUrl: string, locale: Locale, registrationId: number): string =>
  `${siteUrl.replace(/\/+$/, "")}${href(locale, "/konto/tagasiside")}#id=${registrationId}`;

export type ProtocolMailInput = {
  siteUrl: string;
  email: string;
  name: string;
  /** The registration's language (spec §6). */
  locale: Locale;
  registrationId: number;
  course: I18n;
  session: SessionInfo | null;
  /** Sent before ("Saada uuesti"): "… on uuendatud", and no feedback line. */
  again: boolean;
  /**
   * A live login (client-auth.ts issueClientLogin): the button signs her in on the device that opens it and shows the protocol. null (she has
   * 3 live ones already): the button opens the page, which asks her to sign in.
   */
  login: LoginCode | null;
};

/**
 * "Sinu koolituse protokoll on valmis" / "… on uuendatud" (spec §6): the greeting, one line, the course with its date and place, one button
 * "Vaata protokolli" (with a login: verifyLink with the protocol as its target, written out under the button, then the six-digit code, how long
 * both work, and the small link to type the code on the login page, as ecourseOpenMail has them), and on the first send the line "Soovi korral
 * jäta meile tagasisidet", a text link to the form. No note of the protocol is in it: only the link.
 * Plain text and HTML. The caller (server/protocols.ts) never sends it to a sample address.
 */
export function protocolMail(input: ProtocolMailInput): Mail {
  const dict = getDict(input.locale);
  const m = dict.account.protocolMail;
  const mail = dict.account.mail;
  const title = pick(input.course, input.locale);
  const subject = input.again ? m.subjectAgain : m.subjectFirst;
  const lead = input.again ? m.leadAgain : m.leadFirst;
  const greeting = hello(dict.account.dashboard, input.name);
  const link = input.login ? verifyLink(input.siteUrl, input.login.token, input.locale, input.registrationId) : protocolUrl(input.siteUrl, input.locale, input.registrationId);
  const lines = input.session ? sessionLines(input.session, input.locale) : [];
  const form = input.again ? null : feedbackUrl(input.siteUrl, input.locale, input.registrationId);
  // the code under the button (an owner default): its link opens the login page at the code step
  const codeLink = accountLink(input.siteUrl, input.email, input.locale, true);
  const text = [
    greeting, "",
    lead, "",
    title, ...lines, "",
    `${m.button}:`, link,
    ...(input.login ? ["", mail.codeIntro, "", input.login.code, "", m.valid, "", mail.confirm.codeHere, codeLink] : []),
    ...(form ? ["", `${m.feedback}:`, form] : []),
    "", mail.signature,
  ].join("\n");
  const html = mailCard(subject, input.locale, [
    greetingRow(greeting),
    paragraphRow(lead),
    boxRow(`<div style="font:600 18px/1.4 ${FONT};color:${INK};">${esc(title)}</div>` + lines.map((line) => `<div>${esc(line)}</div>`).join(""), 12),
    buttonRow(link, m.button),
    linkRow(link),
    ...(input.login
      ? [
          paragraphRow(mail.codeIntro, 24),
          codeRow(input.login.code),
          row(`padding:16px 28px 0;${textStyle(14)}`, esc(m.valid)),
          row(`padding:12px 28px 0;${textStyle(14)}`, `${esc(mail.confirm.codeHere)} <a href="${esc(codeLink)}" style="color:${INK};text-decoration:underline;">${esc(mail.confirm.codeLink)}</a>`),
        ]
      : []),
    ...(form ? [row(`padding:20px 28px 0;${textStyle(14)}`, `<a href="${esc(form)}" style="color:${INK};text-decoration:underline;">${esc(m.feedback)}</a>`)] : []),
    signatureRow(mail),
  ]);
  return { to: input.email, subject, text, html };
}

// ---------- the e-course completion's mails (phase e-course completion, spec §6) ----------

/** The account's dashboard, "Minu koolitused": /konto. */
export const dashboardUrl = (siteUrl: string, locale: Locale): string => `${siteUrl.replace(/\/+$/, "")}${href(locale, "/konto")}`;

/** The e-course's page in the account: /konto/kursus/<slug> (the course in the path: an account page never has a query). */
export const ecourseUrl = (siteUrl: string, locale: Locale, slug: string): string =>
  `${siteUrl.replace(/\/+$/, "")}${href(locale, `/konto/kursus/${encodeURIComponent(slug)}`)}`;

/** The e-course's knowledge test: /konto/kursus/<slug>/test. */
export const testUrl = (siteUrl: string, locale: Locale, slug: string): string => `${ecourseUrl(siteUrl, locale, slug)}/test`;

/** The e-course's practical work: /konto/kursus/<slug>/praktiline (for a course without points: Maria's sent notes only). */
export const practicalUrl = (siteUrl: string, locale: Locale, slug: string): string => `${ecourseUrl(siteUrl, locale, slug)}/praktiline`;

export type CompletionMailKind =
  | "assessed" // Maria's assessment with "Paranda" points
  | "completed" // the course completed (any path)
  | "testPassed" // Maria accepted the open answers; practical work next
  | "testFix" // Maria asked to rewrite open answers
  | "reopened" // Maria reopened the test
  | "protocol" // a notes-only protocol of an e-course without points, first send
  | "protocolAgain"; // the same, sent again, or an approved assessment's notes re-sent

export type CompletionMailInput = {
  siteUrl: string;
  email: string;
  name: string;
  /** The account's language (clients.locale). */
  locale: Locale;
  slug: string;
  course: I18n;
  kind: CompletionMailKind;
  /** "assessed": how many points Maria marked "Paranda" (the box says it; absent or 0: no line). */
  fixCount?: number;
  /** "completed": the course has practical points, so the button opens the practical work (all "Kinnitatud"); else the e-course's page. */
  hasPoints?: boolean;
  /**
   * "completed": the access is active as the mail is built (absent: it is). One that is not (it ended before Maria's last approval) sends the
   * certificate's line to the dashboard, whose card has the name form, as the e-course's page needs an active access.
   */
  accessActive?: boolean;
};

/**
 * The student's mails of the e-course completion (spec §6): the greeting, one line, the course in its box (an assessment adds how many points
 * to fix), and one button to the page it is about, written out under it. No login code: the button opens the page, and she signs in there if
 * she must. Never a note, an answer or a photo, only the link. The test's and practical work's links follow the kind:
 * - assessed, protocol, protocolAgain and testPassed: the practical work;
 * - testFix and reopened: the test;
 * - completed: the practical work of a course with points, else the e-course's page.
 * "completed" adds one line (phase 3d, spec §5): "Kinnita oma nimi ja laadi tunnistus alla:" with the page where she does it — the e-course's
 * page, with its "Tunnistus" row, or the dashboard when the access is no longer active (`accessActive` false: its card has the form). Under
 * the button as a text link of its own, so the mail keeps its one button; when it is the button's own page (a course without points, an
 * active access), above the button instead, and the address is written once. Never an attachment. Plain text and HTML; the caller never
 * sends it to a sample address.
 */
export function completionMail(input: CompletionMailInput): Mail {
  const dict = getDict(input.locale);
  const m = dict.account.completionMail;
  const p = dict.account.protocolMail;
  const mail = dict.account.mail;
  const title = pick(input.course, input.locale);
  const practical = practicalUrl(input.siteUrl, input.locale, input.slug);
  const test = testUrl(input.siteUrl, input.locale, input.slug);
  const parts: Record<CompletionMailKind, { subject: string; lead: string; button: string; link: string }> = {
    assessed: { subject: m.assessedSubject, lead: m.assessedLead, button: m.assessedButton, link: practical },
    completed: {
      subject: oneLine(fill(m.completedSubject, { title })),
      lead: m.completedLead,
      button: m.completedButton,
      link: input.hasPoints ? practical : ecourseUrl(input.siteUrl, input.locale, input.slug),
    },
    testPassed: { subject: m.testPassedSubject, lead: m.testPassedLead, button: m.testPassedButton, link: practical },
    testFix: { subject: m.testFixSubject, lead: m.testFixLead, button: m.testFixButton, link: test },
    reopened: { subject: m.reopenedSubject, lead: m.reopenedLead, button: m.reopenedButton, link: test },
    protocol: { subject: p.subjectFirst, lead: p.leadFirst, button: p.button, link: practical },
    protocolAgain: { subject: p.subjectAgain, lead: p.leadAgain, button: p.button, link: practical },
  };
  const { subject, lead, button, link } = parts[input.kind];
  const greeting = hello(dict.account.dashboard, input.name);
  const lines = input.kind === "assessed" && input.fixCount ? [fill(m.fixCount, { n: input.fixCount })] : [];
  // the certificate (phase 3d): her name to confirm and the PDF to download, on the e-course's page, or on the dashboard's card once the
  // access is not active; the button's own page (a course without points) gets the line above the button and its address once
  const certificate =
    input.kind !== "completed" ? null : input.accessActive === false ? dashboardUrl(input.siteUrl, input.locale) : ecourseUrl(input.siteUrl, input.locale, input.slug);
  const sameLink = certificate === link;
  const text = [
    greeting, "",
    lead, "",
    title, ...lines, "",
    ...(sameLink ? [m.completedCertificate, link] : [`${button}:`, link]),
    ...(certificate && !sameLink ? ["", m.completedCertificate, certificate] : []),
    "", mail.signature,
  ].join("\n");
  const html = mailCard(subject, input.locale, [
    greetingRow(greeting),
    paragraphRow(lead),
    boxRow(`<div style="font:600 18px/1.4 ${FONT};color:${INK};">${esc(title)}</div>` + lines.map((line) => `<div>${esc(line)}</div>`).join(""), 12),
    ...(sameLink ? [paragraphRow(m.completedCertificate)] : []),
    buttonRow(link, button),
    linkRow(link),
    ...(certificate && !sameLink
      ? [
          row(
            `padding:20px 28px 0;${textStyle(14)}`,
            `${esc(m.completedCertificate)}<br><a href="${esc(certificate)}" style="color:${INK};text-decoration:underline;word-break:break-all;">${esc(certificate)}</a>`,
          ),
        ]
      : []),
    signatureRow(mail),
  ]);
  return { to: input.email, subject, text, html };
}
