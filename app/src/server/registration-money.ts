import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { addRegistrationPayment } from "@/db/queries/admin";
import { lockForPayment } from "@/db/queries/seats";
import { courses, registrations } from "@/db/schema";
import { tallinnToday } from "@/domain/client-access";
import { paidDay, type ManualPaidMethod } from "@/domain/invoice";
import { registrationPrice, type RegStatus } from "@/domain/registration";
import { issueReceiptInTx } from "./invoices";

// Maria's one money path (admin UX pass B4, spec §9–§10; README A2 drawer 2): „Lisa laekumine“ on a registration's Raha card adds money that came in
// outside the site — a bank transfer, cash or a card at the venue — with an explicit amount, the day and the way, and optionally its receipt. It
// replaces the typed „Laekunud summa“ field, which set an absolute total with no seat check. Without Next.js (server/actions/admin.ts wraps it):
// tests/db/registration-money.test.ts runs it on a real (PGlite) database. Logs carry ids and numbers only, never a name, an e-mail or an amount.

/**
 * The panel's press: `cents` received on `paidOn` ("YYYY-MM-DD", Tallinn's calendar) by `method`, with a receipt („Koosta kviitung“) or not;
 * `expectedPaidCents` is the paid total the panel was built on (Laekunud summa as the drawer showed it).
 */
export type ManualPaymentInput = { registrationId: number; cents: number; paidOn: string; method: ManualPaidMethod; receipt: boolean; expectedPaidCents: number };

/**
 * What a press did. `ok`: `addedCents` added, the paid total and the status now; `confirmedNow` the press confirmed the place (it was not
 * confirmed before); `full` it reached 50 % but the session had no free seat, so the place stayed unconfirmed (D2); `receiptNumber` the receipt's
 * number, null without one. Refusals, nothing written: `notFound`; `cancelled` (the panel is hidden there); `invalid` (an input that is none of
 * the above); `future` (a day after today in Tallinn); `overRemainder` (more than the price leaves open: piece2-texts S3-e); `stale` (the paid
 * total moved since the panel was built: another tab, an online payment); `sellerMissing` (a receipt asked while Seaded → Arve andmed has no
 * seller: the money is not added either).
 */
export type ManualPaymentResult =
  | { ok: true; addedCents: number; paidCents: number; status: RegStatus; confirmedNow: boolean; full: boolean; receiptNumber: string | null }
  | { ok: false; error: "notFound" | "cancelled" | "invalid" | "future" | "overRemainder" | "stale" | "sellerMissing" };

/** What the drawer's action answers: the press's result, or `server` for a throw (logged by the registration's id and the error's class only). */
export type ManualPaymentAnswer = ManualPaymentResult | { ok: false; error: "server" };

type Refusal = Extract<ManualPaymentResult, { ok: false }>["error"];

/** The largest value of the integer columns (registrations.paid_cents, invoices.amount_cents). */
const INT4_MAX = 2_147_483_647;
const METHODS: readonly ManualPaidMethod[] = ["bank", "cash", "card"];

/** A whole number from `min` to INT4_MAX. */
const wholeFrom = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= INT4_MAX;

/** A refusal inside the transaction once something may have been written: thrown, so the transaction rolls back, and answered as itself. */
class Refused extends Error {
  constructor(readonly error: Refusal) {
    super(error);
  }
}

/**
 * „Lisa laekumine“ (B4). `invalid` and `future` before anything is read. Then ONE transaction under the payment locks (lockForPayment: the
 * session, then the registration — the order every payment path takes, so the seats are counted under the session's lock):
 * 1. the registration re-read (`notFound`; `cancelled`);
 * 2. Review Focus 2: its paid total compared with `expectedPaidCents` — any difference is `stale` (the press was built on an old total);
 * 3. a course with a price: `cents` above price − paid is `overRemainder`; without a price nothing is checked (and step 4 leaves the status);
 * 4. the amount added as an online payment adds it (db/queries/admin.ts addRegistrationPayment): confirmed from 50 %, never taken back, and not
 *    confirmed when the session has no free seat for it (`full`);
 * 5. with `receipt`, its „Juba tasutud“ invoice for exactly `cents`, paid on `paidOn` (paidDay: today is now, another day its Tallinn noon) by
 *    `method`, `paidAdds` (server/invoices.ts issueReceiptInTx; its undo takes the amount back). No seller: `sellerMissing`, and the money of
 *    step 4 is rolled back with it — all or nothing.
 * Logs `[registrations] registration N: payment added by hand` (with the receipt's number) after the commit.
 */
export async function addManualPayment(db: Db, input: ManualPaymentInput, now: Date): Promise<ManualPaymentResult> {
  const { registrationId, cents, paidOn, method, receipt, expectedPaidCents } = input;
  const paidAt = paidDay(paidOn, now);
  if (!wholeFrom(registrationId, 1) || !wholeFrom(cents, 1) || !wholeFrom(expectedPaidCents, 0) || !METHODS.includes(method) || typeof receipt !== "boolean" || !paidAt) {
    return { ok: false, error: "invalid" };
  }
  if (paidOn > tallinnToday(now)) return { ok: false, error: "future" };
  let result: ManualPaymentResult;
  try {
    result = await db.transaction(async (tx): Promise<ManualPaymentResult> => {
      await lockForPayment(tx, registrationId);
      const [found] = await tx
        .select({ registration: registrations, course: courses })
        .from(registrations)
        .innerJoin(courses, eq(registrations.courseId, courses.id))
        .where(eq(registrations.id, registrationId))
        .limit(1);
      if (!found) return { ok: false, error: "notFound" };
      const { registration: r, course } = found;
      if (r.status === "cancelled") return { ok: false, error: "cancelled" };
      if (r.paidCents !== expectedPaidCents) return { ok: false, error: "stale" };
      const price = registrationPrice(course, r.kind);
      if (price !== null && cents > price - r.paidCents) return { ok: false, error: "overRemainder" };
      // (a course without a price has no remainder to keep the total under: its column must still hold it)
      if (r.paidCents + cents > INT4_MAX) return { ok: false, error: "invalid" };
      const added = await addRegistrationPayment(tx, registrationId, cents, now);
      if (!added) throw new Refused("notFound");
      const made = receipt ? await issueReceiptInTx(tx, added, { cents, paidAt, method }, now) : null;
      if (made === "sellerMissing") throw new Refused("sellerMissing");
      const { registration: after } = added;
      return {
        ok: true,
        addedCents: cents,
        paidCents: after.paidCents,
        status: after.status,
        confirmedNow: !added.wasConfirmed && after.status === "confirmed",
        full: added.full,
        receiptNumber: made?.number ?? null,
      };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.error };
    throw e;
  }
  if (result.ok) {
    const receiptPart = result.receiptNumber ? `, receipt ${result.receiptNumber}` : "";
    console.info(`[registrations] registration ${registrationId}: payment added by hand${receiptPart}${result.full ? " (the session is full: not confirmed)" : ""}`);
  }
  return result;
}

/** A whole number written as digits only (no sign, space, point or exponent), up to INT4_MAX; NaN for anything else (addManualPayment: `invalid`). */
function digits(v: FormDataEntryValue | null): number {
  if (typeof v !== "string" || !/^\d{1,10}$/.test(v)) return Number.NaN;
  const n = Number(v);
  return n <= INT4_MAX ? n : Number.NaN;
}

const text = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v : "");

/**
 * The panel's form as addManualPayment takes it: `registrationId`, `cents` (the amount in cents: a pill's, or „Muu summa“ as the panel read it),
 * `paidOn` ("YYYY-MM-DD"), `method` (bank | cash | card), `receipt` ("1" or "on" when „Koosta kviitung“ is ticked; absent when not) and
 * `expectedPaidCents` (the paid total the panel showed). What is no such value is passed on as it is (NaN for a number), for addManualPayment's
 * own `invalid` — and so is a call with no form at all (a crafted request to the action: every field missing, the B4 review's m3).
 */
export function manualPaymentForm(formData: unknown): ManualPaymentInput {
  const get = (name: string): FormDataEntryValue | null => (formData instanceof FormData ? formData.get(name) : null);
  const receipt = get("receipt");
  return {
    registrationId: digits(get("registrationId")),
    cents: digits(get("cents")),
    paidOn: text(get("paidOn")),
    method: text(get("method")) as ManualPaidMethod,
    receipt: receipt === "1" || receipt === "on",
    expectedPaidCents: digits(get("expectedPaidCents")),
  };
}
