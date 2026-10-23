// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PaymentRow } from "@/db/queries/payments";

// The registration drawer's Raha card (admin UX pass, piece 2, Task 5; README A2 drawer 2, piece2-texts P-2, S3-a…e) in a browser-like document
// (happy-dom), with „Lisa laekumine“'s server action answered here: what the card says (the money, the 50 % marker, the seats), the amount pills of
// P-2 with the one preselected, the submit's „· koht kinnitub“ only for an amount that reaches 50 %, „Muu summa“ above what is left refused in the
// field (nothing sent), the receipt's checkbox or the S3-c line, the form it sends, and the result lines (README, S3-a, S3-b) and refusals.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ addManualPaymentAction: vi.fn(), saveRegistrationStatus: vi.fn(), cancelRegistration: vi.fn(), toggleRequestHandled: vi.fn() }));
vi.mock("@/server/actions/admin", () => actions);

import { MoneyCard } from "@/components/admin/MoneyCard";
import { PaymentLines } from "@/components/admin/PaymentLines";

const TODAY = "2026-10-20";
type Props = Parameters<typeof MoneyCard>[0];
type Registration = Props["registration"];
const reg = (over: Partial<Registration> = {}): Registration => ({ id: 7, paidCents: 0, priceCents: 29000, status: "awaiting_prepayment", cancelled: false, choice: "half", ...over });
const SESSION = { taken: 2, capacity: 4 };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => within.querySelector<E>(selector);
const all = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => [...within.querySelectorAll<E>(selector)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = async (over: Partial<Props> = {}) => {
  await act(async () => root.render(createElement(MoneyCard, { registration: reg(), session: SESSION, takesSeat: false, sellerReady: true, paymentLines: null, today: TODAY, ...over })));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const type = async (el: HTMLInputElement | null, value: string) => {
  expect(el, "the field to type in").not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};
const open = () => click($("[data-add-payment]"));
/** The amount pills: each one's words and whether it is chosen. */
const amounts = () => all<HTMLInputElement>("[data-amount]").map((r) => ({ label: text(r.closest("label")), checked: r.checked }));
const amount = (label: string) => all<HTMLInputElement>("[data-amount]").find((r) => text(r.closest("label")) === label) ?? null;
const submit = () => $<HTMLButtonElement>("[data-add-payment-submit]");
/** What the last press sent, as a plain record. */
const sent = () => {
  const call = actions.addManualPaymentAction.mock.calls.at(-1)!;
  return Object.fromEntries((call[1] as FormData).entries());
};

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the card: the money, the 50 % marker and the seats", () => {
  test("„{laekunud} / {hind} laekunud“, the payment choice, the bar with its marker at 50 %, „Koht kinnitub {pool} juures · vabu kohti {x} / {cap}“", async () => {
    await show({ registration: reg({ paidCents: 10000 }) });
    const card = $("[data-money-card]")!;
    expect(text($("h3", card))).toBe("Raha");
    expect(text($("[data-money-choice]", card))).toBe("Valitud: ettemaks 50%");
    expect(text($("[data-paid]", card))).toBe("100 €");
    expect(text($("[data-money-total]", card))).toBe("/ 290 € laekunud");
    expect($("[data-money-bar]", card)).not.toBeNull();
    expect($<HTMLElement>("[data-money-mark]", card)!.style.left).toBe("50%");
    expect(text($("[data-money-seat]", card))).toBe("Koht kinnitub 145 € juures · vabu kohti 2 / 4");
    // the panel is closed until „Lisa laekumine“ is pressed (the phone's first screen holds only the button)
    expect($("[data-add-payment-panel]")).toBeNull();
    expect(text($("[data-add-payment]"))).toBe("Lisa laekumine");
  });

  test("the other choices; a full session reads 0 free; without a session the S3-d line; without a price the notice and no bar", async () => {
    await show({ registration: reg({ choice: "full" }), session: { taken: 5, capacity: 4 } });
    expect(text($("[data-money-choice]"))).toBe("Valitud: kogu summa (100%)");
    expect(text($("[data-money-seat]"))).toBe("Koht kinnitub 145 € juures · vabu kohti 0 / 4");
    await show({ registration: reg({ choice: "financing" }), session: null });
    expect(text($("[data-money-choice]"))).toBe("Valitud: järelmaks (Inbank)");
    expect(text($("[data-money-seat]"))).toBe("Registreering kinnitub 145 € juures");
    await show({ registration: reg({ priceCents: null, paidCents: 5000 }), session: null });
    expect(text($("[data-paid]"))).toBe("50 €");
    expect($("[data-money-bar]")).toBeNull();
    expect($("[data-money-seat]")).toBeNull();
    expect($("[data-money-choice]")).toBeNull();
    expect(text($("[data-money-card]"))).toContain("Koolitusel pole hinda, staatust ei arvutata. Muuda staatust käsitsi.");
  });

  test("the online payments are listed in the card, under „Veebimaksed“: the page hands the card their lines drawn on the server, not the rows", async () => {
    const payment = {
      id: 3, reference: "MSLAB-M7", kind: "prepayment", amountCents: 14500, status: "pending", method: "", bank: "", checkReason: null,
      createdAt: new Date("2026-10-17T17:35:00Z"), paidAt: null, courseTitle: null,
    } as unknown as PaymentRow;
    await show({ paymentLines: createElement(PaymentLines, { rows: [payment] }) });
    const lines = $("[data-money-card] [data-registration-payments]")!;
    expect(text($("h4", lines))).toBe("Veebimaksed");
    expect(text($('[data-payment="MSLAB-M7"]', lines))).toContain("145 €");
    await show({ paymentLines: null });
    expect($("[data-registration-payments]")).toBeNull();
  });

  test("the card takes no payment rows (their provider ids, e-mails and names stay out of the browser's page): no `payments` prop, no `PaymentRow` import", () => {
    const source = readFileSync(join(process.cwd(), "src/components/admin/MoneyCard.tsx"), "utf8");
    expect(source).not.toMatch(/PaymentRow/);
    expect(source).not.toMatch(/payments:/);
  });

  test("the panel's empty refusal line takes no room (a gap of its own under the buttons), and a refusal shows it", () => {
    const css = readFileSync(join(process.cwd(), "src/components/admin/MoneyCard.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/\.refusal:empty\s*\{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/display:\s*none;/);
  });

  test("a cancelled registration has no „Lisa laekumine“ (its money stays on the card)", async () => {
    await show({ registration: reg({ status: "cancelled", cancelled: true, paidCents: 14500 }) });
    expect(text($("[data-paid]"))).toBe("145 €");
    expect($("[data-add-payment]")).toBeNull();
    expect(text(container)).not.toContain("Lisa laekumine");
  });
});

describe("the panel's amount pills (P-2) and the submit", () => {
  test("0 of 290 €: „145 € · ettemaks“ (chosen), „290 € · kogu summa“, „Muu summa“; the submit says „Lisa 145 € · koht kinnitub“", async () => {
    await show();
    await open();
    expect(amounts()).toEqual([
      { label: "145 € · ettemaks", checked: true },
      { label: "290 € · kogu summa", checked: false },
      { label: "Muu summa", checked: false },
    ]);
    // the focus is on the chosen amount
    expect(document.activeElement).toBe(amount("145 € · ettemaks"));
    expect(text(submit())).toBe("Lisa 145 € · koht kinnitub");
    // the whole price reaches 50 % too
    await click(amount("290 € · kogu summa"));
    expect(text(submit())).toBe("Lisa 290 € · koht kinnitub");
    // an amount under 50 % has no suffix
    await click(amount("Muu summa"));
    await type($<HTMLInputElement>("[data-other-amount]"), "100");
    expect(text(submit())).toBe("Lisa 100 €");
  });

  test("M3: „· koht kinnitub“ only when the place can be confirmed: a full session where the registration holds no seat says plain „Lisa {summa}“; if it holds its seat, or a seat is free, it says so", async () => {
    // full (4 of 4), and the registration's hold ran out: the money is taken, the place is not (S3-b's „Koolitus on vahepeal täis“)
    await show({ session: { taken: 4, capacity: 4 }, takesSeat: false });
    await open();
    expect(text(submit())).toBe("Lisa 145 €");
    await click(amount("290 € · kogu summa"));
    expect(text(submit())).toBe("Lisa 290 €");
    // the same full session, the registration's own seat among the four: it keeps it, so the place is confirmed
    await show({ session: { taken: 4, capacity: 4 }, takesSeat: true });
    expect(text(submit())).toBe("Lisa 290 € · koht kinnitub");
    await click(amount("145 € · ettemaks"));
    expect(text(submit())).toBe("Lisa 145 € · koht kinnitub");
    // one seat free: the place can be confirmed whether or not it holds one
    await show({ session: { taken: 3, capacity: 4 }, takesSeat: false });
    expect(text(submit())).toBe("Lisa 145 € · koht kinnitub");
    // more taken than the capacity (Maria confirmed past it): the others alone fill the session, as the server counts (it leaves hers out)
    await show({ session: { taken: 5, capacity: 4 }, takesSeat: true });
    expect(text(submit())).toBe("Lisa 145 €");
    // the seat line above is as it was
    expect(text($("[data-money-seat]"))).toBe("Koht kinnitub 145 € juures · vabu kohti 0 / 4");
  });

  test("100 € paid: „45 € · ettemaks“ (chosen) and „190 € · ülejäänud summa“", async () => {
    await show({ registration: reg({ paidCents: 10000 }) });
    await open();
    expect(amounts()).toEqual([
      { label: "45 € · ettemaks", checked: true },
      { label: "190 € · ülejäänud summa", checked: false },
      { label: "Muu summa", checked: false },
    ]);
    expect(text(submit())).toBe("Lisa 45 € · koht kinnitub");
  });

  test("150 € paid and confirmed: only „140 € · ülejäänud summa“ (chosen), and no suffix (the place is confirmed already)", async () => {
    await show({ registration: reg({ paidCents: 15000, status: "confirmed" }) });
    await open();
    expect(amounts()).toEqual([
      { label: "140 € · ülejäänud summa", checked: true },
      { label: "Muu summa", checked: false },
    ]);
    expect(text(submit())).toBe("Lisa 140 €");
  });

  test("without a session the suffix is „· registreering kinnitub“ (S3-d)", async () => {
    await show({ session: null });
    await open();
    expect(text(submit())).toBe("Lisa 145 € · registreering kinnitub");
  });

  test("a course with no price: only „Muu summa“, chosen, and no cap", async () => {
    actions.addManualPaymentAction.mockResolvedValue({ ok: true, addedCents: 50000, paidCents: 50000, status: "awaiting_prepayment", confirmedNow: false, full: false, receiptNumber: null });
    await show({ registration: reg({ priceCents: null }), session: null });
    await open();
    expect(amounts()).toEqual([{ label: "Muu summa", checked: true }]);
    await type($<HTMLInputElement>("[data-other-amount]"), "500");
    expect(text(submit())).toBe("Lisa 500 €");
    $<HTMLInputElement>("[data-receipt]")!.click();
    await settle();
    await click(submit());
    expect(sent()).toMatchObject({ cents: "50000" });
    expect(text($("[data-add-payment-result]"))).toBe("500 € lisatud.");
  });

  test("„Muu summa“ above what is left: the field says „Summa on suurem kui tasumata osa (290 €).“ and nothing is sent", async () => {
    await show();
    await open();
    await click(amount("Muu summa"));
    const field = $<HTMLInputElement>("[data-other-amount]")!;
    await type(field, "500");
    await click(submit());
    expect(actions.addManualPaymentAction).not.toHaveBeenCalled();
    expect(text($("[data-other-amount-error]"))).toBe("Summa on suurem kui tasumata osa (290 €).");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field);
    // not an amount at all, and nothing typed: the existing words, nothing sent
    await type(field, "palju");
    await click(submit());
    expect(text($("[data-other-amount-error]"))).toBe("Sisesta summa eurodes, näiteks 175 või 175,50.");
    await type(field, "");
    await click(submit());
    expect(text($("[data-other-amount-error]"))).toBe("Sisesta summa eurodes, näiteks 175 või 175,50.");
    expect(actions.addManualPaymentAction).not.toHaveBeenCalled();
    // exactly what is left goes
    actions.addManualPaymentAction.mockResolvedValue({ ok: true, addedCents: 29000, paidCents: 29000, status: "confirmed", confirmedNow: true, full: false, receiptNumber: "MSL2026-005" });
    await type(field, "290,00");
    await click(submit());
    expect(sent()).toMatchObject({ cents: "29000" });
  });

  test("the date is today and no later; Pangaülekanne is the default way; Katkesta closes the panel and gives the button its focus back", async () => {
    await show();
    await open();
    const date = $<HTMLInputElement>("[data-paid-date]")!;
    expect(date.type).toBe("date");
    expect(date.value).toBe(TODAY);
    expect(date.max).toBe(TODAY);
    expect(all<HTMLInputElement>("[data-paid-method]").map((r) => [text(r.closest("label")), r.checked])).toEqual([
      ["Pangaülekanne", true],
      ["Sularaha", false],
      ["Kaart", false],
    ]);
    await click(all("button").find((b) => text(b) === "Katkesta")!);
    expect($("[data-add-payment-panel]")).toBeNull();
    expect(document.activeElement).toBe($("[data-add-payment]"));
  });
});

describe("the receipt", () => {
  test("with seller data the checkbox „Koosta kviitung (arve „Juba tasutud“)“ is ticked", async () => {
    await show();
    await open();
    const box = $<HTMLInputElement>("[data-receipt]")!;
    expect(box.type).toBe("checkbox");
    expect(box.checked).toBe(true);
    expect(text(box.closest("label"))).toBe("Koosta kviitung (arve „Juba tasutud“)");
    expect($("[data-receipt-need-seller]")).toBeNull();
  });

  test("seller missing: „Kviitungit ei saa koostada: täida Seaded → Arve andmed.“ (the link to Seaded) in place of the checkbox, and no receipt is asked", async () => {
    actions.addManualPaymentAction.mockResolvedValue({ ok: true, addedCents: 14500, paidCents: 14500, status: "confirmed", confirmedNow: true, full: false, receiptNumber: null });
    await show({ sellerReady: false });
    await open();
    expect($("[data-receipt]")).toBeNull();
    const line = $("[data-receipt-need-seller]")!;
    expect(text(line)).toBe("Kviitungit ei saa koostada: täida Seaded → Arve andmed.");
    expect($<HTMLAnchorElement>("a", line)!.getAttribute("href")).toBe("/admin/seaded#arve");
    expect(text($("a", line))).toBe("Seaded → Arve andmed");
    await click(submit());
    expect(sent().receipt).toBeUndefined();
    expect(text($("[data-add-payment-result]"))).toBe("145 € lisatud · koht kinnitatud.");
  });
});

describe("a press: the form it sends, the result lines and the refusals", () => {
  test("it sends the amount, the day, the way, the receipt and the total it was built on; the README line; the panel closes", async () => {
    actions.addManualPaymentAction.mockResolvedValue({ ok: true, addedCents: 14500, paidCents: 14500, status: "confirmed", confirmedNow: true, full: false, receiptNumber: "MSL2026-005" });
    await show();
    await open();
    await click($('[data-paid-method="cash"]'));
    await click(submit());
    expect(actions.addManualPaymentAction).toHaveBeenCalledTimes(1);
    expect(actions.addManualPaymentAction.mock.calls[0][0]).toBeNull();
    expect(sent()).toEqual({ registrationId: "7", cents: "14500", paidOn: TODAY, method: "cash", receipt: "1", expectedPaidCents: "0" });
    expect($("[data-add-payment-panel]")).toBeNull();
    expect(text($("[data-add-payment-result]"))).toBe("145 € lisatud · kviitung MSL2026-005 · koht kinnitatud.");
    expect($("[data-add-payment-result]")!.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe($("[data-add-payment]"));
  });

  test("S3-a: under 50 % — „100 € lisatud · kviitung MSL2026-005. Koht kinnitub 145 € juures.“", async () => {
    actions.addManualPaymentAction.mockResolvedValue({ ok: true, addedCents: 10000, paidCents: 10000, status: "awaiting_prepayment", confirmedNow: false, full: false, receiptNumber: "MSL2026-005" });
    await show();
    await open();
    await click(amount("Muu summa"));
    await type($<HTMLInputElement>("[data-other-amount]"), "100");
    await click(submit());
    expect(sent()).toMatchObject({ cents: "10000", expectedPaidCents: "0" });
    expect(text($("[data-add-payment-result]"))).toBe("100 € lisatud · kviitung MSL2026-005. Koht kinnitub 145 € juures.");
  });

  test("S3-b: no receipt — under 50 %, already confirmed, full; with a receipt in a full session; without a session", async () => {
    /** One press: the card shown with `props`, the receipt unticked unless `receipt`, „Muu summa“ typed when `other`; the result line. */
    const press = async (result: Record<string, unknown>, o: { props?: Partial<Props>; receipt?: boolean; other?: string } = {}) => {
      actions.addManualPaymentAction.mockResolvedValue({ ok: true, addedCents: 14500, paidCents: 14500, status: "awaiting_prepayment", confirmedNow: false, full: false, receiptNumber: null, ...result });
      await show(o.props);
      await open();
      if (!o.receipt) $<HTMLInputElement>("[data-receipt]")!.click();
      if (o.other !== undefined) {
        await click(amount("Muu summa"));
        await type($<HTMLInputElement>("[data-other-amount]"), o.other);
      }
      await settle();
      await click(submit());
      return text($("[data-add-payment-result]"));
    };
    expect(await press({ addedCents: 4500, paidCents: 10000 }, { props: { registration: reg({ paidCents: 5500 }) }, other: "45" })).toBe("45 € lisatud. Koht kinnitub 145 € juures.");
    expect(await press({ addedCents: 14000, paidCents: 29000, status: "confirmed" }, { props: { registration: reg({ paidCents: 15000, status: "confirmed" }) } })).toBe("140 € lisatud.");
    expect(await press({ full: true })).toBe("145 € lisatud. Koolitus on vahepeal täis, nii et koht jäi kinnitamata.");
    expect(await press({ full: true, receiptNumber: "MSL2026-006" }, { receipt: true })).toBe("145 € lisatud · kviitung MSL2026-006. Koolitus on vahepeal täis, nii et koht jäi kinnitamata.");
    expect(await press({ status: "confirmed", confirmedNow: true }, { props: { session: null } })).toBe("145 € lisatud · registreering kinnitatud.");
    expect(await press({ status: "confirmed", confirmedNow: true, receiptNumber: "MSL2026-007" }, { props: { session: null }, receipt: true })).toBe("145 € lisatud · kviitung MSL2026-007 · registreering kinnitatud.");
    expect(await press({ addedCents: 10000, paidCents: 10000 }, { props: { session: null }, other: "100" })).toBe("100 € lisatud. Registreering kinnitub 145 € juures.");
  });

  test("refusals keep the panel open with their words: stale, a total moved past the price, seller gone, a future day, a server error", async () => {
    const refuse = async (error: string) => {
      actions.addManualPaymentAction.mockResolvedValue({ ok: false, error });
      await click(submit());
      expect($("[data-add-payment-panel]"), error).not.toBeNull();
      return text($("[data-add-payment-error]"));
    };
    await show();
    await open();
    expect(await refuse("stale")).toBe("Laekunud summa muutus vahepeal. Vaata summa üle ja lisa uuesti.");
    expect(await refuse("overRemainder")).toBe("Summa on suurem kui tasumata osa (290 €).");
    expect(await refuse("sellerMissing")).toBe("Täida enne Seaded → „Arve andmed“.");
    expect(await refuse("future")).toBe("Kontrolli andmeid. Kuupäev ei tohi olla tulevikus.");
    expect(await refuse("invalid")).toBe("Kontrolli andmeid. Kuupäev ei tohi olla tulevikus.");
    expect(await refuse("cancelled")).toBe("Registreerimine on tühistatud.");
    expect(await refuse("notFound")).toBe("Seda registreerimist ei leitud.");
    expect(await refuse("server")).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    // the refresh after `stale` brings the new total: the next press is built on it
    await show({ registration: reg({ paidCents: 5000 }) });
    actions.addManualPaymentAction.mockResolvedValue({ ok: true, addedCents: 9500, paidCents: 14500, status: "confirmed", confirmedNow: true, full: false, receiptNumber: "MSL2026-008" });
    expect(amounts()[0]).toEqual({ label: "95 € · ettemaks", checked: true });
    await click(submit());
    expect(sent()).toMatchObject({ cents: "9500", expectedPaidCents: "5000" });
  });

  test("a day after today is refused in the panel, nothing sent", async () => {
    await show();
    await open();
    await type($<HTMLInputElement>("[data-paid-date]"), "2026-10-21");
    await click(submit());
    expect(actions.addManualPaymentAction).not.toHaveBeenCalled();
    expect(text($("[data-add-payment-error]"))).toBe("Kontrolli andmeid. Kuupäev ei tohi olla tulevikus.");
  });
});
