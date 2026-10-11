import { describe, expect, test } from "vitest";
import { ORDER_REFERENCE_PREFIX, orderReference, paymentMethodLabel } from "@/domain/payments";

// The pure rules of online payments (phase 2b): the reference Montonio knows a payment by, and Maria's word for how it was paid (her notice
// and the admin's "Maksed" use the same helper; the owner's decision of 09.10: no English Montonio codes in her texts).

describe("the reference Montonio knows a payment by", () => {
  test("MSLAB-M<id>", () => {
    expect(ORDER_REFERENCE_PREFIX).toBe("MSLAB-M");
    expect([orderReference(1), orderReference(42)]).toEqual(["MSLAB-M1", "MSLAB-M42"]);
  });
});

describe("paymentMethodLabel: Maria's word for the way a payment was made", () => {
  test("the five methods Montonio's store can have on", () => {
    expect(paymentMethodLabel("paymentInitiation", "")).toBe("Pangalink");
    expect(paymentMethodLabel("cardPayments", "")).toBe("Kaart");
    expect(paymentMethodLabel("applePay", "")).toBe("Apple Pay");
    expect(paymentMethodLabel("googlePay", "")).toBe("Google Pay");
    expect(paymentMethodLabel("blik", "")).toBe("BLIK");
  });

  test("with a bank: 'Pangalink · Swedbank'", () => {
    expect(paymentMethodLabel("paymentInitiation", "Swedbank")).toBe("Pangalink · Swedbank");
    expect(paymentMethodLabel("paymentInitiation", "  LHV  ")).toBe("Pangalink · LHV");
  });

  test("empty or unknown is 'Muu': the raw code is never shown", () => {
    for (const method of ["", "   ", "hirePurchase", "PAYMENT_INITIATION_V2", "constructor", "__proto__", "toString"]) expect(paymentMethodLabel(method, "")).toBe("Muu");
    expect(paymentMethodLabel("hirePurchase", "Swedbank")).toBe("Muu · Swedbank");
  });

  test("the code is read without regard to case or surrounding spaces (a GET /orders answer is not always written as a token)", () => {
    expect(paymentMethodLabel(" PAYMENTINITIATION ", "")).toBe("Pangalink");
    expect(paymentMethodLabel("CardPayments", "")).toBe("Kaart");
  });
});
