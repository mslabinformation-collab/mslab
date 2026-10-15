// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Seaded → "Tunnistus" (phase 3d, spec §6, §4; Review Focus 4) in a browser-like document (happy-dom), with the server action answered here:
// the stored values in their fields, the save as typed, a next number at or below an issued one refused on its field with the last issued
// number beside it, and the trainer's name — Maria's signature, typed in the script font (owner, 15.10) — refused in words when the name
// rules refuse it. No picture and no file field anywhere: the signature is typed.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const action = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: action }));

import { CertificateSettings, type CertificateSettingsInitial } from "@/components/admin/CertificateSettings";

const PRACTICAL = "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine";
const INITIAL: CertificateSettingsInitial = {
  place: "Pärnu linn",
  registryCode: "16346048",
  practicalLine: PRACTICAL,
  trainerName: "Maria Sosnina",
  nextYear: 2026,
  nextSeq: 15,
  last: "MS LAB 2026-14",
};

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
/** The card as the page renders it (a new key: a new card, as a new page load gives). */
const show = async (initial: CertificateSettingsInitial = INITIAL) => {
  await act(async () => root.render(createElement(CertificateSettings, { key: JSON.stringify(initial), initial })));
  await settle();
};
const input = (hook: string) => $<HTMLInputElement>(`[data-cert-${hook}]`)!;
const errorOf = (hook: string) => document.getElementById(`${input(hook).id}-error`)?.textContent ?? null;
const hintOf = (hook: string) => document.getElementById(`${input(hook).id}-hint`)?.textContent ?? null;
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-cert-form]")!.requestSubmit());
  await settle();
};

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

describe("CertificateSettings", () => {
  test("the stored values in their fields; the last issued number beside the next one; the trainer's name is the signature, as its hint says; no picture, no file field", async () => {
    await show();
    expect(["place", "registry", "practical", "trainer", "next-year", "next-seq"].map((h) => input(h).value)).toEqual(["Pärnu linn", "16346048", PRACTICAL, "Maria Sosnina", "2026", "15"]);
    expect($("[data-cert-last]")!.textContent).toBe("Viimati väljastatud: MS LAB 2026-14");
    expect(hintOf("trainer")).toBe("Allkiri tunnistusel: see nimi kirjutatakse käekirjas alla paremale. Ladina tähtedega.");
    expect(input("trainer").getAttribute("aria-describedby")).toContain(`${input("trainer").id}-hint`);
    expect(container.querySelector('img, input[type="file"]')).toBeNull();
    expect($("[data-cert-save]")!.textContent).toBe("Salvesta tunnistuse andmed");
    await show({ ...INITIAL, last: null });
    expect($("[data-cert-last]")!.textContent).toBe("2026. aastal pole veel tunnistusi väljastatud.");
  });

  test("none issued yet names the year it is about (the year loaded, or saved), not 'this year': a preset for a later year says so; typing another year changes nothing until it is saved", async () => {
    await show({ ...INITIAL, nextYear: 2027, nextSeq: 20, last: null });
    expect($("[data-cert-last]")!.textContent).toBe("2027. aastal pole veel tunnistusi väljastatud.");
    await type(input("next-year"), "2030");
    expect($("[data-cert-last]")!.textContent).toBe("2027. aastal pole veel tunnistusi väljastatud.");
  });

  test("'Salvesta tunnistuse andmed' sends the fields as typed; saved, the fields take the stored values and the saved year's last number", async () => {
    action.mockResolvedValue({ ok: true, settings: { place: "Tallinn", registryCode: "16346048", practicalLine: PRACTICAL, trainerName: "Maria Sosnina", nextYear: 2027, nextSeq: 1 }, last: null });
    await show();
    await type(input("place"), "  Tallinn ");
    await type(input("next-year"), "2027");
    await type(input("next-seq"), "1");
    await submit();
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0][0]).toEqual({ place: "  Tallinn ", registryCode: "16346048", practicalLine: PRACTICAL, trainerName: "Maria Sosnina", nextYear: "2027", nextSeq: "1" });
    expect(input("place").value).toBe("Tallinn");
    expect($("[data-cert-status]")!.textContent).toBe("Tunnistuse andmed on salvestatud.");
    expect($("[data-cert-last]")!.textContent).toBe("2027. aastal pole veel tunnistusi väljastatud.");
  });

  test("Review Focus 4: a next number at or below one already issued is refused on its field, which takes the focus; the last issued number stays beside it", async () => {
    action.mockResolvedValue({ ok: false, fields: { nextSeq: "taken" } });
    await show();
    await type(input("next-seq"), "14");
    await submit();
    expect(input("next-seq").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input("next-seq"));
    expect(errorOf("next-seq")).toBe("See number on juba väljastatud. Vali suurem number kui viimati väljastatud.");
    expect(input("next-seq").getAttribute("aria-describedby")).toContain(`${input("next-seq").id}-error`);
    expect($("[data-cert-last]")!.textContent).toBe("Viimati väljastatud: MS LAB 2026-14");
    expect($("[data-cert-status]")!.textContent).toBe("Kontrolli märgitud välju.");
    expect(input("place").getAttribute("aria-invalid")).toBeNull();
    expect(input("next-seq").value).toBe("14"); // what she typed stays

    // the other codes in their own words; a code the card does not know in a general line
    action.mockResolvedValue({ ok: false, fields: { place: "required", registryCode: "tooLong", nextSeq: "invalid", trainerName: "somethingNew" } });
    await submit();
    expect([errorOf("place"), errorOf("registry"), errorOf("next-seq"), errorOf("trainer"), errorOf("next-year")]).toEqual([
      "Täida see väli.",
      "Tekst on liiga pikk.",
      "Kontrolli numbrit (1–99 999).",
      "Kontrolli seda välja.",
      null,
    ]);
    expect(document.activeElement).toBe(input("place"));
    // M-5: a year that is not this one or the next is refused on its own field, in its own words, and takes the focus
    action.mockResolvedValue({ ok: false, fields: { nextYear: "invalid" } });
    await type(input("next-year"), "2025");
    await submit();
    expect([errorOf("next-year"), errorOf("next-seq")]).toEqual(["Aasta peab olema käesolev või järgmine.", null]);
    expect(input("next-year").getAttribute("aria-invalid")).toBe("true");
    expect(input("next-year").getAttribute("aria-describedby")).toContain(`${input("next-year").id}-error`);
    expect(document.activeElement).toBe(input("next-year"));
    expect(input("next-year").value).toBe("2025");
    action.mockResolvedValue({ ok: false, fields: { nextYear: "invalid", nextSeq: "invalid" } });
    await submit();
    expect([errorOf("next-year"), errorOf("next-seq")]).toEqual(["Aasta peab olema käesolev või järgmine.", "Kontrolli numbrit (1–99 999)."]);
    action.mockResolvedValue({ ok: false, error: "server" });
    await submit();
    expect($("[data-cert-status]")!.textContent).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
  });

  test("the trainer's name in Cyrillic or of one letter is refused on its field in words (Latin letters as in the passport), which takes the focus; what she typed stays", async () => {
    action.mockResolvedValue({ ok: false, fields: { trainerName: "letters" } });
    await show();
    await type(input("trainer"), "Мария Соснина");
    await submit();
    expect(action.mock.calls[0][0]).toMatchObject({ trainerName: "Мария Соснина" });
    expect(input("trainer").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input("trainer"));
    expect(errorOf("trainer")).toBe("Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma).");
    expect(input("trainer").getAttribute("aria-describedby")).toContain(`${input("trainer").id}-error`);
    expect(input("trainer").value).toBe("Мария Соснина");
    expect($("[data-cert-status]")!.textContent).toBe("Kontrolli märgitud välju.");
    action.mockResolvedValue({ ok: false, fields: { trainerName: "length" } });
    await type(input("trainer"), "M");
    await submit();
    expect(errorOf("trainer")).toBe("Nimi on liiga lühike.");
  });
});
