// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The Raha card's discount rows (F1 Task 14; spec D11, §5; the design „Raha-kaart“) in a browser-like document (happy-dom), with the two server actions
// answered here: the row „{code} · −{amount}“, „Lisa sooduskood“ opening the field with „Lisa“, „Eemalda sooduskood“ asking „Kas eemaldan sooduskoodi?
// Hind on jälle {price}.“, what each press sends, and each refusal's text.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ addRegistrationDiscountAction: vi.fn(), removeRegistrationDiscountAction: vi.fn() }));
vi.mock("@/server/actions/admin-discounts", () => actions);

import { RegistrationDiscount } from "@/components/admin/RegistrationDiscount";

type Props = Parameters<typeof RegistrationDiscount>[0];
const props = (over: Partial<Props> = {}): Props => ({ registrationId: 7, listCents: 35000, totalCents: 35000, code: null, cancelled: false, ...over });
const WITH_CODE = { totalCents: 28000, code: "JOULUD-20" };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = async (over: Partial<Props> = {}) => {
  await act(async () => root.render(createElement(RegistrationDiscount, props(over))));
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
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === label) ?? null;

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

describe("the rows", () => {
  test("no code: „Hind“ alone and the quiet button „Lisa sooduskood“", async () => {
    await show();
    expect(text($("[data-discount-price]"))).toBe("350 €");
    expect($("[data-discount-price] s")).toBeNull();
    expect(text($("[data-discount-code]"))).toBe("Lisa sooduskood");
    expect($("[data-discount-form]")).toBeNull();
  });

  test("the row shows code · −amount, the list price struck through and the total", async () => {
    await show(WITH_CODE);
    expect(text($("[data-discount-price] s"))).toBe("350 €");
    expect(text($("[data-discount-price]"))).toBe("350 €280 €"); // (the gap is CSS)
    expect(text($("[data-discount-code]"))).toBe("JOULUD-20 · −70 €Eemalda sooduskood");
  });

  test("a cancelled registration shows the rows and no button", async () => {
    await show({ ...WITH_CODE, cancelled: true });
    expect(text($("[data-discount-code]"))).toBe("JOULUD-20 · −70 €");
    expect($("[data-discount-open]")).toBeNull();
  });
});

describe("Lisa sooduskood", () => {
  test("Lisa sooduskood opens the field with Lisa, and Katkesta closes it", async () => {
    await show();
    await click($("[data-discount-open]"));
    expect(text($("[data-discount-form] label"))).toBe("Sooduskood");
    expect(text($("[data-discount-add-submit]"))).toBe("Lisa");
    expect(button("Katkesta")).not.toBeNull();
    await click(button("Katkesta"));
    expect($("[data-discount-form]")).toBeNull();
    expect(text($("[data-discount-code]"))).toBe("Lisa sooduskood");
  });

  test("Lisa sends the registration and the text as typed, and closes on success", async () => {
    actions.addRegistrationDiscountAction.mockResolvedValue({ ok: true });
    await show();
    await click($("[data-discount-open]"));
    await type($<HTMLInputElement>("[data-discount-code-input]"), " joulud-20 ");
    await click($("[data-discount-add-submit]"));
    expect(actions.addRegistrationDiscountAction).toHaveBeenCalledWith({ registrationId: 7, code: " joulud-20 " });
    expect($("[data-discount-form]")).toBeNull();
  });

  test("an empty field is refused in the field, nothing sent", async () => {
    await show();
    await click($("[data-discount-open]"));
    await click($("[data-discount-add-submit]"));
    expect(actions.addRegistrationDiscountAction).not.toHaveBeenCalled();
    expect(text($("[data-discount-error]"))).toBe("Sellist sooduskoodi ei ole.");
  });

  test("each refusal shows its text", async () => {
    await show();
    await click($("[data-discount-open]"));
    await type($<HTMLInputElement>("[data-discount-code-input]"), "X");
    const refusals: [string, string][] = [
      ["paid", "Sooduskoodi saab lisada, kui midagi pole veel laekunud."],
      ["unpaidInvoice", "Tühista enne maksmata arve."],
      ["unknown", "Sellist sooduskoodi ei ole."],
      ["stale", "Sooduskood muutus vahepeal. Vaata registreeringut uuesti."],
      ["cancelled", "Registreering on tühistatud."],
      ["worthless", "Sellele hinnale sooduskood ei mõju."],
      ["server", "Salvestamine ei õnnestunud. Proovi uuesti."],
    ];
    for (const [error, line] of refusals) {
      actions.addRegistrationDiscountAction.mockResolvedValue({ ok: false, error });
      await click($("[data-discount-add-submit]"));
      expect(text($("[data-discount-error]")), error).toBe(line);
      expect($("[data-discount-form]"), error).not.toBeNull(); // the field stays, for another try
    }
    // typing clears the line
    await type($<HTMLInputElement>("[data-discount-code-input]"), "Y");
    expect(text($("[data-discount-error]"))).toBe("");
    // a call that never answers is the save error
    actions.addRegistrationDiscountAction.mockRejectedValue(new Error("offline"));
    await click($("[data-discount-add-submit]"));
    expect(text($("[data-discount-error]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
  });
});

describe("Eemalda sooduskood", () => {
  test("Eemalda asks Kas eemaldan sooduskoodi? Hind on jälle {price}.", async () => {
    await show(WITH_CODE);
    await click($("[data-discount-open]"));
    expect(text($("[data-discount-remove-sure] p"))).toBe("Kas eemaldan sooduskoodi? Hind on jälle 350 €.");
    expect(button("Jah, eemalda")).not.toBeNull();
    expect(button("Katkesta")).not.toBeNull();
    expect(actions.removeRegistrationDiscountAction).not.toHaveBeenCalled();
    await click(button("Katkesta"));
    expect($("[data-discount-remove-sure]")).toBeNull();
    expect(text($("[data-discount-code]"))).toBe("JOULUD-20 · −70 €Eemalda sooduskood");
  });

  test("Jah, eemalda sends the registration; a refusal shows its text and keeps the question", async () => {
    await show(WITH_CODE);
    await click($("[data-discount-open]"));
    actions.removeRegistrationDiscountAction.mockResolvedValue({ ok: false, error: "unpaidInvoice" });
    await click(button("Jah, eemalda"));
    expect(actions.removeRegistrationDiscountAction).toHaveBeenCalledWith({ registrationId: 7 });
    expect(text($("[data-discount-remove-sure] [data-discount-error]"))).toBe("Tühista enne maksmata arve.");
    actions.removeRegistrationDiscountAction.mockResolvedValue({ ok: true });
    await click(button("Jah, eemalda"));
    expect($("[data-discount-remove-sure]")).toBeNull();
  });
});
