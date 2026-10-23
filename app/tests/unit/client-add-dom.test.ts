// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AddStudentForm } from "@/components/admin/ClientForms";
import { adminEt } from "@/i18n/dict/admin";

// „Lisa õpilane +“ in the list's header (README A5): the button opens a small inline form (the e-mail and „Lisa õpilane“; the typo guard as the login page
// has it); the list it was opened from (its address's form, search and page) goes with the e-mail, so the drawer opens over the same list.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { ok: true; id?: number } | { ok: false; error: string };
const add = vi.hoisted(() => vi.fn<(prev: unknown, formData: FormData) => Promise<Answer>>());
vi.mock("@/server/actions/admin-clients", () => ({
  addStudent: add,
  grantCourseAccess: vi.fn(),
  revokeCourseAccess: vi.fn(),
  unlockNextLesson: vi.fn(),
}));

const t = { ...adminEt.clients.add, saving: adminEt.common.saving, error: adminEt.common.saveError };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const draw = async (back = "") => {
  await act(async () => root.render(createElement(AddStudentForm, { t, back })));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const toggle = () => $<HTMLButtonElement>("[data-add-toggle]")!;
const field = () => $<HTMLInputElement>("[data-add-student] input[name=email]")!;
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;
const type = async (value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-add-student]")!.requestSubmit());
  await settle();
};

beforeEach(() => {
  add.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("„Lisa õpilane +“", () => {
  test("a button that opens the small form: closed to begin with, the e-mail field takes the focus, the button again closes it and takes the focus back", async () => {
    await draw();
    expect(toggle().textContent).toBe("Lisa õpilane +");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect($("[data-add-student]")).toBeNull();
    await click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().getAttribute("aria-controls")).toBe($("[data-add-student]")!.id);
    expect($("[data-add-student] label")!.textContent).toBe("Lisa õpilane e-posti järgi");
    expect(document.activeElement).toBe(field());
    expect(button("Lisa õpilane")).not.toBeNull();
    await click(toggle());
    expect($("[data-add-student]")).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  test("Esc inside the form closes it (and only it)", async () => {
    await draw();
    await click(toggle());
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    await act(async () => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    document.removeEventListener("keydown", outer);
    expect($("[data-add-student]")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(toggle());
  });

  test("the e-mail goes with the list it was added from; a bad address says what to do and sends nothing the server accepts", async () => {
    add.mockResolvedValueOnce({ ok: false, error: "email" });
    await draw("vorm=e&otsi=kati");
    await click(toggle());
    await type("mari@");
    await submit();
    expect(add).toHaveBeenCalledTimes(1);
    const sent = add.mock.calls[0][1];
    expect([sent.get("email"), sent.get("back")]).toEqual(["mari@", "vorm=e&otsi=kati"]);
    expect($("[data-add-student] [role='status']")!.textContent).toBe("Sisesta korrektne e-posti aadress.");
    expect(field().getAttribute("aria-invalid")).toBe("true");
  });

  test("an obvious typo asks first: „Ei, lisa nii“ sends it as typed, „Jah, paranda“ the corrected address; typing again takes the question away", async () => {
    add.mockResolvedValue({ ok: true });
    // built at run time, as the login tests do: a typo domain is not an example address, and no real address may stand in a tracked file (test-addresses.test.ts)
    const typed = ["mari", "gmial.com"].join("@");
    const fixed = typed.replace("gmial.com", "gmail.com");
    await draw("leht=2");
    await click(toggle());
    await type(typed);
    await submit();
    expect(add).not.toHaveBeenCalled();
    expect($("[data-add-typo]")!.textContent).toContain(`Kas mõtlesid ${fixed}?`);
    expect(document.activeElement).toBe(button("Jah, paranda"));
    await type(typed.slice(0, -1)); // (typing again takes the question away)
    expect($("[data-add-typo]")).toBeNull();
    await type(typed);
    await submit();
    await click(button("Ei, lisa nii"));
    expect(add.mock.calls[0][1].get("email")).toBe(typed);
    expect(add.mock.calls[0][1].get("back")).toBe("leht=2");
    await submit();
    await click(button("Jah, paranda"));
    expect(add.mock.calls[1][1].get("email")).toBe(fixed);
  });
});
