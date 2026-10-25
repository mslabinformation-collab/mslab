// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { adminEt } from "@/i18n/dict/admin";

// "Paranda nimi" in a student's drawer (phase 3d, spec §6, D3; Review Focus 2) in a browser-like document (happy-dom), with the server action
// answered here: the form in place with the name as printed, the student's rules' refusals on the field, the line that says what was done
// (it stays, and takes the focus), "Katkesta", and a certificate gone meanwhile or a failure.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const action = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/admin-certificates", () => ({ reissueCertificateAction: action }));

import { ReissueCertificate } from "@/components/admin/ReissueCertificate";

const t = { ...adminEt.certificates.reissue, saving: adminEt.common.saving, error: adminEt.common.saveError };
const VIEW = { id: 7, number: "MS LAB 2026-03", name: "Kätlin Kask", issuedAt: "2026-10-19T10:00:00.000Z", reissuedAt: "2026-10-20T09:00:00.000Z" };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = async () => {
  await act(async () => root.render(createElement(ReissueCertificate, { certificateId: 7, name: "Kätlin Kask-Žukova", t })));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-reissue-form]")!.requestSubmit());
  await settle();
};
const field = () => $<HTMLInputElement>("[data-reissue-name]")!;

beforeEach(() => {
  action.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ReissueCertificate", () => {
  test("one button; its form has the name as printed, which takes the focus; 'Katkesta' closes it with the focus back on the button, nothing sent", async () => {
    await show();
    expect($("[data-reissue]")!.textContent).toBe("Paranda nimi");
    expect($("[data-reissue-form]")).toBeNull();
    await click($("[data-reissue]"));
    expect(field().value).toBe("Kätlin Kask-Žukova");
    expect(document.activeElement).toBe(field());
    expect(container.querySelector(`label[for="${field().id}"]`)!.textContent).toBe("Nimi tunnistusel");
    expect(container.textContent).toContain("Tunnistus väljastatakse uuesti sama numbriga. Õpilasele kirja ei saadeta.");
    expect($("[data-reissue-save]")!.textContent).toBe("Väljasta uuesti");
    await click(button("Katkesta"));
    expect($("[data-reissue-form]")).toBeNull();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(document.activeElement).toBe($("[data-reissue]"));
    expect(action).not.toHaveBeenCalled();
  });

  test("'Väljasta uuesti' sends the certificate and the name as typed; re-issued: the line says so under the same number and takes the focus", async () => {
    action.mockResolvedValue({ kind: "reissued", certificate: VIEW });
    await show();
    await click($("[data-reissue]"));
    await type(field(), " Kätlin  Kask ");
    await submit();
    expect(action.mock.calls).toEqual([[{ certificateId: 7, name: " Kätlin  Kask " }]]);
    expect($("[data-reissue-form]")).toBeNull();
    const done = $("[data-reissue-done]")!;
    expect(done.textContent).toBe("Tunnistus MS LAB 2026-03 on uuesti väljastatud nimega Kätlin Kask.");
    expect(document.activeElement).toBe(done);
    expect($("[data-reissue]")).not.toBeNull(); // another correction stays possible
  });

  test("Review Focus 2: an emoji or digits, or a name too short, are refused on the field in the student's words; the form stays with what was typed", async () => {
    action.mockResolvedValueOnce({ kind: "invalid", error: "letters" });
    await show();
    await click($("[data-reissue]"));
    await type(field(), "Kati 😀");
    await submit();
    expect($("[data-reissue-error]")!.textContent).toBe("Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma).");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")).toContain($("[data-reissue-error]")!.id);
    expect(field().value).toBe("Kati 😀");
    expect(document.activeElement).toBe(field());
    action.mockResolvedValueOnce({ kind: "invalid", error: "length" });
    await type(field(), "K");
    await submit();
    expect($("[data-reissue-error]")!.textContent).toBe("Nimi peab olema 2–80 tähemärki pikk.");
    expect($("[data-reissue-done]")!.textContent).toBe("");
  });

  test("M-8: the same refused name sent twice: the alert goes while the second is on its way and comes back, a new one, so it is announced again", async () => {
    let answer!: (result: unknown) => void;
    action.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await show();
    await click($("[data-reissue]"));
    await type(field(), "Kati 2");
    await act(async () => $<HTMLFormElement>("[data-reissue-form]")!.requestSubmit());
    await act(async () => answer({ kind: "invalid", error: "letters" }));
    await settle();
    const first = $("[data-reissue-error]")!;
    expect([first.textContent, first.getAttribute("role")]).toEqual(["Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma).", "alert"]);
    await act(async () => $<HTMLFormElement>("[data-reissue-form]")!.requestSubmit());
    expect($("[data-reissue-error]")).toBeNull(); // emptied by the press
    expect(field().hasAttribute("aria-invalid")).toBe(false);
    await act(async () => answer({ kind: "invalid", error: "letters" }));
    await settle();
    const second = $("[data-reissue-error]")!;
    expect([second.textContent, second.getAttribute("role")]).toEqual([first.textContent, "alert"]);
    expect(second).not.toBe(first); // a new alert: a screen reader reads it again
    expect(document.activeElement).toBe(field());
  });

  test("a certificate gone meanwhile, or a failure, says so; the form stays open", async () => {
    action.mockResolvedValueOnce({ kind: "notFound" });
    await show();
    await click($("[data-reissue]"));
    await submit();
    expect($("[data-reissue-error]")!.textContent).toBe("Seda tunnistust ei leitud. Laadi leht uuesti.");
    action.mockResolvedValueOnce({ kind: "failed" });
    await submit();
    expect($("[data-reissue-error]")!.textContent).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect($("[data-reissue-form]")).not.toBeNull();
  });
});
