// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import ui from "@/components/admin/ui.module.css";
import { checkReasonLabel, PAYMENT_TONE, PaymentLines, paymentStatusLabel } from "@/components/admin/PaymentLines";
import type { PaymentRow } from "@/db/queries/payments";
import type { PaymentStatus } from "@/db/schema";

// The online payments' short lines of the registration drawer and the Õpilased drawer (phase 2b, spec 8), with B22 (admin UX pass, piece 2):
// a replaced order is „Asendatud“ in a muted tag (Maksed shows it under „Kõik“; the drawers leave it out: db/queries/payments.ts
// listPaymentsOf), and a held payment with a check reason says it — „Topeltmakse — tagasta“ — in place of „Kontrolli Montonios“ (P-8).

const row = (id: number, status: PaymentStatus, over: Partial<PaymentRow> = {}): PaymentRow => ({
  id,
  reference: `MSLAB-M${id}`,
  kind: "prepayment",
  registrationId: 1,
  courseId: 1,
  clientId: null,
  invoiceId: null,
  email: "kati@example.test",
  name: "Kati Tamm",
  locale: "et",
  amountCents: 17500,
  status,
  providerUuid: `uuid-${id}`,
  method: "paymentInitiation",
  bank: "",
  newsletter: false,
  createdAt: new Date("2026-10-22T08:00:00Z"),
  paidAt: null,
  updatedAt: new Date("2026-10-22T08:00:00Z"),
  contractSnapshot: null,
  checkReason: null,
  courseTitle: { et: "Kulmumeistri baaskoolitus" },
  courseSlug: "kulmumeistri-baaskoolitus",
  startsAt: null,
  ...over,
});

function lines(rows: PaymentRow[]): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(createElement(PaymentLines, { rows }));
  return container;
}
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const line = (c: HTMLElement, reference: string) => c.querySelector<HTMLElement>(`[data-payment='${reference}']`)!;

describe("a replaced order and a held payment's reason", () => {
  test("the words: „Asendatud“ (muted), and the reason 'double' is „Topeltmakse — tagasta“", () => {
    expect(paymentStatusLabel({ status: "replaced", paidAt: null })).toBe("Asendatud");
    expect(PAYMENT_TONE.replaced).toBe(ui.muted);
    expect(checkReasonLabel("double")).toBe("Topeltmakse — tagasta");
  });

  test("a held payment with the reason says „Topeltmakse — tagasta“ in place of „Kontrolli Montonios“; one without, and one voided after it was paid, keep „Kontrolli Montonios“", () => {
    const c = lines([
      row(1, "held", { checkReason: "double" }),
      row(2, "held"),
      row(3, "failed", { paidAt: new Date("2026-10-22T08:05:00Z") }),
      // a code this version does not know (a newer one wrote it): the plain check
      row(4, "held", { checkReason: "someday" as PaymentRow["checkReason"] }),
    ]);
    expect(text(line(c, "MSLAB-M1").querySelector("[data-payment-check]"))).toBe("Topeltmakse — tagasta");
    expect(text(line(c, "MSLAB-M1"))).not.toContain("Kontrolli Montonios");
    expect(text(line(c, "MSLAB-M2").querySelector("[data-payment-check]"))).toBe("Kontrolli Montonios");
    expect(text(line(c, "MSLAB-M3").querySelector("[data-payment-check]"))).toBe("Kontrolli Montonios");
    expect(text(line(c, "MSLAB-M3"))).toContain("Tühistatud pangas");
    expect(text(line(c, "MSLAB-M4").querySelector("[data-payment-check]"))).toBe("Kontrolli Montonios");
  });

  test("a replaced order's line (when a caller lists it) is „Asendatud“ in the muted tag, with nothing to check", () => {
    const c = lines([row(5, "replaced")]);
    const tag = [...line(c, "MSLAB-M5").querySelectorAll<HTMLElement>(`.${ui.tag}`)];
    expect(tag.map(text)).toEqual(["Asendatud"]);
    expect(tag[0].classList.contains(ui.muted)).toBe(true);
    expect(line(c, "MSLAB-M5").querySelector("[data-payment-check]")).toBeNull();
    expect(line(c, "MSLAB-M5").dataset.paymentStatus).toBe("replaced");
  });
});
