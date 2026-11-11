import type { RegStatus } from "./registration";

export type SeatState = "open" | "few" | "full" | "cancelled";

/** How long an unpaid registration holds its seat (phase 2b, D2): Montonio's payment window, 30 minutes. */
export const SEAT_HOLD_MS = 30 * 60_000;

/**
 * The end of a hold that starts `now` and lasts `ms`: the bank's SEAT_HOLD_MS by default, or the attempt's own window (a järelmaks attempt
 * holds its seat for 60 minutes: domain/financing.ts attemptWindowMs).
 */
export const holdUntil = (now: Date, ms: number = SEAT_HOLD_MS): Date => new Date(now.getTime() + ms);

/**
 * Does a registration take a seat at `now` (phase 2b, spec 5.3)? Confirmed, or awaiting its prepayment with a hold that has not ended.
 * The database counts with the same rule (db/queries/seats.ts takesSeat); tests/db/seats.test.ts checks that the two agree.
 */
export function holdsSeat(r: { status: RegStatus; seatHoldUntil: Date | null }, now: Date): boolean {
  if (r.status === "confirmed") return true;
  return r.status === "awaiting_prepayment" && r.seatHoldUntil !== null && r.seatHoldUntil.getTime() > now.getTime();
}

/** Seats left when `taken` are taken (confirmed registrations and live holds). */
export function seatsLeft(capacity: number, taken: number): number {
  return Math.max(0, capacity - taken);
}

/** How full a session is, 0–100 (the admin's seat bar, UX pass 11.11 A2): the taken seats of the capacity, as the free seats count them; full is 100. */
export function seatFill(capacity: number, taken: number): number {
  if (seatsLeft(capacity, taken) === 0) return 100;
  return Math.min(100, Math.round((taken / capacity) * 100));
}

export function seatState(s: { status: "scheduled" | "cancelled"; capacity: number }, taken: number): SeatState {
  if (s.status === "cancelled") return "cancelled";
  const left = seatsLeft(s.capacity, taken);
  return left === 0 ? "full" : left <= 2 ? "few" : "open";
}
