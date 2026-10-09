// Plain-text summaries of public submissions for Maria: the e-mail (subject + text) and a short Telegram line.
// They are written in Estonian for Maria and never shown to visitors, so they are not in the site dictionaries.

import type { PaymentKind } from "@/db/schema";
import { formatEUR } from "@/domain/money";
import { paymentMethodLabel } from "@/domain/payments";
import { formatDate } from "@/i18n/format";

export type Summary = { subject: string; text: string; short: string };

/** label, value, and whether the value goes on its own lines below the label (free text). */
type Row = readonly [label: string, value: string | undefined, block?: boolean];

const TIME_ZONE = "Europe/Tallinn";
const LANGUAGE = { et: "eesti", ru: "vene" } as const;
const PAYMENT = { full: "100% kohe", half: "50% registreerimisel + 50% koolituspäeval" } as const;

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
  s: SessionInfo & Visitor & { paymentChoice: "full" | "half"; wantsModelHelp: boolean; wantsAccount: boolean; message: string },
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

/** What a payment was for: "Kulmumeistri baaskoolitus, 14.11.2026" (a registration's session day), or the e-course's title alone. */
const paidFor = (course: string, startsAt: Date | null): string => (startsAt ? `${course}, ${formatDate(startsAt, "et")}` : course);

/** A paid payment, for Maria's notice. `outcome`: what it did (settle.ts). `restCents`: left to pay on the registration afterwards. */
export type PaymentNotice = {
  kind: PaymentKind;
  name: string;
  email: string;
  amountCents: number;
  course: string;
  startsAt: Date | null;
  /** Montonio's code of the way of paying and the bank's name: shown as Maria's word (paymentMethodLabel). */
  method: string;
  bank: string;
  reference: string;
  providerUuid: string | null;
  outcome: "confirmed" | "received" | "full" | "opened" | "notOpened";
  restCents?: number;
};

/** "Uus makse: {nimi}, {mis}, {summa}" (spec 9), or "Makse laekus, aga koolitus on täis: …" when the course was full (D2). */
export function paymentSummary(p: PaymentNotice, adminUrl: string): Summary {
  const amount = formatEUR(p.amountCents, "et");
  const what = paidFor(p.course, p.startsAt);
  const subject = `${p.outcome === "full" ? "Makse laekus, aga koolitus on täis" : "Uus makse"}: ${p.name}, ${what}, ${amount}`;
  const rest = p.restCents ?? 0;
  const notes: Record<PaymentNotice["outcome"], string> = {
    confirmed: rest > 0 ? `Registreering on kinnitatud. Ülejäänud ${formatEUR(rest, "et")} tasub ta koolituspäeval või Minu koolitustes.` : "Registreering on kinnitatud ja täielikult tasutud.",
    received: "Makse on registreeringule kirja pandud.",
    full: "Koolitus on täis: koht jäi kinnitamata, makse on registreeringule kirja pandud. Võta õpilasega ühendust (Registreerimised).",
    opened: "E-koolitus on avatud.",
    notOpened: "E-koolitust ei avatud: koolitust ei leitud. Ava ligipääs käsitsi (Õpilased) või tagasta raha Montonios.",
  };
  return {
    subject,
    text: body(
      subject,
      [
        ["Makse", PAYMENT_KIND[p.kind]],
        ["Summa", amount],
        ["Koolitus", what],
        ["Maksja", p.name],
        ["E-post", p.email],
        ["Makseviis", paymentMethodLabel(p.method, p.bank)],
        ["Viide", p.reference],
        ["Montonio", p.providerUuid ?? undefined],
      ],
      adminUrl,
      notes[p.outcome],
    ),
    short: subject,
  };
}

/** A payment Maria must look at in Montonio's own dashboard (spec 7.3, 7.4, 8). `paidCents` and `currency`: what Montonio said. */
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
  /** Montonio's status (upper case); only told apart as PARTIALLY_REFUNDED and the rest, and never shown. */
  rawStatus: string;
  paidCents: number | null;
  currency: string | null;
};

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
 * "Topeltmakse: …" (the money of the second is not counted anywhere: she refunds one of the two in Montonio).
 */
export function paymentAlertSummary(a: PaymentAlert, adminUrl: string): Summary {
  const subject = `${a.alert === "double" ? "Topeltmakse" : "Kontrolli Montonios"}: ${a.name}, ${paidFor(a.course, a.startsAt)}, ${formatEUR(a.amountCents, "et")}`;
  const refund = a.rawStatus.toUpperCase() === "PARTIALLY_REFUNDED" ? "osaliselt tagastatud" : "tagastatud";
  const notes = {
    held: `Montonio ütleb makstud, aga summa või valuuta ei klapi (Montonio: ${montonioSaid(a.paidCents, a.currency)}). Midagi ei kinnitatud ega avatud: makse on lehel Maksed "Ootel kontrollil".`,
    voided: "Pank tühistas juba laekunud makse. Kinnitus ja ligipääs jäid alles: otsusta, kas need tühistada (Registreerimised, Õpilased).",
    refunded: `Montonio teatab tagastusest (${refund}). Laekunud summa, registreering ja ligipääs jäid muutmata: muuda neid adminis, kui vaja.`,
    double: "Sama makse eest laekus teine tasumine (teine Montonio tellimus). Tagasta üks neist Montonio halduses.",
  } as const;
  return {
    subject,
    text: body(
      subject,
      [
        ["Makse", PAYMENT_KIND[a.kind]],
        ["Summa", formatEUR(a.amountCents, "et")],
        ["Maksja", a.name],
        ["E-post", a.email],
        ["Viide", a.reference],
        ["Montonio", a.providerUuid ?? undefined],
        ["Montonio", a.alert === "double" ? (a.otherUuid ?? undefined) : undefined],
      ],
      adminUrl,
      notes[a.alert],
    ),
    short: subject,
  };
}
