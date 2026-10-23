// Plain-text summaries of public submissions for Maria: the e-mail (subject + text) and a short Telegram line.
// They are written in Estonian for Maria and never shown to visitors, so they are not in the site dictionaries.

import type { PaymentKind } from "@/db/schema";
import { formatEUR } from "@/domain/money";
import { paymentMethodLabel } from "@/domain/payments";
import type { PaymentChoice } from "@/domain/registration";
import { formatDate } from "@/i18n/format";
import { answerText, FEEDBACK_ORDER, feedbackQuestions, type FeedbackAnswers } from "@/domain/protocols";
import { et } from "@/i18n/dict/et";

export type Summary = { subject: string; text: string; short: string };

/** label, value, and whether the value goes on its own lines below the label (free text). */
type Row = readonly [label: string, value: string | undefined, block?: boolean];

const TIME_ZONE = "Europe/Tallinn";
const LANGUAGE = { et: "eesti", ru: "vene" } as const;
const PAYMENT: Record<PaymentChoice, string> = { full: "100% kohe", half: "50% registreerimisel + 50% koolituspäeval", financing: "Järelmaks (Inbank)" };

const yesNo = (b: boolean) => (b ? "jah" : "ei");

/** "14.11.2026 kell 10:00" in Estonian time. */
export function sessionWhen(d: Date): string {
  const parts = new Intl.DateTimeFormat("et-EE", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")} kell ${get("hour")}:${get("minute")}`;
}

/** Labelled lines; empty values are left out. Free text (block) goes on its own lines below its label. */
function body(title: string, rows: Row[], adminUrl: string, note?: string): string {
  const lines = rows.flatMap(([label, value, block]) => {
    const v = value?.trim();
    if (!v) return [];
    return block ? ["", `${label}:`, v] : [`${label}: ${v}`];
  });
  return [title, "", ...lines, ...(note ? ["", note] : []), "", `Admin: ${adminUrl}`, ""].join("\n");
}

type Visitor = { name: string; email: string; phone?: string; locale: "et" | "ru" };
const person = (v: Visitor): Row[] => [
  ["Nimi", v.name],
  ["E-post", v.email],
  ["Telefon", v.phone],
  ["Suhtluskeel", LANGUAGE[v.locale]],
];
const contactLine = (v: Visitor) => [v.name, v.email, v.phone].filter(Boolean).join(" · ");

type SessionInfo = { course: string; startsAt: Date; city: string; venue: string };
const sessionRows = (s: SessionInfo): Row[] => [
  ["Koolitus", s.course],
  ["Kuupäev", sessionWhen(s.startsAt)],
  ["Koht", [s.city, s.venue].filter(Boolean).join(", ")],
];
const sessionShort = (s: SessionInfo) => `${s.course} · ${sessionWhen(s.startsAt)} · ${s.city}`;

export function registrationSummary(
  s: SessionInfo & Visitor & { paymentChoice: PaymentChoice; wantsModelHelp: boolean; wantsAccount: boolean; message: string },
  adminUrl: string,
): Summary {
  const title = "Uus registreerimine (grupikoolitus)";
  return {
    subject: `Registreerimine: ${s.course}, ${sessionWhen(s.startsAt)}, ${s.city} — ${s.name}`,
    text: body(
      title,
      [
        ...sessionRows(s),
        ...person(s),
        ["Tasumine", PAYMENT[s.paymentChoice]],
        ["Abi modellide leidmisel", yesNo(s.wantsModelHelp)],
        ["Loo konto", yesNo(s.wantsAccount)],
        ["Sõnum", s.message, true],
      ],
      adminUrl,
      "Staatus: ootab ettemaksu. Koht kinnitub alles pärast vähemalt 50% ettemaksu laekumist.",
    ),
    short: `${title}\n${sessionShort(s)}\n${contactLine(s)}\nTasumine: ${PAYMENT[s.paymentChoice]}`,
  };
}

export function individualSummary(
  r: Visitor & { course: string; preferredPeriod: string; message: string; wantsModelHelp: boolean; wantsAccount: boolean },
  adminUrl: string,
): Summary {
  const title = "Individuaalkoolituse päring";
  return {
    subject: `Individuaalkoolituse päring: ${r.course} — ${r.name}`,
    text: body(
      title,
      [
        ["Koolitus", r.course],
        ["Soovitud periood või kuupäev", r.preferredPeriod],
        ...person(r),
        ["Abi modellide leidmisel", yesNo(r.wantsModelHelp)],
        ["Loo konto", yesNo(r.wantsAccount)],
        ["Sõnum", r.message, true],
      ],
      adminUrl,
      "Aeg ja tasumine lepitakse kokku.",
    ),
    short: `${title}\n${r.course} · ${r.preferredPeriod}\n${contactLine(r)}`,
  };
}

export function contactSummary(r: Visitor & { message: string }, adminUrl: string): Summary {
  const title = "Uus sõnum kodulehelt";
  return {
    subject: `Sõnum kodulehelt — ${r.name}`,
    text: body(title, [...person(r), ["Sõnum", r.message, true]], adminUrl),
    short: `${title}\n${contactLine(r)}\n${r.message.slice(0, 280)}`,
  };
}

export function purchaseInterestSummary(r: { course: string; email: string; locale: "et" | "ru" }, adminUrl: string): Summary {
  const title = "E-koolituse ostusoov";
  return {
    subject: `E-koolituse ostusoov: ${r.course}`,
    text: body(title, [["Koolitus", r.course], ["E-post", r.email], ["Suhtluskeel", LANGUAGE[r.locale]]], adminUrl, "Soovib teadet, kui makse on avatud."),
    short: `${title}\n${r.course}\n${r.email}`,
  };
}

export function practiceSummary(r: Visitor & { package: string; course: string; times: string }, adminUrl: string): Summary {
  const title = "Praktika taotlus";
  return {
    subject: `Praktika taotlus: ${r.package} — ${r.name}`,
    text: body(
      title,
      [["Pakett", r.package], ...person(r), ["Läbitud koolitus või kogemus", r.course], ["Sobivad ajad", r.times, true]],
      adminUrl,
      "Aeg kinnitatakse pärast Maria vastust.",
    ),
    short: `${title}: ${r.package}\n${contactLine(r)}\n${r.times.slice(0, 200)}`,
  };
}

export function waitlistSummary(s: SessionInfo & Visitor, adminUrl: string): Summary {
  const title = "Ootenimekiri";
  return {
    subject: `Ootenimekiri: ${s.course}, ${sessionWhen(s.startsAt)}, ${s.city} — ${s.name}`,
    text: body(title, [...sessionRows(s), ...person(s)], adminUrl),
    short: `${title}\n${sessionShort(s)}\n${contactLine(s)}`,
  };
}

/**
 * A student's wish to cancel a registration or move it to another date (the account's "Soovin tühistada / muuta aega").
 * Nothing has been changed: the registration stays as it was until Maria has talked to the student. `session` is null for
 * a registration without a date (an individual course).
 */
export function changeRequestSummary(
  r: Visitor & { registrationId: number; course: string; session: Omit<SessionInfo, "course"> | null; kind: "cancel" | "change"; message: string },
  adminUrl: string,
): Summary {
  const title = r.kind === "cancel" ? "Soov registreering tühistada" : "Soov registreeringu aega muuta";
  const info = r.session ? { course: r.course, ...r.session } : null;
  const place = info ? `${r.course}, ${sessionWhen(info.startsAt)}, ${info.city}` : r.course;
  return {
    subject: `${title}: ${place} — ${r.name}`,
    text: body(
      title,
      [
        ...(info ? sessionRows(info) : ([["Koolitus", r.course]] as Row[])),
        ["Registreeringu number", String(r.registrationId)],
        ...person(r),
        ["Sõnum", r.message, true],
      ],
      adminUrl,
      "Registreeringut ei ole muudetud. Võta õpilasega ühendust ja muuda registreering vajadusel adminis.",
    ),
    short: `${title}\n${info ? sessionShort(info) : r.course}\n${contactLine(r)}${r.message ? `\n${r.message.slice(0, 280)}` : ""}`,
  };
}

// ---------- payments (phase 2b, spec 6.2.5, 7.3, 7.4) ----------
// Maria's texts carry no English Montonio code (the owner's decision of 09.10): the way of paying is domain/payments.ts paymentMethodLabel, a
// refund and a void are told in words, and the money that has arrived is "Laekunud summa" (the payer's own mail says "Tasutud").

const PAYMENT_KIND: Record<PaymentKind, string> = { prepayment: "Ettemaks", balance: "Ülejäänud", ecourse: "E-koolitus" };

/**
 * What a payment was for, the {mis} of "Uus makse: {nimi}, {mis}, {summa}": "Kulmumeistri baaskoolitus, 14.11.2026" (a registration's session
 * day), or "Kulmumeistri e-koolitus (e-koolitus)" for an e-course (the owner's form of 10.10: the title, then what it is). An e-course whose
 * course is gone has no title (`course` is ""): "E-koolitus" alone, never a dash in brackets.
 */
const paidFor = (kind: PaymentKind, course: string, startsAt: Date | null): string =>
  kind === "ecourse" ? (course ? `${course} (e-koolitus)` : "E-koolitus") : startsAt ? `${course}, ${formatDate(startsAt, "et")}` : course;

/** A paid payment, for Maria's notice. `outcome`: what it did (settle.ts). `restCents`: left to pay on the registration afterwards. */
export type PaymentNotice = {
  kind: PaymentKind;
  name: string;
  email: string;
  amountCents: number;
  /** The course's Estonian title; "—" for a registration's course that is gone, "" for an e-course's (paidFor). */
  course: string;
  startsAt: Date | null;
  /** Montonio's code of the way of paying and the bank's name: shown as Maria's word (paymentMethodLabel). */
  method: string;
  bank: string;
  reference: string;
  providerUuid: string | null;
  outcome: "confirmed" | "received" | "full" | "opened" | "notOpened";
  restCents?: number;
  /** An e-course that was opened: the last moment of her access. */
  until?: Date | null;
};

/**
 * "Uus makse: {nimi}, {mis}, {summa}" (spec 9), or "Makse laekus, aga koolitus on täis: …" when the course was full (D2). An e-course payment
 * has two outcomes only, opened ("E-koolitus on avatud kuni {date}.") or not (Task 3's text): no registration wording reaches it, whatever
 * the outcome it is given.
 */
export function paymentSummary(p: PaymentNotice, adminUrl: string): Summary {
  const amount = formatEUR(p.amountCents, "et");
  const ecourse = p.kind === "ecourse";
  const what = paidFor(p.kind, p.course, p.startsAt);
  const subject = `${!ecourse && p.outcome === "full" ? "Makse laekus, aga koolitus on täis" : "Uus makse"}: ${p.name}, ${what}, ${amount}`;
  const rest = p.restCents ?? 0;
  const notes: Record<PaymentNotice["outcome"], string> = {
    confirmed: rest > 0 ? `Registreering on kinnitatud. Ülejäänud ${formatEUR(rest, "et")} tasub ta koolituspäeval või Minu koolitustes.` : "Registreering on kinnitatud ja täielikult tasutud.",
    received: "Makse on registreeringule kirja pandud.",
    full: "Koolitus on täis: koht jäi kinnitamata, makse on registreeringule kirja pandud. Võta õpilasega ühendust (Registreerimised).",
    opened: p.until ? `E-koolitus on avatud kuni ${formatDate(p.until, "et")}.` : "E-koolitus on avatud.",
    // one sentence for every reason (the course is gone or is no e-course any more, the grant was refused or failed): the payment is paid
    notOpened: "E-koolitust ei avatud. Ava ligipääs käsitsi (Õpilased) või tagasta raha Montonios.",
  };
  const note = ecourse ? notes[p.outcome === "opened" ? "opened" : "notOpened"] : notes[p.outcome];
  return {
    subject,
    text: body(
      subject,
      [
        ["Makse", PAYMENT_KIND[p.kind]],
        ["Summa", amount],
        ["Koolitus", ecourse ? p.course : what],
        ["Maksja", p.name],
        ["E-post", p.email],
        ["Makseviis", paymentMethodLabel(p.method, p.bank)],
        ["Viide", p.reference],
        ["Montonio", p.providerUuid ?? undefined],
      ],
      adminUrl,
      note,
    ),
    short: subject,
  };
}

/** A payment Maria must look at in Montonio's own dashboard (spec 7.3, 7.4, 8). `paidCents` and `currency`: what Montonio said (of the second order, for "double"). */
export type PaymentAlert = {
  /** held: the amount did not match; voided, refunded: the bank took it back; double: a second order of the same payment was paid too. */
  alert: "held" | "voided" | "refunded" | "double";
  kind: PaymentKind;
  name: string;
  email: string;
  amountCents: number;
  course: string;
  startsAt: Date | null;
  reference: string;
  providerUuid: string | null;
  /** double: the uuid of the second order that was paid (the payment's own is `providerUuid`). */
  otherUuid?: string | null;
  /**
   * double: this payment is itself the second payment of something paid in full already (instalments §4, D5), held, not recorded — its own
   * order (`providerUuid`) and no other one. "loan": a järelmaks Inbank approved while its registration, or her e-course, was paid in full;
   * "bank": an e-course's bank payment that came after her järelmaks of the same course was paid.
   */
  late?: "loan" | "bank";
  /**
   * refunded: the refunded row was never counted (held, so `paid_at` is null: a late järelmaks or bank payment Maria refunds after
   * „Topeltmakse“), so the sum, the registration and the access are right as they are and the note must not invite her to change them.
   */
  neverCounted?: boolean;
  /** Montonio's status (upper case); only told apart as PARTIALLY_REFUNDED and the rest, and never shown. */
  rawStatus: string;
  paidCents: number | null;
  currency: string | null;
};

/**
 * "Ülemakse: {nimi}, {kursus}" (the final review of 10.10): an online payment took the registration's paid sum over the course's price — the
 * backstop of the double-payment rule (two orders of one registration both paid). The payment is recorded as any other; Maria refunds the
 * part over the price in Montonio. `paidCents`: the registration's sum after this payment; `amountCents`: this payment.
 */
export function overpaymentSummary(
  o: { kind: PaymentKind; name: string; email: string; amountCents: number; course: string; startsAt: Date | null; reference: string; providerUuid: string | null; paidCents: number; priceCents: number },
  adminUrl: string,
): Summary {
  const subject = `Ülemakse: ${o.name}, ${o.course}`;
  return {
    subject,
    text: body(
      subject,
      [
        ["Makse", PAYMENT_KIND[o.kind]],
        ["Summa", formatEUR(o.amountCents, "et")],
        ["Koolitus", paidFor(o.kind, o.course, o.startsAt)],
        ["Maksja", o.name],
        ["E-post", o.email],
        ["Viide", o.reference],
        ["Montonio", o.providerUuid ?? undefined],
      ],
      adminUrl,
      `Laekunud kokku ${formatEUR(o.paidCents, "et")}, koolituse hind ${formatEUR(o.priceCents, "et")}. Kontrolli Montonios ja tagasta liigne osa.`,
    ),
    short: subject,
  };
}

/** A payment of "Makse vajab kontrolli" and of its follow-up: what it was for, who paid, and its ids. */
export type StuckPayment = { kind: PaymentKind; name: string; email: string; amountCents: number; course: string; startsAt: Date | null; reference: string; providerUuid: string | null };

/** The rows of "Makse vajab kontrolli" and of its follow-up. */
const stuckRows = (s: StuckPayment): Row[] => [
  ["Makse", PAYMENT_KIND[s.kind]],
  ["Summa", formatEUR(s.amountCents, "et")],
  ["Koolitus", paidFor(s.kind, s.course, s.startsAt)],
  ["Maksja", s.name],
  ["E-post", s.email],
  ["Viide", s.reference],
  ["Montonio", s.providerUuid ?? undefined],
];

/**
 * "Makse vajab kontrolli: {nimi}" (the final review of 10.10): the daily check found a payment that Montonio says is paid, but recording it
 * threw (server/payments/check.ts). The money is at Montonio and nowhere in the app: Maria records it at the registration with „Lisa laekumine“ and
 * a receipt (piece2-texts W8a) — or, for an e-course, which has no registration, by opening the course under Õpilased. `paidCents` and `currency`: what Montonio said was paid.
 */
export function stuckPaymentSummary(s: StuckPayment & { paidCents: number | null; currency: string | null }, adminUrl: string): Summary {
  const subject = `Makse vajab kontrolli: ${s.name}`;
  const byHand = s.kind === "ecourse" ? "Kontrolli Montonios ja ava vajadusel e-koolitus käsitsi Õpilaste all." : "Kontrolli Montonios ja lisa makse registreeringu juures nupuga „Lisa laekumine“, kviitungiga.";
  return {
    subject,
    text: body(subject, stuckRows(s), adminUrl, `Montonio järgi on ${montonioSaid(s.paidCents, s.currency)} makstud (viide ${s.reference}), aga seda ei õnnestunud kirja panna. ${byHand}`),
    short: subject,
  };
}

/**
 * "Makse on nüüd kirja pandud: {nimi}": the follow-up of "Makse vajab kontrolli" (stuckPaymentSummary), when the app recorded that payment
 * after all (server/payments/settle.ts). Maria may have recorded it with „Lisa laekumine“ meanwhile: that receipt's payment is to be taken back, or the
 * payment counts twice (piece2-texts W8b); an e-course she opened by hand needs nothing (opened twice, the access is not longer).
 */
export function recordedAfterAlertSummary(s: StuckPayment, adminUrl: string): Summary {
  const subject = `Makse on nüüd kirja pandud: ${s.name}`;
  const byHand =
    s.kind === "ecourse"
      ? "Kui avasid e-koolituse juba käsitsi Õpilaste all, pole vaja midagi teha."
      : "Kui lisasid selle juba nupuga „Lisa laekumine“, võta selle kviitungi tasumine tagasi, et makset ei loetaks kaks korda.";
  return {
    subject,
    text: body(subject, stuckRows(s), adminUrl, `Makse, mille kohta tuli teade "Makse vajab kontrolli", on nüüd automaatselt kirja pandud (viide ${s.reference}). ${byHand}`),
    short: subject,
  };
}

/** A number of cents as a plain amount ("125,50"), for a currency other than the euro. */
const plainAmount = (cents: number): string => formatEUR(cents, "et").replace(/ €$/, "");

/** What Montonio said was paid: "1 €", "125,50 PLN", and what is missing: "summa puudub", "valuuta puudub". The euro is written once. */
function montonioSaid(cents: number | null, currency: string | null): string {
  const parts: string[] = [];
  if (cents === null) parts.push(currency && currency !== "EUR" ? `summa puudub, ${currency}` : "summa puudub");
  else if (currency === "EUR") parts.push(formatEUR(cents, "et"));
  else parts.push(currency ? `${plainAmount(cents)} ${currency}` : plainAmount(cents));
  if (currency === null) parts.push("valuuta puudub");
  return parts.join(", ");
}

/**
 * "Kontrolli Montonios: {nimi}, {mis}, {summa}": nothing was changed by itself; Maria decides. A second paid order of one payment is
 * "Topeltmakse: …" (the money of the second is not counted anywhere: she refunds one of the two in Montonio). So is a payment that came
 * after a järelmaks or before it (`late`, instalments §4 and D5, Draft): the later one is held, and she refunds it in Montonio (a loan's
 * full refund cancels the loan).
 */
export function paymentAlertSummary(a: PaymentAlert, adminUrl: string): Summary {
  const subject = `${a.alert === "double" ? "Topeltmakse" : "Kontrolli Montonios"}: ${a.name}, ${paidFor(a.kind, a.course, a.startsAt)}, ${formatEUR(a.amountCents, "et")}`;
  const refund = a.rawStatus.toUpperCase() === "PARTIALLY_REFUNDED" ? "osaliselt tagastatud" : "tagastatud";
  const said = montonioSaid(a.paidCents, a.currency);
  // a payment that is itself the second one (Draft, instalments §4 and D5): held, not recorded, and refunded in Montonio
  const held = `makse on lehel Maksed "Ootel kontrollil". Tagasta see Montonio halduses`;
  const lateNotes = {
    loan:
      a.kind === "ecourse"
        ? `Järelmaks (Inbank) laekus, kui e-koolitus oli juba tasutud. Seda ei pandud kirja ja ligipääsu ei pikendatud: ${held}: täielik tagastus tühistab järelmaksu.`
        : `Järelmaks (Inbank) laekus, kui koolitus oli juba täies ulatuses tasutud. Seda ei pandud kirja: ${held}: täielik tagastus tühistab järelmaksu.`,
    bank: `Pangamakse laekus, kui e-koolitus oli juba järelmaksuga (Inbank) tasutud. Seda ei pandud kirja ja ligipääsu ei pikendatud: ${held}.`,
  } as const;
  const double = a.late ? lateNotes[a.late] : "Sama makse eest laekus teine tasumine (teine Montonio tellimus). Tagasta üks neist Montonio halduses.";
  // a refunded row that was never counted (Draft): nothing in the admin changes with it, so no sentence about adjusting the sum or the access
  const refundedNote = (counted: string) => `Montonio teatab tagastusest (${refund}). ${a.neverCounted ? "Seda makset ei pandud kirja: adminis pole vaja midagi muuta." : counted}`;
  // a registration has a place and a confirmation to decide about; an e-course only its access
  const notes =
    a.kind === "ecourse"
      ? ({
          held: `Montonio ütleb makstud, aga summa või valuuta ei klapi (Montonio: ${said}). Midagi ei avatud: makse on lehel Maksed "Ootel kontrollil".`,
          voided: "Pank tühistas juba laekunud makse. Ligipääs jäi alles: otsusta, kas lõpetada see (Õpilased).",
          refunded: refundedNote("Laekunud summa ja ligipääs jäid muutmata: muuda ligipääsu adminis (Õpilased), kui vaja."),
          double,
        } as const)
      : ({
          held: `Montonio ütleb makstud, aga summa või valuuta ei klapi (Montonio: ${said}). Midagi ei kinnitatud ega avatud: makse on lehel Maksed "Ootel kontrollil".`,
          voided: "Pank tühistas juba laekunud makse. Kinnitus ja ligipääs jäid alles: otsusta, kas need tühistada (Registreerimised, Õpilased).",
          refunded: refundedNote("Laekunud summa, registreering ja ligipääs jäid muutmata: muuda neid adminis, kui vaja."),
          double,
        } as const);
  return {
    subject,
    text: body(
      subject,
      [
        ["Makse", PAYMENT_KIND[a.kind]],
        ["Summa", formatEUR(a.amountCents, "et")],
        // the second order's own money as Montonio named it (the "Summa" above is what the payment was for)
        ["Teine tasumine", a.alert === "double" ? montonioSaid(a.paidCents, a.currency) : undefined],
        ["Maksja", a.name],
        ["E-post", a.email],
        ["Viide", a.reference],
        ["Montonio", a.providerUuid ?? undefined],
        // the second order, when it is another order of this payment (a late one is its own order, named above)
        ["Montonio", a.alert === "double" && !a.late ? (a.otherUuid ?? undefined) : undefined],
      ],
      adminUrl,
      notes[a.alert],
    ),
    short: subject,
  };
}

// ---------- the course feedback form (phase protocols, spec §6, §7) ----------

/**
 * A student's answers, for Maria's notice. `target`: the registration of a contact course or the access of an e-course (the logs name it).
 * `course` is the course's Estonian title; `startsAt` its session's start (null: an individual course, and every e-course). `publishable`: she
 * ticked the permission to publish her recommend answer (student reviews, D1), which Maria is told.
 */
export type FeedbackNotice = {
  target: { registrationId: number } | { accessId: number };
  name: string;
  email: string;
  course: string;
  startsAt: Date | null;
  answers: FeedbackAnswers;
  publishable: boolean;
};

/** Maria's line when the student allowed publishing (student reviews, D2); „Tagasiside“ is her admin page. */
const PUBLISHABLE_LINE = "Lubab avaldada — vaata „Tagasiside“ lehel.";

/**
 * "Uus tagasiside: {nimi}, {koolitus}, {score}/10" (spec §6; without the score part when none was given): who answered, the course and its
 * day, then every answered question with its answer in Maria's own wording (the form's Estonian texts, et.ts account.feedback, the one place
 * they are written), whatever language the student answered in; the free texts as she wrote them. When she allowed publishing, the line
 * „Lubab avaldada — vaata „Tagasiside“ lehel.“ stands under who and which course (not buried below the answers), and in the Telegram ping.
 */
export function feedbackSummary(f: FeedbackNotice, adminUrl: string): Summary {
  const q = feedbackQuestions(et.account.feedback.questions);
  const subject = `Uus tagasiside: ${f.name}, ${f.course}${f.answers.score !== undefined ? `, ${f.answers.score}/10` : ""}`;
  const answered = FEEDBACK_ORDER.flatMap((key) => {
    const value = f.answers[key];
    return value === undefined ? [] : [q[key].label, answerText(key, value, q), ""];
  });
  const text = [
    subject, "",
    `Õpilane: ${f.name}`, `E-post: ${f.email}`, `Koolitus: ${f.startsAt ? `${f.course}, ${formatDate(f.startsAt, "et")}` : f.course}`, "",
    ...(f.publishable ? [PUBLISHABLE_LINE, ""] : []),
    ...answered,
    `Admin: ${adminUrl}/tagasiside`, "",
  ].join("\n");
  return { subject, text, short: f.publishable ? `${subject}\n${PUBLISHABLE_LINE}` : subject };
}

// ---------- the e-course completion (spec §6: Maria's notices, each with a link to its item) ----------

/** Who and which e-course, for Maria's notices of this phase. `course` is the course's Estonian title. */
export type CompletionNotice = { accessId: number; name: string; email: string; course: string };

/** The rows every notice of this phase starts with: who, her address (the mail's Reply-To too), the course. */
const completionRows = (n: CompletionNotice): Row[] => [
  ["Õpilane", n.name],
  ["E-post", n.email],
  ["Koolitus", n.course],
];

/**
 * "Praktiline töö hindamiseks: {nimi}, {kursus}" (spec §6), with " (2. kord)" from the second submission on: the student sent her practical
 * work, or the points Maria asked her to redo. The link opens its assessment, the protocol screen of the access.
 */
export function practicalSubmittedSummary(n: CompletionNotice & { round: number }, adminUrl: string): Summary {
  const subject = `Praktiline töö hindamiseks: ${n.name}, ${n.course}${n.round > 1 ? ` (${n.round}. kord)` : ""}`;
  return { subject, text: body(subject, [...completionRows(n), ["Saadetud", `${n.round}. kord`]], `${adminUrl}/protokollid?ligipaas=${n.accessId}`), short: subject };
}

/** "Test ootab hindamist: {nimi}, {kursus}" (spec §6): an attempt passed its choice part and its open answers wait for Maria (or were rewritten). */
export function testReviewSummary(n: CompletionNotice & { attemptId: number; number: number }, adminUrl: string): Summary {
  const subject = `Test ootab hindamist: ${n.name}, ${n.course}`;
  return { subject, text: body(subject, [...completionRows(n), ["Katse", `${n.number}.`]], `${adminUrl}/hindamine/test?id=${n.attemptId}`), short: subject };
}

/** "Testi katsed otsas: {nimi}, {kursus}" (spec §6): every allowed try failed; "Ava test uuesti" in Hindamine gives her the course's tries again. */
export function triesUsedSummary(n: CompletionNotice & { tries: number }, adminUrl: string): Summary {
  const subject = `Testi katsed otsas: ${n.name}, ${n.course}`;
  return {
    subject,
    text: body(subject, [...completionRows(n), ["Katseid tehtud", String(n.tries)]], `${adminUrl}/hindamine`, "Uued katsed annab nupp „Ava test uuesti“ lehel Hindamine."),
    short: subject,
  };
}
