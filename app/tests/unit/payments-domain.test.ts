import { describe, expect, test } from "vitest";
import { CHECK_REASONS, isCheckReason, isReferencePrefix, LOCAL_REFERENCE_PREFIX, needsCheck, ORDER_REFERENCE_PREFIX, orderReference, paymentMethodLabel, PREVIEW_REFERENCE_PREFIX, referenceId } from "@/domain/payments";

// The pure rules of online payments (phase 2b): the reference Montonio knows a payment by, and Maria's word for how it was paid (her notice
// and the admin's "Maksed" use the same helper; the owner's decision of 09.10: no English Montonio codes in her texts).

describe("the reference Montonio knows a payment by", () => {
  test("<prefix><id>: production's MSLAB-M, this machine's MSLAB-L, a preview's MSLAB-P", () => {
    expect([ORDER_REFERENCE_PREFIX, LOCAL_REFERENCE_PREFIX, PREVIEW_REFERENCE_PREFIX]).toEqual(["MSLAB-M", "MSLAB-L", "MSLAB-P"]);
    expect([orderReference(1, "MSLAB-M"), orderReference(42, "MSLAB-M"), orderReference(42, "MSLAB-L")]).toEqual(["MSLAB-M1", "MSLAB-M42", "MSLAB-L42"]);
  });

  test("referenceId: the payment id of a reference with this prefix; another environment's prefix, or anything else, is null", () => {
    expect(referenceId("MSLAB-M7", "MSLAB-M")).toBe(7);
    expect(referenceId("MSLAB-M1234567", "MSLAB-M")).toBe(1234567);
    expect(referenceId("MSLAB-L7", "MSLAB-L")).toBe(7);
    const others = ["MSLAB-L7", "MSLAB-P7", "mslab-m7", "MSLAB-M", "MSLAB-M0", "MSLAB-M07", "MSLAB-M7x", " MSLAB-M7", "MSLAB-M7 ", "MSLAB-M-7", "MSLAB-M1.5", "MSLAB-M+7", "MSLAB-M99999999999999999", "XMSLAB-M7", "E2E-PROBE-NO-SUCH-PAYMENT", ""];
    for (const other of others) expect(referenceId(other, "MSLAB-M"), other).toBeNull();
    expect(referenceId("MSLAB-M7", "MSLAB-L")).toBeNull();
  });

  test("isReferencePrefix: capitals, digits and hyphens, 2 to 16 of them, starting with a capital and never ending in a digit (the id follows it)", () => {
    for (const ok of ["MSLAB-M", "MSLAB-L", "MSLAB-P", "MS", "DEV2-", "A-B-C-D-E-F-G-H-"]) expect(isReferencePrefix(ok), ok).toBe(true);
    for (const bad of ["", "M", "mslab-m", "MSLAB-1", "1MSLAB-", "-MSLAB", "MSLAB M", "MSLAB_M", "MSLÄB-M", "MSLAB-M\n", "A".repeat(17)]) expect(isReferencePrefix(bad), JSON.stringify(bad)).toBe(false);
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
    for (const method of ["", "   ", "BNPL", "PAYMENT_INITIATION_V2", "constructor", "__proto__", "toString"]) expect(paymentMethodLabel(method, "")).toBe("Muu");
    expect(paymentMethodLabel("bnpl", "Swedbank")).toBe("Muu · Swedbank");
  });

  test("hirePurchase is Järelmaks (Inbank), read like the other codes (spec D6)", () => {
    expect(paymentMethodLabel("hirePurchase", null)).toBe("Järelmaks (Inbank)");
    expect(paymentMethodLabel("hirePurchase", "")).toBe("Järelmaks (Inbank)");
    expect(paymentMethodLabel(" HIREPURCHASE ", "")).toBe("Järelmaks (Inbank)");
  });

  test("a järelmaks takes no provider after it: Montonio names Inbank as the provider, which the label says already (never „Järelmaks (Inbank) · Inbank“)", () => {
    expect(paymentMethodLabel("hirePurchase", "Inbank")).toBe("Järelmaks (Inbank)");
    expect(paymentMethodLabel(" hirepurchase ", "  Inbank  ")).toBe("Järelmaks (Inbank)");
    // the bank link keeps its bank
    expect(paymentMethodLabel("paymentInitiation", "Inbank")).toBe("Pangalink · Inbank");
  });

  test("the code is read without regard to case or surrounding spaces (a GET /orders answer is not always written as a token)", () => {
    expect(paymentMethodLabel(" PAYMENTINITIATION ", "")).toBe("Pangalink");
    expect(paymentMethodLabel("CardPayments", "")).toBe("Kaart");
  });
});

describe("the check reason of a held payment (B22): the code payments.check_reason stores", () => {
  test("'double' is the one reason: a second payment of something paid in full (a replaced order, a late loan)", () => {
    expect(CHECK_REASONS).toEqual(["double"]);
    expect(isCheckReason("double")).toBe(true);
    // anything else (a code a newer version wrote, or none) is no reason this code knows: the row reads „Kontrolli Montonios“
    for (const other of ["", "Double", " double", "held", "constructor", "__proto__", null, undefined, 1]) expect(isCheckReason(other), String(other)).toBe(false);
  });

  test("a replaced order is nothing to check: it is no money (needsCheck: held, or failed after it was paid)", () => {
    expect(needsCheck({ status: "replaced", paidAt: null })).toBe(false);
    expect(needsCheck({ status: "held", paidAt: null })).toBe(true);
    expect(needsCheck({ status: "failed", paidAt: new Date() })).toBe(true);
    expect(needsCheck({ status: "pending", paidAt: null })).toBe(false);
  });
});
