import { describe, expect, test } from "vitest";
import { formatEUR } from "@/domain/money";
import { priceOptions, fromPrice, participationKinds } from "@/domain/course";
import { prepaymentDue, registrationStatusAfterPayment } from "@/domain/registration";
import { holdsSeat, holdUntil, SEAT_HOLD_MS, seatsLeft, seatState } from "@/domain/sessions";
import { recommend } from "@/domain/recommend";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const base = { id: 1, slug: "a", level: "basic", published: true, sort: 0, recommendationIds: [] } as any;

describe("money", () => {
  test("formats euros Estonian style", () => {
    expect(formatEUR(10000, "et")).toBe("100 €");
    expect(formatEUR(9950, "et")).toBe("99,50 €");
  });
  test("groups large amounts with regular spaces", () => {
    expect(formatEUR(129000, "et")).toBe("1 290 €");
    expect(formatEUR(1234500, "et")).toBe("12 345 €");
    expect(formatEUR(129050, "et")).toBe("1 290,50 €");
  });
  test("contains no non-breaking spaces or narrow spaces", () => {
    const formats = [
      formatEUR(10000, "et"),
      formatEUR(9950, "et"),
      formatEUR(129000, "et"),
      formatEUR(1234500, "et"),
      formatEUR(129050, "et"),
    ];
    formats.forEach((fmt) => {
      expect(fmt).not.toContain(" "); // non-breaking space
      expect(fmt).not.toContain(" "); // narrow no-break space
    });
  });
});
describe("course prices", () => {
  test("e-learning has one full price, no participation kinds", () => {
    const c = { ...base, type: "e_learning", price: 19000, priceGroup: null, priceIndividual: null };
    expect(priceOptions(c)).toEqual([{ kind: "full", cents: 19000 }]);
    expect(participationKinds(c)).toEqual([]);
  });
  test("contact lists group and individual separately and ignores missing", () => {
    const c = { ...base, type: "contact", price: null, priceGroup: 35000, priceIndividual: 45000 };
    expect(priceOptions(c)).toEqual([{ kind: "group", cents: 35000 }, { kind: "individual", cents: 45000 }]);
    expect(fromPrice(c)).toBe(35000);
    expect(participationKinds({ ...c, priceIndividual: null })).toEqual(["group"]);
  });
  test("contact never offers a full e-learning price (no hybrid)", () => {
    expect(priceOptions({ ...base, type: "contact", price: 19000, priceGroup: 35000, priceIndividual: null }).map((p) => p.kind)).toEqual(["group"]);
  });
});
describe("registration", () => {
  test("prepayment due", () => { expect(prepaymentDue(35000, "full")).toBe(35000); expect(prepaymentDue(35001, "half")).toBe(17501); });
  test("confirmed only at >= 50% paid", () => {
    expect(registrationStatusAfterPayment({ status: "awaiting_prepayment", paidCents: 0 }, 35000)).toBe("awaiting_prepayment");
    expect(registrationStatusAfterPayment({ status: "awaiting_prepayment", paidCents: 17499 }, 35000)).toBe("awaiting_prepayment");
    expect(registrationStatusAfterPayment({ status: "awaiting_prepayment", paidCents: 17500 }, 35000)).toBe("confirmed");
    expect(registrationStatusAfterPayment({ status: "cancelled", paidCents: 35000 }, 35000)).toBe("cancelled");
  });
});
describe("sessions", () => {
  test("seats", () => { expect(seatsLeft(4, 1)).toBe(3); expect(seatsLeft(4, 6)).toBe(0); });
  test("state", () => {
    expect(seatState({ status: "scheduled", capacity: 6 }, 2)).toBe("open");
    expect(seatState({ status: "scheduled", capacity: 6 }, 4)).toBe("few");
    expect(seatState({ status: "scheduled", capacity: 6 }, 6)).toBe("full");
    expect(seatState({ status: "cancelled", capacity: 6 }, 0)).toBe("cancelled");
  });
});
describe("the seat hold (phase 2b, D2)", () => {
  const NOW = new Date("2026-10-09T10:00:00Z");
  test("a hold lasts Montonio's payment window, 30 minutes", () => {
    expect(SEAT_HOLD_MS).toBe(30 * 60_000);
    expect(holdUntil(NOW)).toEqual(new Date("2026-10-09T10:30:00Z"));
  });
  test("a hold of another length (a järelmaks attempt: 60 minutes, domain/financing.ts attemptWindowMs) ends that long after now", () => {
    expect(holdUntil(NOW, 60 * 60_000)).toEqual(new Date("2026-10-09T11:00:00Z"));
    expect(holdUntil(NOW, SEAT_HOLD_MS)).toEqual(holdUntil(NOW));
  });
  test("confirmed takes a seat; awaiting only while its hold has not ended; cancelled never", () => {
    const later = new Date(NOW.getTime() + 1);
    expect(holdsSeat({ status: "confirmed", seatHoldUntil: null }, NOW)).toBe(true);
    expect(holdsSeat({ status: "awaiting_prepayment", seatHoldUntil: later }, NOW)).toBe(true);
    expect(holdsSeat({ status: "awaiting_prepayment", seatHoldUntil: NOW }, NOW)).toBe(false); // ends at that moment
    expect(holdsSeat({ status: "awaiting_prepayment", seatHoldUntil: null }, NOW)).toBe(false);
    expect(holdsSeat({ status: "cancelled", seatHoldUntil: later }, NOW)).toBe(false);
  });
});
describe("recommend", () => {
  const mk = (id: number, type: string, level: string, sort = id) => ({ ...base, id, slug: "c" + id, type, level, sort });
  const all = [mk(1, "contact", "basic"), mk(2, "contact", "basic"), mk(3, "e_learning", "basic"), mk(4, "contact", "advanced"), { ...mk(5, "contact", "basic"), published: false }];
  test("same type+level first, excludes self and unpublished", () => expect(recommend(all[0], all, 3).map((c) => c.id)).toEqual([2, 4, 3]));
  test("manual override wins", () => expect(recommend({ ...all[0], recommendationIds: [3] }, all, 3).map((c) => c.id)).toEqual([3, 2, 4]));
});
