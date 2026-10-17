// The contracts' pure rules (contracts, Task 1; spec §2 D1–D7, §3, §6): the kinds and shapes a contract freezes, the settings keys of the contact
// course's text, the placeholders Maria may write in a text and how they are filled, the language a contract is made in, the session and payment
// texts, the download's file name and headers, and the school block when Seaded → Arve andmed is empty. No database, no React: the server, Maria's
// screens and the student's account share them. It runs in the browser too (the form's and the cart's inline contract, Seaded's sample), on iOS
// Safari before 16.4 as well: no lookbehind here nor in what it imports (tests/unit/old-safari.test.ts), no builtin newer than Safari 15, no node: module.
// What a contract is filled with is made by one function on both sides (contractParts, filledContract: Task 4, Review Focus 3).

import type { I18n } from "@/i18n/field";
import { tallinnDateText } from "./certificate";
import { normalizeEmail } from "./email";
import { euro } from "./invoice";
import { prepaymentDue } from "./registration";

/** What a contract is for (D1): a contact course's registration, or an e-course's access. */
export type ContractKind = "contact" | "ecourse";
/** How it was accepted (D1, D4): the registration form's box, the e-course purchase, the account's „Kinnitan“, or the terms gate. */
export type AcceptedVia = "form" | "purchase" | "account" | "terms";

/**
 * Everything the PDF's header holds besides the text (D3, §5), frozen at the acceptance: the school (Seaded → Arve andmed; schoolOf), the
 * student, the course's name in the contract's language (contractCourseName), the session (sessionText), the price in euros and the payment
 * choice in words (paymentText).
 * `session`, `price` and `payment` are empty when there is none (an e-course has no session or choice; a free grant has no price).
 */
export type ContractFields = {
  school: { company: string; registryCode: string; address: string };
  student: { name: string; email: string };
  course: string;
  session: string;
  price: string;
  payment: string;
};

/** The contract an e-course purchase showed in the cart, kept on the payment until it is paid (payments.contract_snapshot, §4): what settle freezes. */
export type ContractSnapshot = { version: string; locale: "et" | "ru"; title: string; body: string };

/** The `pages` key of „Kontaktkoolituse leping“ (D2); the e-course's text keeps its own, `course_terms`. */
export const CONTRACT_CONTACT_KEY = "contract_contact";
/** The `settings` key of its version, as `courseTermsVersion` is the e-course text's (§3). */
export const CONTRACT_CONTACT_VERSION_KEY = "contractContactVersion";

/** The names Maria may write between braces in a contract text (D2), filled at the acceptance. */
export const PLACEHOLDERS = ["nimi", "e-post", "koolitus", "toimumine", "hind", "ettemaks"] as const;
export type ContractValues = Record<(typeof PLACEHOLDERS)[number], string>;

const PLACEHOLDER = /\{([^{}\n]*)\}/g;

/**
 * The text with its placeholders filled (D2, D3). One pass over the text, so that a value which itself holds a placeholder (a name typed as
 * "{hind}") is never filled again. The names are exact: an unknown `{x}`, another case, a lone brace and an unclosed placeholder stay as
 * typed, and a placeholder never reaches across a line. A value goes in as it is (no `$` pattern of String.replace works in it).
 */
export function fillContract(text: string, values: ContractValues): string {
  return text.replace(PLACEHOLDER, (whole: string, name: string) => ((PLACEHOLDERS as readonly string[]).includes(name) ? values[name as keyof ContractValues] : whole));
}

/** The placeholders' values from a contract's fields (D2); `prepayment` is the text of the half the choice asks first, which the caller knows. */
export function contractValues(f: Omit<ContractFields, "school">, prepayment: string): ContractValues {
  return { nimi: f.student.name, "e-post": f.student.email, koolitus: f.course, toimumine: f.session, hind: f.price, ettemaks: prepayment };
}

/** A course's name in the contract's language (D6, ruling R5): the Russian title for a Russian contract when the course has one, else the Estonian title. */
export function contractCourseName(title: I18n, locale: "et" | "ru"): string {
  return locale === "ru" && (title.ru ?? "").trim() ? (title.ru as string) : title.et;
}

/**
 * What a contract is made of besides the school and the text (D3), as a form holds it: the student as she typed herself, the course's name (in the
 * contract's language: contractCourseName), the session (none for an e-course, or before she has chosen one), the price in cents and the payment
 * choice (none for an e-course), and the contract's language.
 */
export type ContractInput = {
  name: string;
  email: string;
  course: string;
  session: { startsAt: Date; city: string; venue?: string } | null;
  priceCents: number | null;
  choice: "full" | "half" | null;
  locale: "et" | "ru";
};

/**
 * The fields of a contract but the school, and its „Ettemaks“ text, from what a form holds: the server's frozen contract (contracts.ts
 * registrationContractFields, from the stored registration) and the forms' inline contract in the browser (filledContract) are made by this one
 * function, so a placeholder can never be filled one way on the page and another way in the contract (Review Focus 3). The name is one line and
 * the address trimmed and in lower case, as the forms store them (server/forms.ts), so what she typed and what was stored give the same text. The
 * price is euro() of the cents („350,00 €“), the payment choice its words (paymentText), the prepayment the half the choice asks first (or the
 * whole price); each is empty without a price or a choice.
 */
export function contractParts(input: ContractInput): { fields: Omit<ContractFields, "school">; prepayment: string } {
  const price = input.priceCents;
  return {
    fields: {
      student: { name: input.name.replace(/\s+/g, " ").trim(), email: normalizeEmail(input.email) },
      course: input.course,
      session: sessionText(input.session),
      price: price === null ? "" : euro(price),
      payment: paymentText(input.choice, input.locale),
    },
    prepayment: price === null || input.choice === null ? "" : euro(prepaymentDue(price, input.choice)),
  };
}

/**
 * A contract text filled from what a form holds (D1): the registration form's and the cart's inline contract („Loe lepingut“), and the copy an
 * e-course purchase keeps on its payment (payments.contract_snapshot), which is the cart's very text. `noSession` is what {toimumine} says while no
 * session is chosen (the form's „(vali toimumine)“); without it, as on the server, an empty session is empty.
 */
export function filledContract(template: { title: string; body: string }, input: ContractInput, noSession?: string): { title: string; body: string } {
  const { fields, prepayment } = contractParts(input);
  const values = contractValues(fields, prepayment);
  if (input.session === null && noSession !== undefined) values.toimumine = noSession;
  return { title: fillContract(template.title, values), body: fillContract(template.body, values) };
}

/** The language a contract is made in (D6): RU when she registered in RU and the RU text exists, else ET. */
export function contractLocale(registeredLocale: "et" | "ru", ruTextExists: boolean): "et" | "ru" {
  return registeredLocale === "ru" && ruTextExists ? "ru" : "et";
}

/**
 * "14.11.2026, Tallinn" (D2 `{toimumine}`, the date and the place): the session's date on Tallinn's calendar, its city, and its venue when
 * it has one, the way Maria's registrations list names it. Empty for none (an e-course, a registration without a session).
 */
export function sessionText(s: { startsAt: Date; city: string; venue?: string } | null): string {
  if (!s) return "";
  return [tallinnDateText(s.startsAt), s.city.trim(), (s.venue ?? "").trim()].filter(Boolean).join(", ");
}

/**
 * The payment choice in words, as the registration form words its two choices (forms.payFull and forms.payHalf of the dictionaries; a test
 * keeps them equal), in the language of the contract. None (an e-course) is empty. Not the dictionary itself: a browser file must not pull it in.
 */
export function paymentText(choice: "full" | "half" | null, locale: "et" | "ru"): string {
  if (choice === null) return "";
  if (locale === "ru") return choice === "full" ? "100% сразу" : "50% при регистрации + 50% в день обучения";
  return choice === "full" ? "100% kohe" : "50% registreerimisel + 50% koolituspäeval";
}

/** "MS-LAB-leping-7.pdf": the download's file name (Content-Disposition), by the contract's own id. */
export function contractFileName(id: number): string {
  return `MS-LAB-leping-${id}.pdf`;
}

/**
 * The three headers every contract download carries (§5), whoever asks: the type, the file name by its id, nosniff. The caller adds
 * `cache-control: private, no-store`.
 */
export function contractDownloadHeaders(id: number): Record<string, string> {
  return {
    "content-type": "application/pdf",
    "content-disposition": `attachment; filename="${contractFileName(id)}"`,
    "x-content-type-options": "nosniff",
  };
}

/**
 * The school of a contract from Seaded → Arve andmed (D3): its company, registry code and address. Before Maria names the company (§6) the
 * block says "MS LAB", the brand, and prints no more than she has typed: the contract says nothing false.
 */
export function schoolOf(invoiceSettings: { company: string; registryCode: string; address: string }): ContractFields["school"] {
  return {
    company: invoiceSettings.company.trim() || "MS LAB",
    registryCode: invoiceSettings.registryCode.trim(),
    address: invoiceSettings.address.trim(),
  };
}
