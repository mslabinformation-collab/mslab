import { and, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import type { Q, Tx } from "@/db/client";
import { attemptEnds } from "@/db/queries/payments";
import { discountCodeCourses, discountCodes, discountRedemptions, subscribers, type DiscountCode } from "@/db/schema";
import { tallinnToday } from "@/domain/client-access";
import { normalizeEmail } from "@/domain/email";
import {
  codeRefusal,
  codeValueText,
  discountCents,
  isCode,
  normalizeCode,
  personRefusal,
  REGISTRATION_USE_MS,
  validOn,
  type CodeRule,
  type PersonFacts,
  type SubmitCodeError,
} from "@/domain/discount-codes";

// Discount codes (F1), the server's core: find a typed code, lock it, count its uses, read what the rules need to know about a person, and
// check a submit (`redeem`). The pure rules are domain/discount-codes.ts; the callers (the registration submit, the e-course start, the
// admin's „Lisa sooduskood“) run `redeem` and `insertRedemption` in their own transaction, under the lock order of db/queries/seats.ts.

/** A code row with the ids of its chosen courses (scope `courses`; empty otherwise). */
export type StoredCode = DiscountCode & { courseIds: number[] };

/** The stored code as the pure rules see it. */
export const ruleOf = (c: StoredCode): CodeRule => ({
  code: c.code,
  welcome: c.welcome,
  percent: c.percent,
  amountCents: c.amountCents,
  scope: c.scope,
  courseIds: c.courseIds,
  startsOn: c.startsOn,
  endsOn: c.endsOn,
  maxUses: c.maxUses,
  audience: c.audience,
  oncePerPerson: c.oncePerPerson,
  daysAfterSignup: c.daysAfterSignup,
  active: c.active,
});

async function withCourses(q: Q, row: DiscountCode): Promise<StoredCode> {
  const chosen = await q.select({ courseId: discountCodeCourses.courseId }).from(discountCodeCourses).where(eq(discountCodeCourses.codeId, row.id));
  return { ...row, courseIds: chosen.map((c) => c.courseId).sort((a, b) => a - b) };
}

/** The code a person typed (any spelling normalizeCode accepts), or null: not a code's shape, or no such code. Takes no lock. */
export async function findCode(q: Q, typed: string): Promise<StoredCode | null> {
  const code = normalizeCode(typed);
  if (!isCode(code)) return null;
  const [row] = await q.select().from(discountCodes).where(eq(discountCodes.code, code)).limit(1);
  return row ? withCourses(q, row) : null;
}

/**
 * The code's row locked `for no key update` until the caller's transaction ends (D8: every use is written under it), with its courses; null when
 * it is gone. `no key update`, not `update`: another transaction's insert into discount_redemptions takes a key-share lock on the code row (its
 * foreign key), which this lock does not block.
 */
export async function lockCode(tx: Tx, id: number): Promise<StoredCode | null> {
  const [row] = await tx.select().from(discountCodes).where(eq(discountCodes.id, id)).for("no key update");
  return row ? withCourses(tx, row) : null;
}

// (postgres-js answers an array, PGlite {rows}.)
const rowsOf = (result: unknown): Record<string, unknown>[] => (Array.isArray(result) ? result : ((result as { rows?: Record<string, unknown>[] }).rows ?? []));
const ts = (when: Date) => sql`${when.toISOString()}::timestamptz`;

/** R15: the payment `p` was refunded but its buyer's access to the course is still open (not revoked), so the use is still held. */
const accessKept = sql`exists (select 1 from course_access ca where ca.client_id = p.client_id and ca.course_id = p.course_id and ca.revoked_at is null)`;

/**
 * D7's limit rule, a condition over the uses `d` (discount_redemptions) left-joined to their registration `r` and payment `p`: what counts against
 * a code's `max_uses` at `now`. A registration counts unless cancelled, and then when it is confirmed, has money paid or is under 24 hours old
 * (an unpaid one holds the use for REGISTRATION_USE_MS); an e-course payment counts when paid or held, or pending inside its attempt window
 * (db/queries/payments.ts attemptEnds, which reads `p.updated_at` and `p.method`: hence the raw aliases). R15: a refunded payment counts too
 * while its access is not revoked. A use carrying both ids is judged by its registration, as useMark does (the payment branch needs
 * `d.registration_id is null`). A use whose registration or payment is gone counts for nothing. domain/discount-codes.ts useMark is the same
 * rule for one use in memory; a test holds them equal.
 */
export function countingUse(now: Date): SQL {
  const since = ts(new Date(now.getTime() - REGISTRATION_USE_MS));
  return sql`(
    (d.registration_id is not null and r.status <> 'cancelled' and (r.status = 'confirmed' or r.paid_cents > 0 or r.created_at > ${since}))
    or (d.registration_id is null and d.payment_id is not null and (p.status in ('paid', 'held') or (p.status = 'pending' and ${attemptEnds} > ${ts(now)}) or (p.status = 'refunded' and ${accessKept})))
  )`;
}

/** The uses `d` with their registration `r` and payment `p`: countingUse works only over this join (the admin's use list reuses it). */
export const useJoins = sql`discount_redemptions d left join registrations r on r.id = d.registration_id left join payments p on p.id = d.payment_id`;

/** How many uses of the code count against its limit at `now` (D7). */
export async function usesOf(q: Q, codeId: number, now: Date): Promise<number> {
  const result = await q.execute(sql`select count(*)::int as n from ${useJoins} where d.code_id = ${codeId} and ${countingUse(now)}`);
  return Number(rowsOf(result)[0]?.n ?? 0);
}

/**
 * What the rules need to know about the person behind `email` (already normalizeEmail'd by the caller, D6) when she uses code `at.codeId` for
 * course `at.courseId`:
 * - `uses`: her uses of this code that count for once per person: a registration that is not cancelled, except an unpaid, unconfirmed one of this
 *   very course (she may take the form again), and a paid or held payment, or a refunded one whose access is kept (R15), or (S1) a pending payment of another course inside its window, so that two tabs on two e-courses cannot both
 *   use a once-per-person code; a not-paid payment of this very course is left out (her re-pay after Back or a failure gets the code again). Unlike usesOf, no
 *   24-hour window: an old unpaid booking of another course keeps her use;
 * - `trained`: she has a confirmed or part-paid booking, a paid e-course, or an open access (audience „first“ / „returning“);
 * - `subscribedOn`: the Tallinn day of her newsletter consent, when confirmed; else null (the welcome code).
 */
export async function personFacts(q: Q, typedEmail: string, at: { codeId: number; courseId: number }, now: Date): Promise<PersonFacts> {
  const email = normalizeEmail(typedEmail); // (idempotent: the callers pass it normalized, D6)
  const uses = rowsOf(
    await q.execute(sql`
      select count(*)::int as n from ${useJoins}
      where d.code_id = ${at.codeId} and d.email = ${email} and (
        (d.registration_id is not null and r.status <> 'cancelled' and not (r.course_id = ${at.courseId} and r.paid_cents = 0 and r.status <> 'confirmed'))
        or (d.registration_id is null and d.payment_id is not null and (
          p.status in ('paid', 'held')
          or (p.status = 'refunded' and ${accessKept})
          or (p.status = 'pending' and p.course_id <> ${at.courseId} and ${attemptEnds} > ${ts(now)})
        ))
      )`),
  )[0]?.n;
  const trained = rowsOf(
    await q.execute(sql`
      select (
        exists (select 1 from registrations r where r.email = ${email} and r.status <> 'cancelled' and (r.status = 'confirmed' or r.paid_cents > 0))
        or exists (select 1 from payments p where p.email = ${email} and p.kind = 'ecourse' and p.status = 'paid')
        or exists (select 1 from course_access ca join clients c on c.id = ca.client_id where c.email = ${email} and ca.revoked_at is null)
      ) as trained`),
  )[0]?.trained;
  const [sub] = await q
    .select({ consentAt: subscribers.consentAt })
    .from(subscribers)
    .where(and(sql`lower(${subscribers.email}) = ${email}`, isNotNull(subscribers.confirmedAt)))
    .limit(1);
  return { uses: Number(uses ?? 0), trained: trained === true, subscribedOn: sub ? tallinnToday(sub.consentAt) : null };
}

export type RedeemInput = {
  typed: string;
  /** The discount the form showed, in cents; null when it showed none. */
  shownCents: number | null;
  /** normalizeEmail'd. */
  email: string;
  courseId: number;
  courseType: "e_learning" | "contact";
  listCents: number;
  /** True when this very submit signs the person up to the newsletter. */
  subscribing: boolean;
};
export type Redeemed = { ok: true; codeId: number; code: string; discountCents: number } | { ok: false; error: SubmitCodeError };

/**
 * The submit's check of a typed code, in the caller's transaction (D8): finds it, locks it, and runs the rules in order: the code's (unknown,
 * paused, ended, notYet, scope, usedUp), the person's (any reason: `person`), then whether the discount still equals what the form showed
 * (`changed`: also when the form showed none). The lock stays until the transaction ends, so the caller's insert of the use is ordered with
 * every other one.
 */
export async function redeem(tx: Tx, rawInput: RedeemInput, now: Date): Promise<Redeemed> {
  const input = { ...rawInput, email: normalizeEmail(rawInput.email) }; // (idempotent, D6)
  const found = await findCode(tx, input.typed);
  if (!found) return { ok: false, error: "unknown" };
  const c = await lockCode(tx, found.id);
  if (!c) return { ok: false, error: "unknown" };
  const today = tallinnToday(now);
  const rule = ruleOf(c);
  const refusal = codeRefusal(rule, { courseId: input.courseId, courseType: input.courseType, listCents: input.listCents, today, uses: await usesOf(tx, c.id, now) });
  if (refusal) return { ok: false, error: refusal };
  const facts = await personFacts(tx, input.email, { codeId: c.id, courseId: input.courseId }, now);
  if (personRefusal(rule, facts, { subscribing: input.subscribing, today })) return { ok: false, error: "person" };
  const d = discountCents(rule, input.listCents);
  if (input.shownCents === null || input.shownCents !== d) return { ok: false, error: "changed" };
  return { ok: true, codeId: c.id, code: c.code, discountCents: d };
}

/** Writes one use, with `email` as the caller normalized it (D6). Under the code's lock (redeem's), in the caller's transaction. */
export async function insertRedemption(
  tx: Q,
  row: { codeId: number; email: string; clientId: number | null; courseId: number; registrationId?: number; paymentId?: number; listCents: number; discountCents: number; via: "form" | "cart" | "admin" },
  now: Date,
): Promise<void> {
  await tx.insert(discountRedemptions).values({ ...row, createdAt: now });
}

export type WelcomeCode = { code: string; value: string; days: number | null };

/**
 * The newsletter's welcome code for the sign-up mail and page: the `welcome` row, when it is active and inside its dates today. R10: its scope,
 * course and uses are not checked here: the mail names the code whatever the reader will buy, and the submit decides (redeem), so a welcome code
 * that fits no course is still sent, and a full one too. Null when there is none or it is not valid today.
 */
export async function welcomeCode(q: Q, now: Date): Promise<WelcomeCode | null> {
  const [row] = await q.select().from(discountCodes).where(eq(discountCodes.welcome, true)).limit(1);
  if (!row || !validOn(row, tallinnToday(now))) return null;
  return { code: row.code, value: codeValueText(row), days: row.daysAfterSignup };
}
