// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PLACEHOLDERS } from "@/domain/contract";
import { adminEt } from "@/i18n/dict/admin";

// Seaded → „Lepingud“ (contracts Task 5, spec D2, §4; ruling R3) in a browser-like document (happy-dom), with the server action answered here: the
// contact contract's title and text in their fields, ET and RU, the hint „Tühi rida alustab uut lõiku.“, the placeholders listed from the one list
// the server fills them by (domain/contract.ts PLACEHOLDERS), the save as typed, a refused field marked in words with the focus on the first, and
// „Näidisleping (PDF)“ as a form that posts the card's texts as they stand on the screen, saved or not, to a new tab.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ saveContractTextsAction: vi.fn(), requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));
vi.mock("@/server/actions/admin-contracts", () => actions);

import { ContractTexts } from "@/components/admin/ContractTexts";
import { EditLangProvider, LangSwitch } from "@/components/admin/EditLang";
import type { ContractCard } from "@/server/contracts";

const EMPTY: ContractCard = { title: { et: "", ru: "" }, body: { et: "", ru: "" } };
const WRITTEN: ContractCard = {
  title: { et: "Kontaktkoolituse leping", ru: "Договор очного обучения" },
  body: { et: "Õpilane {nimi} registreerub koolitusele {koolitus}.\n\nHind {hind}.", ru: "Ученик {nimi} записывается на курс {koolitus}." },
};

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const all = <E extends Element = HTMLElement>(selector: string) => [...container.querySelectorAll<E>(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
/** The card as the page renders it (a new key: a new card, as a new page load gives), under the panel's EditLangProvider with the page's ET | RU switch (Seaded has it in its heading). */
const show = async (initial: ContractCard = WRITTEN) => {
  await act(async () => root.render(createElement(EditLangProvider, null, createElement(LangSwitch), createElement(ContractTexts, { key: JSON.stringify(initial), initial }))));
  await settle();
};
/** The field of the language now shown: title or body. */
const field = (name: "title" | "body") => $<HTMLInputElement | HTMLTextAreaElement>(`[data-i18n="contract.${name}"]`)!;
/** The page's ET | RU switch: both fields (and every other on the page) change language with it. */
const switchTo = async (lang: "et" | "ru") => {
  await act(async () => $<HTMLButtonElement>(`[data-edit-lang-switch] [data-edit-lang="${lang}"]`)!.click());
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-contract-form]")!.requestSubmit());
  await settle();
};
const hidden = (name: string) => $<HTMLInputElement>(`[data-contract-sample-form] input[name="${name}"]`)!.value;
const status = () => $('[role="status"]')!.textContent;

beforeEach(() => {
  localStorage.clear(); // (the language is kept per device)
  for (const fn of Object.values(actions)) fn.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ContractTexts: the card", () => {
  test("the card is called „Lepingud“, with the anchor; the contact contract's title and text in their fields, Estonian first", async () => {
    await show();
    expect($("h2")!.textContent).toBe("Lepingud");
    expect($("section")!.id).toBe("lepingud");
    expect($("h3")!.textContent).toBe("Kontaktkoolituse leping");
    expect(field("title").value).toBe("Kontaktkoolituse leping");
    expect(field("body").value).toBe("Õpilane {nimi} registreerub koolitusele {koolitus}.\n\nHind {hind}.");
    expect(field("body").tagName).toBe("TEXTAREA");
    expect($("[data-contract-save]")!.textContent).toBe("Salvesta lepingud");
  });

  test("the Russian texts are behind the page's RU switch, each in its own field", async () => {
    await show();
    await switchTo("ru");
    expect(field("title").value).toBe("Договор очного обучения");
    expect(field("body").value).toBe("Ученик {nimi} записывается на курс {koolitus}.");
  });

  test("a card with nothing written shows empty fields and does not fill in the public „Õppetingimused“ text; its lead says what the student sees meanwhile", async () => {
    await show(EMPTY);
    expect([field("title").value, field("body").value]).toEqual(["", ""]);
    expect(container.textContent).toContain("Kuni siia teksti pole kirjutatud, näeb õpilane lepinguna lehe „Õppetingimused“ teksti.");
  });

  test("the hint „Tühi rida alustab uut lõiku.“ describes the text", async () => {
    await show();
    const hint = field("body").closest("div")!.querySelector("p")!;
    expect(hint.textContent).toBe("Tühi rida alustab uut lõiku.");
    expect(field("body").getAttribute("aria-describedby")).toContain(hint.id);
  });

  test("the hint lists the placeholders — exactly domain/contract.ts PLACEHOLDERS, each braced, each with what fills it", async () => {
    await show();
    const items = all("[data-contract-placeholders] li");
    expect(items.map((li) => li.querySelector("code")!.textContent)).toEqual(PLACEHOLDERS.map((name) => `{${name}}`));
    expect(items.map((li) => li.textContent)).toEqual(PLACEHOLDERS.map((name) => `{${name}} — ${adminEt.contracts.settings.placeholderMeaning[name]}`));
    expect($("[data-contract-placeholders]")!.textContent).toContain("Tundmatu sõna looksulgudes jääb tekstis alles.");
  });

  test("the limits of the legal texts are on the fields (a title of 120, a text of 30 000)", async () => {
    await show();
    expect([field("title").maxLength, field("body").maxLength]).toEqual([120, 30_000]);
  });
});

describe("ContractTexts: the save", () => {
  test("it sends the texts as typed, both languages, and shows what came back as stored (trimmed)", async () => {
    actions.saveContractTextsAction.mockResolvedValue({ ok: true, card: { title: { et: "Uus leping", ru: "Новый договор" }, body: { et: "Uus tekst.", ru: "Новый текст." } } });
    await show();
    await type(field("title"), "  Uus leping ");
    await type(field("body"), " Uus tekst. ");
    await switchTo("ru");
    await type(field("title"), " Новый договор ");
    await type(field("body"), " Новый текст. ");
    await submit();
    expect(actions.saveContractTextsAction).toHaveBeenCalledTimes(1);
    expect(actions.saveContractTextsAction).toHaveBeenCalledWith({
      title: { et: "  Uus leping ", ru: " Новый договор " },
      body: { et: " Uus tekst. ", ru: " Новый текст. " },
    });
    expect(status()).toBe("Lepingud on salvestatud.");
    expect(field("body").value).toBe("Новый текст."); // the RU tab is still shown, now as stored
    await switchTo("et");
    expect(field("body").value).toBe("Uus tekst.");
    expect(field("title").value).toBe("Uus leping");
  });

  test("a refused field is marked in words, the first takes the focus, and the status says to check them; nothing is overwritten", async () => {
    actions.saveContractTextsAction.mockResolvedValue({ ok: false, fields: { title: "required", body: "tooLong" } });
    await show(EMPTY);
    await submit();
    expect(status()).toBe("Kontrolli märgitud välju.");
    expect($('[role="status"]')!.className).toContain("error");
    expect(field("title").getAttribute("aria-invalid")).toBe("true");
    expect(field("body").getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field("title").getAttribute("aria-describedby")!.split(" ").find((id) => id.endsWith("-error"))!)!.textContent).toBe("Täida see väli (eesti keeles).");
    expect(document.getElementById(field("body").getAttribute("aria-describedby")!.split(" ").find((id) => id.endsWith("-error"))!)!.textContent).toBe("Tekst on liiga pikk.");
    expect(document.activeElement).toBe(field("title"));
  });

  test("a code this card does not know (the form shape) is the general words; a throw of the server is the save error", async () => {
    actions.saveContractTextsAction.mockResolvedValueOnce({ ok: false, fields: { title: "weird" } });
    await show(EMPTY);
    await submit();
    expect(document.getElementById(field("title").getAttribute("aria-describedby")!.split(" ").find((id) => id.endsWith("-error"))!)!.textContent).toBe("Kontrolli märgitud välju.");
    actions.saveContractTextsAction.mockResolvedValueOnce({ ok: false, error: "server" });
    await submit();
    expect(status()).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
  });

  test("a save is taken once while it is on its way", async () => {
    let finish!: (v: unknown) => void;
    actions.saveContractTextsAction.mockReturnValue(new Promise((r) => (finish = r)));
    await show();
    await submit();
    expect(status()).toBe("Salvestan…");
    await submit();
    expect(actions.saveContractTextsAction).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, card: WRITTEN }));
    await settle();
    expect(status()).toBe("Lepingud on salvestatud.");
  });
});

describe("ContractTexts: „Näidisleping (PDF)“", () => {
  test("a form that posts to the sample route, into a new tab, with the card's texts in hidden fields", async () => {
    await show();
    const form = $<HTMLFormElement>("[data-contract-sample-form]")!;
    expect([form.getAttribute("method"), form.getAttribute("action"), form.getAttribute("target")]).toEqual(["post", "/api/admin/naidisleping", "_blank"]);
    expect(["titleEt", "titleRu", "bodyEt", "bodyRu"].map(hidden)).toEqual([WRITTEN.title.et, WRITTEN.title.ru, WRITTEN.body.et, WRITTEN.body.ru]);
    const buttons = all<HTMLButtonElement>("button[data-contract-sample]");
    expect(buttons.map((b) => [b.textContent, b.getAttribute("type"), b.getAttribute("name"), b.getAttribute("value")])).toEqual([
      ["Näidisleping (PDF)", "submit", "lang", "et"],
      ["Näidisleping vene keeles (PDF)", "submit", "lang", "ru"],
    ]);
    expect($("[data-contract-sample-form]")!.textContent).toContain("Näidis tehakse kaardi praegustest väärtustest, ka salvestamata. Midagi ei salvestata.");
  });

  test("it is a form of its own, not inside the save form (a form cannot sit inside another)", async () => {
    await show();
    expect($("[data-contract-form] [data-contract-sample-form]")).toBeNull();
    expect($("[data-contract-form] [data-contract-sample]")).toBeNull();
  });

  test("the hidden fields follow the screen, saved or not: a text typed is in the sample before the save; nothing is saved by it", async () => {
    await show();
    await type(field("title"), "Muudetud pealkiri");
    await type(field("body"), "Muudetud tekst, {nimi}.");
    expect([hidden("titleEt"), hidden("bodyEt")]).toEqual(["Muudetud pealkiri", "Muudetud tekst, {nimi}."]);
    await switchTo("ru");
    await type(field("body"), "Измененный текст.");
    expect(hidden("bodyRu")).toBe("Измененный текст.");
    expect(actions.saveContractTextsAction).not.toHaveBeenCalled();
  });

  test("the Russian sample is offered only once a Russian text is written; an Estonian one alone has the one sample", async () => {
    await show(EMPTY);
    expect(all("button[data-contract-sample]").map((b) => b.textContent)).toEqual(["Näidisleping (PDF)"]);
    await switchTo("ru");
    await type(field("body"), "Текст.");
    expect(all("button[data-contract-sample]").map((b) => b.textContent)).toEqual(["Näidisleping (PDF)", "Näidisleping vene keeles (PDF)"]);
    await type(field("body"), "   ");
    expect(all("button[data-contract-sample]").map((b) => b.textContent)).toEqual(["Näidisleping (PDF)"]);
  });
});
