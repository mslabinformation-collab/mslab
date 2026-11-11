// Discount codes (F1): the pure rules every layer shares (the server's check and submit, the forms' live price, the admin list). One code
// type for the newsletter's welcome code and the codes Maria makes in Allahindlus. Pure: no database, no React, no `node:` imports and no
// lookbehind (the browser bundle pulls this file in; tests/unit/old-safari.test.ts watches it). Dates are "YYYY-MM-DD" on Tallinn's calendar:
// the caller says what "today" is, so nothing here reads the clock except `useMark`, which is given `now`.

import { formatEUR } from "./money";
import { listPrice, type RegStatus } from "./registration";

/** The longest code. */
export const CODE_MAX = 30;
/** A code that may be stored or typed (after `normalizeCode`): A–Z, 0–9 and "-", 1–30 characters. */
export const CODE_SHAPE = /^[A-Z0-9-]{1,30}$/;
/** What a registration or payment never goes below: 1 €. A discount is cut so that this much is always left to pay. */
export const MIN_TOTAL_CENTS = 100;
/** A percentage code, a whole 1–99. */
export const PERCENT_MIN = 1;
export const PERCENT_MAX = 99;
/** How many days after signing up a welcome code stays valid, a whole 1–365. */
export const DAYS_MIN = 1;
export const DAYS_MAX = 365;
/** A registration that has not been paid still holds its code use for this long (D7's limit rule). */
export const REGISTRATION_USE_MS = 24 * 60 * 60 * 1000;

/** Where a code applies: everywhere, e-courses only, contact courses only, or chosen courses. */
export type CodeScope = "all" | "ecourse" | "contact" | "courses";
/** Who may use it: anyone, people who have not trained with us yet, or people who have. */
export type Audience = "all" | "first" | "returning";

/** A code as the rules see it (dates "YYYY-MM-DD", Tallinn's calendar). */
export type CodeRule = {
  code: string;
  welcome: boolean;
  percent: number | null;
  amountCents: number | null;
  scope: CodeScope;
  courseIds: readonly number[];
  startsOn: string | null;
  endsOn: string | null;
  maxUses: number | null;
  audience: Audience;
  oncePerPerson: boolean;
  daysAfterSignup: number | null;
  active: boolean;
};

// R14: people paste codes with a space inside, a no-break space, zero-width characters or a typographic dash. All whitespace goes, the zero-width
// characters go, every dash variant becomes "-".
const INVISIBLE = /[\s​-‍⁠﻿]+/g;
const DASHES = /[‐-―−﹘﹣－]/g;

/** As typed → as stored: no whitespace or zero-width characters, dash variants as "-", in capitals. */
export function normalizeCode(typed: string): string {
  return typed.replace(INVISIBLE, "").replace(DASHES, "-").toUpperCase();
}

/** A normalized code that may be stored: the right shape, and with at least one letter or digit ("---" is not a code). */
export const isCode = (s: string): boolean => CODE_SHAPE.test(s) && /[A-Z0-9]/.test(s);

/** What the code takes off a list price, in cents: the percentage rounded to the cent, or the euros; never more than leaves 1 €. */
export function discountCents(code: Pick<CodeRule, "percent" | "amountCents">, listCents: number): number {
  const raw = code.percent !== null ? Math.round((listCents * code.percent) / 100) : (code.amountCents ?? 0);
  return Math.min(raw, Math.max(listCents - MIN_TOTAL_CENTS, 0));
}

/** The price after a discount in cents; the 1 € floor applies, and a list of 1 € or less is never raised. */
export function totalWith(listCents: number, discountCents: number): number {
  return listCents - Math.min(discountCents, Math.max(listCents - MIN_TOTAL_CENTS, 0));
}

type PriceCourse = Parameters<typeof listPrice>[0];

/**
 * The list price a discount code applies to: for an e-course its price, for a contact course the group price (a code is looked up before the
 * kind is known); null when the course has no such price. Later tasks read list prices only through it.
 */
export function listCentsOf(course: PriceCourse): number | null {
  return listPrice(course, "group");
}

/** A registration's total: its live list price minus the euros frozen on it; null when the course has no such price. */
export function registrationTotal(course: PriceCourse, r: { kind: "group" | "individual"; discountCents: number }): number | null {
  const list = listPrice(course, r.kind);
  return list === null ? null : totalWith(list, r.discountCents);
}

/** What to show of a registration's discount: its code, the list price and the euros taken off (list − cents = total); else null. */
export function registrationDiscount(
  course: PriceCourse,
  r: { kind: "group" | "individual"; discountCents: number; discountCode: string },
): { code: string; listCents: number; cents: number } | null {
  if (r.discountCode === "" || r.discountCents === 0) return null;
  const list = listPrice(course, r.kind);
  if (list === null) return null;
  const total = totalWith(list, r.discountCents);
  return { code: r.discountCode, listCents: list, cents: list - total };
}

/** Why a code does not apply to this course, whoever asks. */
export type CodeRefusal = "paused" | "ended" | "notYet" | "scope" | "usedUp";

/** What a code says about a course and a day, before anything about the person: the first refusal, or null. */
export function codeRefusal(
  code: CodeRule,
  at: { courseId: number; courseType: "e_learning" | "contact"; listCents: number; today: string; uses: number },
): CodeRefusal | null {
  if (!code.active) return "paused";
  if (code.endsOn !== null && code.endsOn < at.today) return "ended";
  if (code.startsOn !== null && code.startsOn > at.today) return "notYet";
  const inScope =
    code.scope === "all" ||
    (code.scope === "ecourse" && at.courseType === "e_learning") ||
    (code.scope === "contact" && at.courseType === "contact") ||
    (code.scope === "courses" && code.courseIds.includes(at.courseId));
  if (!inScope || discountCents(code, at.listCents) === 0) return "scope";
  if (code.maxUses !== null && at.uses >= code.maxUses) return "usedUp";
  return null;
}

/** What the rules need to know about the person. */
export type PersonFacts = { uses: number; trained: boolean; subscribedOn: string | null };
export type PersonRefusal = "used" | "first" | "returning" | "subscriber" | "expired";

/** What a code says about the person: the first refusal, or null. `subscribing` is true when this very submit signs them up to the newsletter. */
export function personRefusal(code: CodeRule, facts: PersonFacts, at: { subscribing: boolean; today: string }): PersonRefusal | null {
  if (code.oncePerPerson && facts.uses > 0) return "used";
  if (code.audience === "first" && facts.trained) return "first";
  if (code.audience === "returning" && !facts.trained) return "returning";
  if (code.welcome && facts.subscribedOn === null && !at.subscribing) return "subscriber";
  if (code.welcome && code.daysAfterSignup !== null && facts.subscribedOn !== null && addDays(facts.subscribedOn, code.daysAfterSignup) < at.today) return "expired";
  return null;
}

/** A day plus n days ("2026-11-30" + 2 → "2026-12-02"), on the calendar: no clock, no time zone. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Active and inside its dates, both days included. */
export function validOn(code: Pick<CodeRule, "active" | "startsOn" | "endsOn">, today: string): boolean {
  return code.active && (code.startsOn === null || code.startsOn <= today) && (code.endsOn === null || code.endsOn >= today);
}

/** The code's value as the admin and the forms say it: "10%", "15 €", "15,50 €". */
export function codeValueText(code: Pick<CodeRule, "percent" | "amountCents">): string {
  return code.percent !== null ? `${code.percent}%` : formatEUR(code.amountCents ?? 0, "et");
}

/** Where a code stands in the admin list; the first that holds: paused, ended, upcoming, full, active. */
export type CodeState = "active" | "paused" | "upcoming" | "ended" | "full";

export function codeState(code: CodeRule, today: string, uses: number): CodeState {
  if (!code.active) return "paused";
  if (code.endsOn !== null && code.endsOn < today) return "ended";
  if (code.startsOn !== null && code.startsOn > today) return "upcoming";
  if (code.maxUses !== null && uses >= code.maxUses) return "full";
  return "active";
}

/** One use of a code as the admin's use list marks it; "counts" is what counts against the code's limit (D7). */
export type UseMark = "counts" | "cancelled" | "unpaid" | "pending" | "failed" | "refunded" | "gone";

export function useMark(
  use: {
    registration: { status: RegStatus; paidCents: number; createdAt: Date } | null;
    // `accessKept`: a course_access, not revoked, for the payment's client and course (R15): a refund that left the access still counts.
    payment: { status: "pending" | "paid" | "failed" | "refunded" | "held" | "replaced"; inWindow: boolean; accessKept: boolean } | null;
  },
  now: Date,
): UseMark {
  const r = use.registration;
  if (r) {
    if (r.status === "cancelled") return "cancelled";
    if (r.status === "confirmed" || r.paidCents > 0 || now.getTime() - r.createdAt.getTime() < REGISTRATION_USE_MS) return "counts";
    return "unpaid";
  }
  const p = use.payment;
  if (p) {
    if (p.status === "paid" || p.status === "held") return "counts";
    if (p.status === "pending") return p.inWindow ? "counts" : "pending";
    if (p.status === "replaced") return "pending";
    if (p.status === "failed") return "failed";
    return p.accessKept ? "counts" : "refunded";
  }
  return "gone";
}

/** The small note a form shows under a code that was made for a kind of person: the welcome code, new trainees, returning ones; else none. */
export function codeHint(c: { welcome: boolean; audience: Audience }): "welcome" | "first" | "returning" | null {
  if (c.welcome) return "welcome";
  return c.audience === "all" ? null : c.audience;
}

/** Why a code check came back without a price. */
export type CheckError = "empty" | "unknown" | CodeRefusal | "rate" | "server";
/** The check's answer to the form. */
export type CheckAnswer =
  | { ok: true; code: string; discountCents: number; totalCents: number; value: string; audience: Audience; welcome: boolean }
  | { ok: false; error: CheckError; startsOn?: string };
/** Why a submit with a code is refused. */
export type SubmitCodeError = "unknown" | CodeRefusal | "person" | "changed";
