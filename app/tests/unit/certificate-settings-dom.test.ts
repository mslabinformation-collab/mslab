// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEBOUNCE_MS } from "@/components/admin/autosave/constants";
import type { AutosaveStatus } from "@/domain/autosave";
import { stubFetch } from "../fakes";

// Seaded → "Tunnistus" (phase 3d, spec §6, §4; admin UX pass piece 3b, Task 4: README B4, piece3-texts P-10 and §4, spec D6) in a browser-like
// document (happy-dom), with the route answered here: the stored values in their fields, no save button (the card autosaves on
// api/admin/seaded/certificate under the page's one status), „Järgmine number“ keeps its „Aasta“ and „Number“ with the preview „Järgmine tunnistus:
// MS LAB {year}-{nn}“ under them; the two numbers commit on blur, and a number already issued is refused in the field (`taken`, Review Focus 4). The
// trainer's name — Maria's signature, typed in the script font (owner, 15.10) — is refused in words when the name rules refuse it. No picture and no
// file field anywhere.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/admin/seaded", useSearchParams: () => new URLSearchParams() }));

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
  version: "c:t1.c1",
};

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
let version: string;
let refuse: Record<string, string> | null;
let statuses: AutosaveStatus[];
const route = async (url: string, init: RequestInit | undefined): Promise<Response> => {
  if (url !== "/api/admin/seaded/certificate") return Response.json({ ok: false }, { status: 404 });
  const body = JSON.parse(String(init?.body)) as { version: string };
  if (refuse) {
    const fields = refuse;
    refuse = null;
    return Response.json({ ok: false, error: "invalid", fields }, { status: 400 });
  }
  if (body.version !== version) return Response.json({ ok: false, error: "conflict", version, value: {} }, { status: 409 });
  version = `${version}+`;
  return Response.json({ ok: true, version, savedAt: "2026-10-25T11:20:00.000Z" });
};
const sent = () => fetched.calls.map((c) => c.body as { version: string; patch: Record<string, unknown> });

const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
let mounts = 0;
/** The card as the page renders it (a new card, as a new page load gives). */
const show = async (initial: CertificateSettingsInitial = INITIAL) => {
  await act(async () => root.render(createElement(CertificateSettings, { key: ++mounts, initial, onStatus: (_key: string, s: AutosaveStatus) => void statuses.push(s) })));
  await settle();
};
const input = (hook: string) => $<HTMLInputElement>(`[data-cert-${hook}]`)!;
const errorOf = (hook: string) => document.getElementById(`${input(hook).id}-error`)?.textContent ?? null;
const hintOf = (hook: string) => document.getElementById(`${input(hook).id}-hint`)?.textContent ?? null;
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const leave = (el: Element) => act(async () => void el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const preview = () => text($("[data-cert-preview]"));

beforeEach(() => {
  for (const fn of Object.values(router)) fn.mockReset();
  version = "c:t1.c1";
  refuse = null;
  statuses = [];
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  fetched = stubFetch(route);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetched.restore();
  vi.useRealTimers();
});

describe("CertificateSettings", () => {
  test("the stored values in their fields; „Järgmine number“ keeps „Aasta“ and „Number“, the preview and the last issued number under them; the signature's hint; no save button, no picture", async () => {
    await show();
    expect(text($("h2"))).toBe("Tunnistus");
    expect(["place", "registry", "practical", "trainer", "next-year", "next-seq"].map((h) => input(h).value)).toEqual(["Pärnu linn", "16346048", PRACTICAL, "Maria Sosnina", "2026", "15"]);
    expect(text($("legend"))).toBe("Järgmine number");
    expect(preview()).toBe("Järgmine tunnistus: MS LAB 2026-15");
    expect(text($("[data-cert-last]"))).toBe("Viimati väljastatud: MS LAB 2026-14");
    expect(container.textContent).toContain("Jätka oma paberil tunnistuste numbreid. Uue aasta esimene tunnistus saab numbri 1.");
    expect(hintOf("trainer")).toBe("Allkiri tunnistusel: see nimi kirjutatakse käekirjas alla paremale. Ladina tähtedega.");
    expect(container.querySelector('img, input[type="file"]')).toBeNull();
    expect(container.querySelector("button[type=submit], [data-cert-save]")).toBeNull();
    expect(container.textContent).not.toContain("Salvesta");
    await show({ ...INITIAL, nextSeq: 3, last: null });
    expect(preview()).toBe("Järgmine tunnistus: MS LAB 2026-03");
    expect(text($("[data-cert-last]"))).toBe("2026. aastal pole veel tunnistusi väljastatud.");
  });

  test("a text field saves 1.5 s after typing, only what changed, from the card's version; its status is told", async () => {
    await show();
    await type(input("place"), "Tallinn");
    await wait(DEBOUNCE_MS + 100);
    await settle();
    expect(sent()).toEqual([{ version: "c:t1.c1", patch: { place: "Tallinn" } }]);
    expect(statuses.at(-1)!.kind).toBe("saved");
  });

  test("„Aasta“ and „Number“ commit on blur: typing sends nothing and the preview follows it; left, they are saved together (review M-3)", async () => {
    await show();
    await type(input("next-seq"), "93");
    expect(preview()).toBe("Järgmine tunnistus: MS LAB 2026-93");
    await wait(DEBOUNCE_MS * 3);
    expect(sent()).toEqual([]);
    await leave(input("next-seq"));
    await settle();
    expect(sent()).toEqual([{ version: "c:t1.c1", patch: { nextYear: "2026", nextSeq: "93" } }]);
    await type(input("next-year"), "2027");
    expect(preview()).toBe("Järgmine tunnistus: MS LAB 2027-93");
    await wait(DEBOUNCE_MS * 2);
    expect(sent()).toHaveLength(1);
    await leave(input("next-year"));
    await settle();
    expect(sent().at(-1)).toEqual({ version: "c:t1.c1+", patch: { nextYear: "2027", nextSeq: "93" } });
    // another year stored: the page is read again (the year's last issued number); a number alone does not
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // a number that is not one: no preview to show
    await type(input("next-seq"), "x");
    expect($("[data-cert-preview]")).toBeNull();
  });

  test("Review Focus 4: a number already issued is refused in its field, with the last issued number beside it and the typed number kept; the other codes in their own words", async () => {
    refuse = { nextSeq: "taken" };
    await show();
    await type(input("next-seq"), "14");
    await leave(input("next-seq"));
    await settle();
    expect(input("next-seq").getAttribute("aria-invalid")).toBe("true");
    expect(errorOf("next-seq")).toBe("See number on juba väljastatud. Vali suurem number kui viimati väljastatud.");
    expect(input("next-seq").getAttribute("aria-describedby")).toContain(`${input("next-seq").id}-error`);
    expect(text($("[data-cert-last]"))).toBe("Viimati väljastatud: MS LAB 2026-14");
    expect(input("next-seq").value).toBe("14");
    expect(statuses.at(-1)!.kind).toBe("invalid");
    // M-5: a year that is not this one or the next, in its own words
    refuse = { nextYear: "invalid" };
    await type(input("next-year"), "2025");
    await leave(input("next-year"));
    await settle();
    expect(errorOf("next-year")).toBe("Aasta peab olema käesolev või järgmine.");
    refuse = { place: "required" };
    await type(input("place"), " ");
    await leave(input("place"));
    await settle();
    refuse = { registryCode: "tooLong" };
    await type(input("registry"), "1".repeat(20));
    await leave(input("registry"));
    await settle();
    expect([errorOf("place"), errorOf("registry")]).toEqual(["Täida see väli.", "Tekst on liiga pikk."]);
  });

  test("review M-3: back from a December preset, the year left alone goes with the number shown; refused on the number (taken), the next number typed goes with that year", async () => {
    refuse = { nextSeq: "taken" };
    await show({ ...INITIAL, nextYear: 2027, nextSeq: 1, last: null });
    await type(input("next-year"), "2026");
    await leave(input("next-year"));
    await settle();
    expect(sent()).toEqual([{ version: "c:t1.c1", patch: { nextYear: "2026", nextSeq: "1" } }]);
    expect(errorOf("next-seq")).toBe("See number on juba väljastatud. Vali suurem number kui viimati väljastatud.");
    expect(errorOf("next-year")).toBeNull();
    expect(statuses.at(-1)!.kind).toBe("invalid");
    await type(input("next-seq"), "95");
    await leave(input("next-seq"));
    await settle();
    expect(sent().at(-1)).toEqual({ version: "c:t1.c1", patch: { nextYear: "2026", nextSeq: "95" } });
    expect(errorOf("next-seq")).toBeNull();
    expect(statuses.at(-1)!.kind).toBe("saved");
    expect(preview()).toBe("Järgmine tunnistus: MS LAB 2026-95");
  });

  test("the trainer's name in Cyrillic or of one letter is refused in its field, in words (Latin letters as in the passport); what she typed stays", async () => {
    refuse = { trainerName: "letters" };
    await show();
    await type(input("trainer"), "Мария Соснина");
    await leave(input("trainer"));
    await settle();
    expect(sent().at(-1)).toMatchObject({ patch: { trainerName: "Мария Соснина" } });
    expect(input("trainer").getAttribute("aria-invalid")).toBe("true");
    expect(errorOf("trainer")).toBe("Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma).");
    expect(input("trainer").value).toBe("Мария Соснина");
    refuse = { trainerName: "length" };
    await type(input("trainer"), "M");
    await leave(input("trainer"));
    await settle();
    expect(errorOf("trainer")).toBe("Nimi on liiga lühike.");
  });
});
