// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEBOUNCE_MS } from "@/components/admin/autosave/constants";
import { PLACEHOLDERS } from "@/domain/contract";
import type { LegalKey, LegalState, LegalText } from "@/domain/legal-text";
import { adminEt } from "@/i18n/dict/admin";
import { stubFetch } from "../fakes";

// Seaded → „Lepingud ja tingimused“ (admin UX pass piece 3b, Task 5; README B4; piece3-texts S3-P3-j, S3-P3-k, P-5, P-8, P-11; the Part 3 frame „B4
// Seaded“ and the Part 4 phone frame) in a browser-like document (happy-dom), the routes answered here: the four legal texts — Privaatsus,
// Õppetingimused, E-koolituse leping, Kontaktkoolituse leping — each a card whose title and text autosave into its draft
// (api/admin/oigustekst/<key>), with the tag „Avaldamata muudatus“ while the text differs from live; „Avalda uus leping“ (the two contracts) or
// „Avalda uus tekst“ (the two pages) opens its ConfirmPanel, and „Jah, avalda“ sends what is typed first, then publishes from the version the screen
// holds (…/avalda). The placeholders are chips that insert at the cursor, in the language shown. The sample posts the screen's texts.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, push: nav.push, replace: nav.replace, back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/admin/seaded",
  useSearchParams: () => nav.params,
}));

import { LegalTexts } from "@/components/admin/ContractTexts";
import { EditLangProvider, LangSwitch } from "@/components/admin/EditLang";

const text = (et: string, ru = ""): { et: string; ru: string } => ({ et, ru });
const live = (title: string, body: string, ru = ""): LegalText => ({ title: text(title), body: text(body, ru) });
const at = (version: string, value: LegalText, changed = false, liveValue = value): LegalState => ({ version, value, live: liveValue, changed });
const TEXTS = (): Record<LegalKey, LegalState> => ({
  privacy: at("l:p", live("Privaatsus", "Privaatsustekst.")),
  terms: at("l:t", live("Õppetingimused", "Tingimuste tekst.")),
  course_terms: at("l:c", live("E-koolituse leping", "Tere {nimi}.", "Привет.")),
  contract_contact: at("l:k", live("Kontaktkoolituse leping", "Õpilane {nimi}.")),
});

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
/** What …/avalda answers next (default: published, the text live at a new version). */
let publishAnswer: (key: string, body: { version: string }) => Response;
/** The routes: a draft save answers version + "+", a publish `publishAnswer`. */
const route = async (url: string, init: RequestInit | undefined): Promise<Response> => {
  const body = JSON.parse(String(init?.body)) as { version: string; patch?: Record<string, unknown> };
  const publish = /^\/api\/admin\/oigustekst\/(\w+)\/avalda$/.exec(url);
  if (publish) return publishAnswer(publish[1], body);
  if (/^\/api\/admin\/oigustekst\/\w+$/.test(url)) return Response.json({ ok: true, version: `${body.version}+`, savedAt: "2026-10-25T08:20:00.000Z" });
  return Response.json({ ok: false }, { status: 404 });
};

const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => Array.from(container.querySelectorAll<E>(selector));
const words = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const show = async (texts = TEXTS(), reaccept = 7) => {
  await act(async () => root.render(createElement(EditLangProvider, null, createElement(LangSwitch), createElement(LegalTexts, { texts, reaccept }))));
  await settle();
};
const card = (key: LegalKey) => $(`[data-legal-editor="${key}"]`)!;
const field = (key: LegalKey, name: "title" | "body") => $<HTMLInputElement | HTMLTextAreaElement>(`[data-i18n="${key}.${name}"]`)!;
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const press = (el: Element | null) => act(async () => void (el as HTMLElement).click());
const publishButton = (key: LegalKey) => card(key).querySelector<HTMLButtonElement>("[data-legal-publish]");
const panel = (key: LegalKey) => card(key).querySelector("[data-confirm-panel]");
const panelWords = (key: LegalKey) => {
  const p = panel(key)!;
  return { question: words(p.querySelector("p")), lines: Array.from(p.querySelectorAll("li")).map(words), buttons: Array.from(p.querySelectorAll("button")).map(words) };
};
const said = (key: LegalKey) => words(card(key).querySelector("[data-legal-said]"));
const tag = (key: LegalKey) => card(key).querySelector("[data-legal-tag]");
const switchTo = (lang: "et" | "ru") => act(async () => void $<HTMLButtonElement>(`[data-edit-lang-switch] [data-edit-lang="${lang}"]`)!.click());

beforeEach(() => {
  localStorage.clear();
  nav.refresh.mockReset();
  nav.params = new URLSearchParams();
  publishAnswer = (key) => Response.json({ ok: true, version: `l:${key}-new`, value: TEXTS()[key as LegalKey].value, live: TEXTS()[key as LegalKey].value, changed: false });
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

describe("the four cards (README B4; P-11)", () => {
  test("Privaatsus, Õppetingimused, E-koolituse leping, Kontaktkoolituse leping, each with its title and text; no „Salvesta“ anywhere", async () => {
    await show();
    expect($$("[data-legal-editor]").map((c) => [c.getAttribute("data-legal-editor"), words(c.querySelector("h2"))])).toEqual([
      ["privacy", "Privaatsus"],
      ["terms", "Õppetingimused"],
      ["course_terms", "E-koolituse leping"],
      ["contract_contact", "Kontaktkoolituse leping"],
    ]);
    expect([field("course_terms", "title").value, field("course_terms", "body").value]).toEqual(["E-koolituse leping", "Tere {nimi}."]);
    expect(field("contract_contact", "body").tagName).toBe("TEXTAREA");
    expect($$("button").filter((b) => /Salvesta/.test(words(b)))).toHaveLength(0);
    // the leads that named the save say „avaldad“ now (P-5); the e-course title's hint stays
    expect(words(card("course_terms"))).toContain("Kui avaldad muudetud teksti, peab iga õpilane uuesti nõustuma.");
    expect(words(card("course_terms"))).toContain("Soovitus: „E-koolituse leping“.");
    expect(words(card("contract_contact"))).toContain("Kuni siia teksti pole kirjutatud, näeb õpilane lepinguna lehe „Õppetingimused“ teksti.");
    // nothing differs from live: no tag, no publish button
    for (const key of ["privacy", "terms", "course_terms", "contract_contact"] as const) {
      expect(tag(key), key).toBeNull();
      expect(publishButton(key), key).toBeNull();
    }
  });

  test("a card opened on a stored draft shows it, with the tag and its button", async () => {
    const texts = TEXTS();
    texts.privacy = at("d:4.2", live("Privaatsus", "Mustand."), true, live("Privaatsus", "Privaatsustekst."));
    await show(texts);
    expect(field("privacy", "body").value).toBe("Mustand.");
    expect(words(tag("privacy")?.querySelector("[data-tag-long]") ?? null)).toBe("Avaldamata muudatus");
    expect(words(publishButton("privacy"))).toBe("Avalda uus tekst");
  });
});

describe("typing saves only to the draft", () => {
  test("a text typed is saved on its card's own route after the pause (never live); the tag shows while the text differs from live and goes when typed back", async () => {
    await show();
    await type(field("terms", "body"), "Uued tingimused.");
    expect(words(tag("terms")?.querySelector("[data-tag-long]") ?? null)).toBe("Avaldamata muudatus");
    expect(words(tag("terms")?.querySelector("[data-tag-short]") ?? null)).toBe("Avaldamata"); // (the phone's word, Part 4)
    await wait(DEBOUNCE_MS + 100);
    await settle();
    expect(fetched.calls.map((c) => [c.url, c.body])).toEqual([["/api/admin/oigustekst/terms", { version: "l:t", patch: { body: { et: "Uued tingimused.", ru: "" } } }]]);
    expect(words(publishButton("terms"))).toBe("Avalda uus tekst");
    await type(field("terms", "body"), "Tingimuste tekst.");
    expect(tag("terms")).toBeNull();
    expect(publishButton("terms")).toBeNull();
  });

  test("review M1: spaces typed at either end are no change (the writers trim them): no tag, no field mark, no button", async () => {
    await show();
    await type(field("course_terms", "body"), "Tere {nimi}.  ");
    await type(field("course_terms", "title"), " E-koolituse leping");
    expect(tag("course_terms")).toBeNull();
    expect(publishButton("course_terms")).toBeNull();
    expect(card("course_terms").querySelector("[data-unpublished-tag]")).toBeNull();
    await type(field("course_terms", "body"), "Tere {nimi}. Lisa.");
    expect(words(publishButton("course_terms"))).toBe("Avalda uus leping");
  });

  test("the contracts' button is „Avalda uus leping“, the pages' „Avalda uus tekst“", async () => {
    await show();
    for (const key of ["privacy", "terms", "course_terms", "contract_contact"] as const) await type(field(key, "title"), `Muudetud ${key}`);
    expect((["privacy", "terms", "course_terms", "contract_contact"] as const).map((k) => words(publishButton(k)))).toEqual(["Avalda uus tekst", "Avalda uus tekst", "Avalda uus leping", "Avalda uus leping"]);
  });
});

describe("the ConfirmPanels (README B4, S3-P3-j, S3-P3-k, P-8)", () => {
  const open = async (key: LegalKey, texts = TEXTS(), reaccept = 7) => {
    await show(texts, reaccept);
    await type(field(key, "body"), "Uus tekst.");
    await press(publishButton(key));
    return panelWords(key);
  };

  test("E-koolituse leping, as drawn: the question, the students who will be asked again, the old contract kept", async () => {
    expect(await open("course_terms")).toEqual({
      question: "Kas avaldan uue e-koolituse lepingu?",
      lines: ["7 aktiivset õpilast peavad selle järgmisel sisselogimisel uuesti kinnitama.", "Vana leping jääb alles ja märgitakse asendatuks."],
      buttons: ["Jah, avalda", "Katkesta"],
    });
    expect(publishButton("course_terms")).toBeNull(); // (the panel stands in its place)
    expect(document.activeElement).toBe(panel("course_terms"));
  });

  test("n = 1: the singular; n = 0: the line is left out (P-8)", async () => {
    expect((await open("course_terms", TEXTS(), 1)).lines).toEqual(["1 aktiivne õpilane peab selle järgmisel sisselogimisel uuesti kinnitama.", "Vana leping jääb alles ja märgitakse asendatuks."]);
    await act(async () => root.unmount());
    root = createRoot(container);
    expect((await open("course_terms", TEXTS(), 0)).lines).toEqual(["Vana leping jääb alles ja märgitakse asendatuks."]);
  });

  test("Kontaktkoolituse leping: S3-P3-j", async () => {
    expect(await open("contract_contact")).toEqual({
      question: "Kas avaldan uue kontaktkoolituse lepingu?",
      lines: ["Uus tekst kehtib uutele registreeringutele.", "Varem kinnitatud lepingud jäävad selliseks, nagu need kinnitati."],
      buttons: ["Jah, avalda", "Katkesta"],
    });
  });

  test("Privaatsus and Õppetingimused: S3-P3-k; the second line of Õppetingimused only while „Kontaktkoolituse leping“ is empty", async () => {
    expect(await open("privacy")).toEqual({ question: "Kas avaldan lehe „Privaatsus“ uue teksti?", lines: ["Uus tekst on avalikul lehel kohe näha."], buttons: ["Jah, avalda", "Katkesta"] });
    expect((await open("terms")).lines).toEqual(["Uus tekst on avalikul lehel kohe näha."]);
    await act(async () => root.unmount());
    root = createRoot(container);
    const empty = TEXTS();
    empty.contract_contact = at("l:k", live("", ""));
    expect(await open("terms", empty)).toEqual({
      question: "Kas avaldan lehe „Õppetingimused“ uue teksti?",
      lines: ["Uus tekst on avalikul lehel kohe näha.", "Kuni „Kontaktkoolituse leping“ on tühi, kehtib see tekst uutele registreeringutele lepinguna."],
      buttons: ["Jah, avalda", "Katkesta"],
    });
  });

  test("„Katkesta“ (and Esc) closes the panel and gives the focus back to its button; nothing is published", async () => {
    await open("privacy");
    await press(Array.from(panel("privacy")!.querySelectorAll("button")).find((b) => words(b) === "Katkesta")!);
    expect(panel("privacy")).toBeNull();
    expect(document.activeElement).toBe(publishButton("privacy"));
    await press(publishButton("privacy"));
    await act(async () => void panel("privacy")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(panel("privacy")).toBeNull();
    expect(fetched.calls.filter((c) => c.url.endsWith("/avalda"))).toHaveLength(0);
  });
});

describe("„Jah, avalda“", () => {
  const yes = (key: LegalKey) => press(Array.from(panel(key)!.querySelectorAll("button")).find((b) => words(b) === "Jah, avalda")!);

  test("sends what is typed first, then publishes from the version the screen holds; the line says so, the tag and the button are gone, the focus is on the line; the page is read again", async () => {
    await show();
    await type(field("course_terms", "body"), "Uus e-leping.");
    await press(publishButton("course_terms"));
    publishAnswer = () => Response.json({ ok: true, version: "l:c2", value: live("E-koolituse leping", "Uus e-leping.", "Привет."), live: live("E-koolituse leping", "Uus e-leping.", "Привет."), changed: false });
    await yes("course_terms");
    await settle();
    expect(fetched.calls.map((c) => [c.url, c.body])).toEqual([
      ["/api/admin/oigustekst/course_terms", { version: "l:c", patch: { body: { et: "Uus e-leping.", ru: "Привет." } } }],
      ["/api/admin/oigustekst/course_terms/avalda", { version: "l:c+" }],
    ]);
    expect(said("course_terms")).toBe("Uus e-koolituse leping on avaldatud.");
    expect(tag("course_terms")).toBeNull();
    expect(publishButton("course_terms")).toBeNull();
    expect(field("course_terms", "body").value).toBe("Uus e-leping.");
    expect(document.activeElement).toBe(card("course_terms").querySelector("[data-legal-said]"));
    expect(nav.refresh).toHaveBeenCalled();
    // typing on goes on from the published version (a new draft), not from the one before it
    await type(field("course_terms", "body"), "Veel üks muudatus.");
    await wait(DEBOUNCE_MS + 100);
    await settle();
    expect(fetched.calls.at(-1)).toMatchObject({ url: "/api/admin/oigustekst/course_terms", body: { version: "l:c2" } });
  });

  test("the other result lines: the contact contract's, a page's (P-11)", async () => {
    await show();
    await type(field("contract_contact", "body"), "Uus.");
    await press(publishButton("contract_contact"));
    await yes("contract_contact");
    await settle();
    expect(said("contract_contact")).toBe("Uus kontaktkoolituse leping on avaldatud.");
    await type(field("privacy", "body"), "Uus.");
    await press(publishButton("privacy"));
    await yes("privacy");
    await settle();
    expect(said("privacy")).toBe("Uus tekst on avaldatud.");
  });

  test("refused because the text changed meanwhile in another window: P-11's words, and the card shows the text as stored", async () => {
    await show();
    await type(field("terms", "body"), "Minu tekst.");
    await press(publishButton("terms"));
    publishAnswer = () => Response.json({ ok: false, error: "changed", version: "d:9.3", value: live("Õppetingimused", "Teise akna tekst."), live: live("Õppetingimused", "Tingimuste tekst."), changed: true }, { status: 409 });
    await yes("terms");
    await settle();
    expect(said("terms")).toBe("Seda teksti muudeti vahepeal teises aknas. Vaata see üle.");
    expect(field("terms", "body").value).toBe("Teise akna tekst.");
    expect(words(publishButton("terms"))).toBe("Avalda uus tekst");
  });

  test("review M5: a 409 that finds the screen's text live and no other draft is her own publish whose answer came too late — published, not a change", async () => {
    await show();
    await type(field("privacy", "body"), "Uus privaatsustekst.");
    await press(publishButton("privacy"));
    // (the first press's answer was lost: the route published it after the client's bound; the next press finds it live)
    publishAnswer = () => Response.json({ ok: false, error: "changed", version: "l:p2", value: live("Privaatsus", "Uus privaatsustekst."), live: live("Privaatsus", "Uus privaatsustekst."), changed: false }, { status: 409 });
    await yes("privacy");
    await settle();
    expect(said("privacy")).toBe("Uus tekst on avaldatud.");
    expect(tag("privacy")).toBeNull();
    expect(publishButton("privacy")).toBeNull();
    // a 409 with another text live is the other window's: the P-11 refusal
    await type(field("privacy", "body"), "Minu järgmine tekst.");
    await press(publishButton("privacy"));
    publishAnswer = () => Response.json({ ok: false, error: "changed", version: "l:p3", value: live("Privaatsus", "Teise akna tekst."), live: live("Privaatsus", "Teise akna tekst."), changed: false }, { status: 409 });
    await yes("privacy");
    await settle();
    expect(said("privacy")).toBe("Seda teksti muudeti vahepeal teises aknas. Vaata see üle.");
  });

  test("a failure (a server error): D-2's words, the panel closes and its button takes the focus; signed out: „Logi uuesti sisse.“", async () => {
    await show();
    await type(field("privacy", "body"), "Uus.");
    await press(publishButton("privacy"));
    publishAnswer = () => Response.json({ ok: false, error: "server" }, { status: 500 });
    await yes("privacy");
    await settle();
    expect(said("privacy")).toBe("Avaldamine ei õnnestunud. Proovi uuesti.");
    expect(panel("privacy")).toBeNull();
    expect(document.activeElement).toBe(publishButton("privacy"));
    publishAnswer = () => Response.json({ ok: false, error: "auth" }, { status: 401 });
    await press(publishButton("privacy"));
    await yes("privacy");
    await settle();
    expect(said("privacy")).toBe("Logi uuesti sisse.");
  });

  test("an empty required field on the press: the field says so and takes the focus; no panel, nothing sent", async () => {
    const texts = TEXTS();
    texts.contract_contact = at("l:k", live("", ""));
    await show(texts);
    await type(field("contract_contact", "body"), "Ainult tekst.");
    await press(publishButton("contract_contact"));
    expect(panel("contract_contact")).toBeNull();
    expect(field("contract_contact", "title").getAttribute("aria-invalid")).toBe("true");
    expect(words(card("contract_contact"))).toContain("Täida see väli (eesti keeles).");
    expect(document.activeElement).toBe(field("contract_contact", "title"));
    expect(fetched.calls.filter((c) => c.url.endsWith("/avalda"))).toHaveLength(0);
  });
});

describe("the placeholder chips (README B4: they insert at the cursor)", () => {
  const chip = (key: LegalKey, name: string) => card(key).querySelector<HTMLButtonElement>(`[data-placeholder-chip="${name}"]`);

  test("„+ nimi“ … „+ ettemaks“ under the two contracts' texts (the six placeholders the server fills), each saying what fills it; none under the pages'", async () => {
    await show();
    for (const key of ["course_terms", "contract_contact"] as const) {
      const chips = Array.from(card(key).querySelectorAll<HTMLButtonElement>("[data-placeholder-chip]"));
      expect(chips.map(words), key).toEqual(PLACEHOLDERS.map((p) => `+ ${p}`));
      expect(chips.map((c) => c.title)).toEqual(PLACEHOLDERS.map((p) => adminEt.contracts.settings.placeholderMeaning[p]));
      expect(chips.every((c) => c.type === "button")).toBe(true);
    }
    expect(card("privacy").querySelector("[data-placeholder-chip]")).toBeNull();
    expect(card("terms").querySelector("[data-placeholder-chip]")).toBeNull();
  });

  test("a chip inserts its placeholder at the cursor (over a selection), the cursor after it, and the text saves as typed", async () => {
    await show();
    const body = field("contract_contact", "body") as HTMLTextAreaElement;
    await act(async () => {
      body.focus();
      body.setSelectionRange(8, 8); // "Õpilane |{nimi}."
    });
    await press(chip("contract_contact", "koolitus"));
    expect(body.value).toBe("Õpilane {koolitus}{nimi}.");
    expect([body.selectionStart, body.selectionEnd]).toEqual([18, 18]);
    expect(document.activeElement).toBe(body);
    await act(async () => body.setSelectionRange(8, 18)); // the inserted one selected
    await press(chip("contract_contact", "hind"));
    expect(body.value).toBe("Õpilane {hind}{nimi}.");
    await wait(DEBOUNCE_MS + 100);
    await settle();
    expect(fetched.calls.at(-1)).toMatchObject({ url: "/api/admin/oigustekst/contract_contact", body: { patch: { body: { et: "Õpilane {hind}{nimi}." } } } });
  });

  test("in the language shown: on RU it goes into the Russian text; into the title when the cursor was there; at the end of a text never focused", async () => {
    await show();
    await press(chip("course_terms", "nimi")); // (no cursor yet: at the end of the body)
    expect(field("course_terms", "body").value).toBe("Tere {nimi}.{nimi}");
    await switchTo("ru");
    const ru = field("course_terms", "body") as HTMLTextAreaElement;
    expect(ru.value).toBe("Привет.");
    await act(async () => {
      ru.focus();
      ru.setSelectionRange(0, 0);
    });
    await press(chip("course_terms", "e-post"));
    expect(ru.value).toBe("{e-post}Привет.");
    const title = field("course_terms", "title") as HTMLInputElement;
    await act(async () => {
      title.focus();
      title.setSelectionRange(0, 0);
    });
    await press(chip("course_terms", "koolitus"));
    expect(title.value).toBe("{koolitus}");
    await switchTo("et");
    expect(field("course_terms", "body").value).toBe("Tere {nimi}.{nimi}");
  });
});

describe("Kontaktkoolituse leping: „Näidisleping (PDF)“", () => {
  test("a form of its own that posts the screen's texts (the draft as typed) to a new tab; the hint says nothing is published (P-5)", async () => {
    await show();
    await type(field("contract_contact", "title"), "Muudetud pealkiri");
    const form = card("contract_contact").querySelector<HTMLFormElement>("[data-contract-sample-form]")!;
    expect([form.getAttribute("method"), form.getAttribute("action"), form.getAttribute("target")]).toEqual(["post", "/api/admin/naidisleping", "_blank"]);
    const hidden = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value;
    expect(["titleEt", "bodyEt"].map(hidden)).toEqual(["Muudetud pealkiri", "Õpilane {nimi}."]);
    expect(words(form)).toContain("Näidis tehakse kaardi praegustest väärtustest, ka avaldamata. Midagi ei avaldata.");
    expect(Array.from(form.querySelectorAll("button")).map(words)).toEqual(["Näidisleping (PDF)"]);
    await switchTo("ru");
    await type(field("contract_contact", "body"), "Текст.");
    expect(Array.from(form.querySelectorAll("button")).map(words)).toEqual(["Näidisleping (PDF)", "Näidisleping vene keeles (PDF)"]);
    expect(card("privacy").querySelector("[data-contract-sample-form]")).toBeNull();
  });
});

describe("the phone (Part 4: „Pikk tekst avaneb täisekraanil.“)", () => {
  const phoneWidth = () =>
    vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: q.includes("max-width: 640px"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList);

  test("the card says the text opens full screen, „Muuda teksti“ opens it in the drawer (its own address), with the chips; the tag is the short one", async () => {
    phoneWidth();
    const texts = TEXTS();
    texts.course_terms = at("d:3.1", live("E-koolituse leping", "Mustand."), true, TEXTS().course_terms.live);
    await show(texts);
    expect(words(card("course_terms"))).toContain("Pikk tekst avaneb täisekraanil.");
    const edit = card("course_terms").querySelector<HTMLAnchorElement>("[data-legal-open]")!;
    expect([words(edit), edit.getAttribute("href")]).toEqual(["Muuda teksti", "/admin/seaded?tekst=course_terms"]);
    nav.params = new URLSearchParams("tekst=course_terms");
    await show(texts);
    const drawer = document.querySelector<HTMLDialogElement>("dialog[data-drawer]")!;
    expect(drawer.getAttribute("aria-label")).toBe("E-koolituse leping");
    expect(drawer.querySelector<HTMLTextAreaElement>('[data-i18n="course_terms.body"]')!.value).toBe("Mustand.");
    expect(drawer.querySelectorAll("[data-placeholder-chip]")).toHaveLength(PLACEHOLDERS.length);
  });

  describe("review I-1: the drawer's chips stay above the on-screen keyboard", () => {
    const keyboard = (view: { height: number; offsetTop: number } | undefined) => {
      const target = view ? Object.assign(new EventTarget(), view) : undefined;
      Object.defineProperty(window, "visualViewport", { value: target, configurable: true });
      return target;
    };
    let innerHeight: PropertyDescriptor | undefined;
    beforeEach(() => {
      innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
      Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    });
    afterEach(() => {
      if (innerHeight) Object.defineProperty(window, "innerHeight", innerHeight);
      Reflect.deleteProperty(window, "visualViewport");
    });
    const drawerChips = () => document.querySelector<HTMLElement>("dialog[data-drawer] [data-placeholder-chips]")!;
    const openDrawer = async () => {
      phoneWidth();
      nav.params = new URLSearchParams("tekst=course_terms");
      await show();
    };

    test("the keyboard's height over the foot of the screen (innerHeight − visual height − its offset, at least 0) lifts the sticky row, and follows the keyboard; the mark for the 💬 bubble stays", async () => {
      const view = keyboard({ height: 480, offsetTop: 20 })!;
      await openDrawer();
      expect(drawerChips().style.getPropertyValue("--keyboard-inset")).toBe("300px");
      expect(drawerChips().hasAttribute("data-fab-avoid")).toBe(true);
      Object.assign(view, { height: 800, offsetTop: 0 }); // the keyboard closed
      await act(async () => void view.dispatchEvent(new Event("resize")));
      expect(drawerChips().style.getPropertyValue("--keyboard-inset")).toBe("0px");
      Object.assign(view, { height: 500, offsetTop: 60 }); // opened again, the visual viewport scrolled
      await act(async () => void view.dispatchEvent(new Event("scroll")));
      expect(drawerChips().style.getPropertyValue("--keyboard-inset")).toBe("240px");
      Object.assign(view, { height: 820, offsetTop: 0 }); // (taller than the layout viewport: never below 0)
      await act(async () => void view.dispatchEvent(new Event("resize")));
      expect(drawerChips().style.getPropertyValue("--keyboard-inset")).toBe("0px");
      // the card's own row (no drawer) is never lifted
      expect(card("contract_contact").querySelector<HTMLElement>("[data-placeholder-chips]")!.style.getPropertyValue("--keyboard-inset")).toBe("");
    });

    test("the drawer closed, the listeners go with it", async () => {
      const view = keyboard({ height: 480, offsetTop: 0 })!;
      const removed = vi.spyOn(view, "removeEventListener");
      await openDrawer();
      expect(drawerChips()).not.toBeNull();
      nav.params = new URLSearchParams();
      await show();
      expect(document.querySelector("dialog[data-drawer]")).toBeNull();
      expect(removed.mock.calls.map((c) => c[0]).sort()).toEqual(["resize", "scroll"]);
    });

    test("old iPads without visualViewport: no lift, nothing breaks", async () => {
      keyboard(undefined);
      await openDrawer();
      expect(drawerChips().style.getPropertyValue("--keyboard-inset")).toBe("");
    });
  });
});
