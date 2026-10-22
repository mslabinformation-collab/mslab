import { describe, expect, it } from "vitest";
import {
  FINANCING_ATTEMPT_MS, FINANCING_KEY, FINANCING_MAX_CENTS, FINANCING_MIN_CENTS, attemptWindowMs, billingAddressOf, estonianPhone, financingAllowed,
  financingOffered, financingRefusal, isHirePurchase, readFinancingSettings,
} from "@/domain/financing";
import { prepaymentDue } from "@/domain/registration";

// Järelmaks (Inbank): the pure rules (instalments, Task 1; spec §2 D3–D5, D8, §4): when the choice is offered and allowed, the details sent to
// Inbank's form, and how long an attempt holds a seat. No database, no Montonio.

describe("the constants", () => {
  it("100–5000 € in cents, the settings key, and the 60 minutes of a loan application", () => {
    expect(FINANCING_MIN_CENTS).toBe(10_000);
    expect(FINANCING_MAX_CENTS).toBe(500_000);
    expect(FINANCING_KEY).toBe("financing");
    expect(FINANCING_ATTEMPT_MS).toBe(3_600_000);
  });
});

describe("the toggle (Seaded → Järelmaks (Inbank))", () => {
  it("is on only for { enabled: true }; anything else is off", () => {
    expect(readFinancingSettings({ enabled: true })).toEqual({ enabled: true });
    expect(readFinancingSettings({ enabled: false })).toEqual({ enabled: false });
    for (const value of [undefined, null, {}, [], "true", 1, true, { enabled: "true" }, { enabled: 1 }, { enabled: null }]) {
      expect(readFinancingSettings(value)).toEqual({ enabled: false });
    }
  });
});

describe("when the choice is offered and allowed", () => {
  it("offered only when on, payments on, and 100–5000 € inclusive", () => {
    expect(financingOffered({ enabled: true, paymentsOn: true, priceCents: 10_000 })).toBe(true);
    expect(financingOffered({ enabled: true, paymentsOn: true, priceCents: 500_000 })).toBe(true);
    expect(financingOffered({ enabled: true, paymentsOn: true, priceCents: 9_999 })).toBe(false);
    expect(financingOffered({ enabled: true, paymentsOn: true, priceCents: 500_001 })).toBe(false);
    expect(financingOffered({ enabled: false, paymentsOn: true, priceCents: 20_000 })).toBe(false);
    expect(financingOffered({ enabled: true, paymentsOn: false, priceCents: 20_000 })).toBe(false);
    expect(financingOffered({ enabled: true, paymentsOn: true, priceCents: null })).toBe(false);
  });
  it("allowed only when nothing is paid and the full price is due", () => {
    const base = { enabled: true, paymentsOn: true, priceCents: 29_000 };
    expect(financingAllowed({ ...base, paidCents: 0, dueCents: 29_000 })).toBe(true);
    expect(financingAllowed({ ...base, paidCents: 1_000, dueCents: 28_000 })).toBe(false);
    expect(financingAllowed({ ...base, paidCents: 0, dueCents: 14_500 })).toBe(false);
  });
  it("allowed is never more than offered", () => {
    const unpaid = { paidCents: 0, dueCents: 29_000 };
    expect(financingAllowed({ enabled: false, paymentsOn: true, priceCents: 29_000, ...unpaid })).toBe(false);
    expect(financingAllowed({ enabled: true, paymentsOn: false, priceCents: 29_000, ...unpaid })).toBe(false);
    expect(financingAllowed({ enabled: true, paymentsOn: true, priceCents: 600_000, paidCents: 0, dueCents: 600_000 })).toBe(false);
    expect(financingAllowed({ enabled: true, paymentsOn: true, priceCents: null, paidCents: 0, dueCents: 0 })).toBe(false);
  });
});

describe("why a järelmaks is refused (which sentence she is told)", () => {
  const unpaid = { paidCents: 0, dueCents: 29_000 };
  it("none while it is allowed", () => {
    expect(financingRefusal({ enabled: true, paymentsOn: true, priceCents: 29_000, ...unpaid })).toBeNull();
    expect(financingRefusal({ enabled: true, paymentsOn: true, priceCents: 10_000, paidCents: 0, dueCents: 10_000 })).toBeNull();
    expect(financingRefusal({ enabled: true, paymentsOn: true, priceCents: 500_000, paidCents: 0, dueCents: 500_000 })).toBeNull();
  });
  it("'off' when the price is within 100–5000 € but Maria's toggle is off, or Montonio payments are", () => {
    expect(financingRefusal({ enabled: false, paymentsOn: true, priceCents: 29_000, ...unpaid })).toBe("off");
    expect(financingRefusal({ enabled: true, paymentsOn: false, priceCents: 29_000, ...unpaid })).toBe("off");
    expect(financingRefusal({ enabled: false, paymentsOn: false, priceCents: 10_000, paidCents: 0, dueCents: 10_000 })).toBe("off");
    expect(financingRefusal({ enabled: false, paymentsOn: true, priceCents: 500_000, paidCents: 0, dueCents: 500_000 })).toBe("off");
  });
  it("'range' when the price is outside 100–5000 € (or there is none), whatever the toggle says", () => {
    for (const enabled of [true, false]) {
      for (const priceCents of [9_999, 500_001, 0, null]) expect(financingRefusal({ enabled, paymentsOn: true, priceCents, paidCents: 0, dueCents: priceCents ?? 0 }), `${enabled} ${priceCents}`).toBe("range");
    }
    expect(financingRefusal({ enabled: true, paymentsOn: false, priceCents: 600_000, paidCents: 0, dueCents: 600_000 })).toBe("range");
  });
  it("'range' when both apply: the price is the permanent fact", () => {
    expect(financingRefusal({ enabled: false, paymentsOn: false, priceCents: 9_999, paidCents: 0, dueCents: 9_999 })).toBe("range");
  });
  it("a part paid or a part due, with the choice on and the price within the range, keeps the range sentence as before; with the choice off it is 'off'", () => {
    expect(financingRefusal({ enabled: true, paymentsOn: true, priceCents: 29_000, paidCents: 1_000, dueCents: 28_000 })).toBe("range");
    expect(financingRefusal({ enabled: true, paymentsOn: true, priceCents: 29_000, paidCents: 0, dueCents: 14_500 })).toBe("range");
    expect(financingRefusal({ enabled: false, paymentsOn: true, priceCents: 29_000, paidCents: 1_000, dueCents: 28_000 })).toBe("off");
  });
  it("is null exactly when financingAllowed says yes", () => {
    for (const enabled of [true, false]) for (const paymentsOn of [true, false]) for (const priceCents of [null, 9_999, 10_000, 29_000, 500_000, 500_001]) for (const paidCents of [0, 1_000]) {
      const o = { enabled, paymentsOn, priceCents, paidCents, dueCents: (priceCents ?? 0) - paidCents };
      expect(financingRefusal(o) === null, JSON.stringify(o)).toBe(financingAllowed(o));
    }
  });
});

describe("billingAddress (spec D8, §4)", () => {
  it.each([
    ["Mari Maasikas", ["Mari", "Maasikas"]],
    ["Anna-Liisa van der Berg", ["Anna-Liisa van der", "Berg"]],
    ["Madonna", ["Madonna", "Madonna"]],
  ])("splits %s", (name, [first, last]) => expect(billingAddressOf({ name, email: "a@example.test" })).toMatchObject({ firstName: first, lastName: last }));

  it("keeps the name on one line: inner spaces and line breaks one space, the ends trimmed", () => {
    expect(billingAddressOf({ name: "  Mari \n  Maasikas  ", email: "a@example.test" })).toMatchObject({ firstName: "Mari", lastName: "Maasikas" });
  });

  it.each([
    ["+372 5123 4567", "51234567"],
    ["372-5123-4567", "51234567"],
    ["(+372) 6123456", "6123456"],
    ["5123 456", "5123456"],
    ["+372 512.3456", "5123456"],
    ["+371 2123 4567", null],
    ["+44 7700 900123", null],
    ["12345", null],
    ["", null],
  ])("estonianPhone(%s) = %s", (raw, want) => expect(estonianPhone(raw)).toBe(want));

  it("a number must start 5 (mobile) or 3–8 (landline), and be 7–8 digits", () => {
    expect(estonianPhone("2123456")).toBeNull(); // starts 2
    expect(estonianPhone("9123456")).toBeNull(); // starts 9
    expect(estonianPhone("1234567")).toBeNull(); // starts 1
    expect(estonianPhone("612345")).toBeNull(); // six digits
    expect(estonianPhone("512345678")).toBeNull(); // nine digits
    expect(estonianPhone("+372 512345678")).toBeNull();
    expect(estonianPhone("+372 612345")).toBeNull();
    expect(estonianPhone("3123456")).toBe("3123456");
    expect(estonianPhone("81234567")).toBe("81234567");
  });

  it("letters or other signs make it no number", () => {
    expect(estonianPhone("5123 45a6")).toBeNull();
    expect(estonianPhone("+372 5123 4567 ext 2")).toBeNull();
    expect(estonianPhone("5123+4567")).toBeNull();
  });

  it("sends the phone only when Estonian", () => {
    expect(billingAddressOf({ name: "Mari Maasikas", email: "m@example.test", phone: "+372 5123 4567" })).toEqual(
      { firstName: "Mari", lastName: "Maasikas", email: "m@example.test", phoneNumber: "51234567", phoneCountry: "372" });
    expect(billingAddressOf({ name: "Mari Maasikas", email: "m@example.test", phone: "+371 2123 4567" })).toEqual(
      { firstName: "Mari", lastName: "Maasikas", email: "m@example.test" });
    expect(billingAddressOf({ name: "Mari Maasikas", email: "m@example.test", phone: null })).toEqual(
      { firstName: "Mari", lastName: "Maasikas", email: "m@example.test" });
    expect(billingAddressOf({ name: "Mari Maasikas", email: "m@example.test" })).toEqual(
      { firstName: "Mari", lastName: "Maasikas", email: "m@example.test" });
  });

  it("a name of spaces only still gives a valid address: both names are the e-mail's local part, never empty", () => {
    expect(billingAddressOf({ name: "   ", email: "mari@example.test" })).toMatchObject({ firstName: "mari", lastName: "mari" });
  });
});

describe("how long an attempt holds a seat", () => {
  it("60 minutes for hirePurchase, 30 for a bank attempt", () => {
    expect(attemptWindowMs("hirePurchase")).toBe(3_600_000);
    expect(attemptWindowMs("paymentInitiation")).toBe(1_800_000);
    expect(attemptWindowMs("")).toBe(1_800_000);
  });
  it("hirePurchase is told apart by its code, case and spaces aside (isHirePurchase, as attemptWindowMs reads a row's method)", () => {
    for (const m of ["hirePurchase", "hirepurchase", " HIREPURCHASE "]) expect([isHirePurchase(m), attemptWindowMs(m)], m).toEqual([true, 3_600_000]);
    for (const m of ["", "paymentInitiation", "bnpl", "hire purchase"]) expect([isHirePurchase(m), attemptWindowMs(m)], m).toEqual([false, 1_800_000]);
  });
});

describe("the choice as an amount", () => {
  it("financing is due in full, like „100% kohe“", () => {
    expect(prepaymentDue(29_000, "financing")).toBe(29_000);
    expect(prepaymentDue(29_001, "financing")).toBe(29_001);
    expect(prepaymentDue(29_001, "half")).toBe(14_501);
  });
});
