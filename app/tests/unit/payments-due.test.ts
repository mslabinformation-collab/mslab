import { describe, expect, test } from "vitest";
import { amountDue, type DueInput } from "@/domain/payments";

// What a registration can pay online now (phase 2b, spec 6.3, D5): the prepayment still due while it is not confirmed and the session has not
// begun; the rest once it is confirmed, until the training day (in Tallinn); nothing for a cancelled one, a called-off session, no price or no
// session (an individual registration: Maria sends an invoice, spec 11).

const NOW = new Date("2026-10-09T10:00:00Z");
// 14.11.2026 at 10:00 in Tallinn (UTC+2 in November): the training day starts at 2026-11-13T22:00:00Z
const START = new Date("2026-11-14T08:00:00Z");
const base: DueInput = { status: "awaiting_prepayment", paymentChoice: "half", priceCents: 35000, paidCents: 0, startsAt: START, sessionCancelled: false };
const due = (over: Partial<DueInput>, now = NOW) => amountDue({ ...base, ...over }, now);

describe("amountDue", () => {
  test("not confirmed: the prepayment minus what is paid (half 175 €, full 350 €); paid enough: nothing", () => {
    expect(due({})).toEqual({ kind: "prepayment", cents: 17500 });
    expect(due({ paymentChoice: "full" })).toEqual({ kind: "prepayment", cents: 35000 });
    expect(due({ paidCents: 10000 })).toEqual({ kind: "prepayment", cents: 7500 });
    expect(due({ paidCents: 17500 })).toEqual({ kind: "none" });
    expect(due({ priceCents: 35001 })).toEqual({ kind: "prepayment", cents: 17501 }); // ceil(price / 2)
  });

  test("confirmed: the rest; fully paid: nothing", () => {
    expect(due({ status: "confirmed", paidCents: 17500 })).toEqual({ kind: "balance", cents: 17500 });
    expect(due({ status: "confirmed", paidCents: 35000 })).toEqual({ kind: "none" });
  });

  test("cancelled, a called-off session, no price, no session: nothing", () => {
    for (const over of [{ status: "cancelled" as const }, { sessionCancelled: true }, { priceCents: null }, { startsAt: null }]) expect(due(over), JSON.stringify(over)).toEqual({ kind: "none" });
  });

  test("the prepayment until the session begins; the rest until its day begins in Tallinn", () => {
    expect(due({}, new Date(START.getTime() - 1))).toEqual({ kind: "prepayment", cents: 17500 });
    expect(due({}, START)).toEqual({ kind: "none" });
    const rest = { status: "confirmed" as const, paidCents: 17500 };
    expect(due(rest, new Date("2026-11-13T21:59:59Z"))).toEqual({ kind: "balance", cents: 17500 });
    expect(due(rest, new Date("2026-11-13T22:00:00Z"))).toEqual({ kind: "none" });
  });
});
