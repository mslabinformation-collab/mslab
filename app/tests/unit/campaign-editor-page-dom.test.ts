// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAVE_TIMEOUT_MS } from "@/components/admin/autosave/constants";
import { CampaignEditor } from "@/components/admin/CampaignEditor";
import { EditLangProvider } from "@/components/admin/EditLang";
import { UndoProvider } from "@/components/admin/UndoBar";
import type { PopupOfferValue, SitePartState } from "@/domain/site-entities";
import { stubFetch } from "../fakes";

// C4 Hüpikaken, the screen (admin UX pass piece 4b, Task 4; README §4 C4 "the „Lehel näidatakse“ choice is instant with UndoBar; one preview that follows
// LangSwitch; the „Reeglid“ text stays"; the Part 4 C4 frame; piece4-texts S4-25…S4-30, S4-Q2…Q4; rulings R-c, R-d). Not the newsletter letters'
// editor (campaign-editor-dom.test.ts): the home page's popup. The site editors' page (site/SiteEditorPage.tsx) on the entity "popup", its one part
// `offer` (POST /api/admin/sisu/popup/0/osa/offer) with its PublishBar (S4-30's labels), and above it the instant „Lehel näidatakse“ (POST
// /api/admin/hupikaken/naita `{ on, version }`): off says „Hüpikaken peidetud.“ with „Võta tagasi“, on says nothing; refused, `Puudub: pilt` or
// „Hüpikakent muudeti vahepeal. Vaata see üle.“ under it. The preview at the right follows the page's ET | RU, its button Seaded's code.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/kampaania",
  useSearchParams: () => new URLSearchParams(),
}));
// (the preview's form is a picture: nothing is ever sent from it)
vi.mock("@/server/actions/public", () => ({ subscribe: vi.fn() }));

const OFFER: PopupOfferValue = {
  kicker: { et: "MS LABi kirjad", ru: "Письма MS LAB" },
  title: { et: "Hea järgmine samm.", ru: "Ваш следующий шаг." },
  text: { et: "Uued koolitused ja tervitussoodustus.", ru: "Новые курсы и приветственная скидка." },
  imageKey: "img/0b6f3b7e-2c4d-4f7a-9a59-3d7c2f1e8a10.jpg",
  discountPercent: "10",
  codeDays: "",
};
const SWITCH = "/api/admin/hupikaken/naita";
const SAVE = "/api/admin/sisu/popup/0/osa/offer";

/** The part as the page reads it (readSiteEditor): no draft, its value live. A new object is a new read. */
const partsOf = (value: PopupOfferValue = OFFER, live: PopupOfferValue = value, version = "l:offer"): Record<string, SitePartState> => ({ offer: { version, value, live } });

/** The routes: the offer's draft (a save from another version is a 409), and the switch's answer. */
const remote = {
  version: "l:offer",
  value: OFFER as Record<string, unknown>,
  n: 0,
  refuse: null as null | Record<string, string>,
  naita: (body: { on: boolean; version: string }): Response => Response.json({ ok: true, version: `${body.version}+`, stamp: 5 }),
  log: [] as { version: string; patch: Record<string, unknown> }[],
  /** While set, a save waits for it before the route answers (a save on its way). */
  gate: null as Promise<void> | null,
};
function resetRemote() {
  remote.version = "l:offer";
  remote.value = { ...OFFER };
  remote.n = 0;
  remote.refuse = null;
  remote.naita = (body) => Response.json({ ok: true, version: `${body.version}+`, stamp: 5 });
  remote.log = [];
  remote.gate = null;
}
const respond = (url: string, init: RequestInit | undefined): Response | Promise<Response> => {
  if (url === "/api/admin/sisu/popup/0/avalda") return Response.json({ stamp: 5, published: ["offer"], blocked: [] });
  if (url === "/api/admin/sisu/popup/0/loobu") return Response.json({ stamp: 5 });
  if (url === SWITCH) return remote.naita(JSON.parse(String(init?.body)) as { on: boolean; version: string });
  if (url !== SAVE) return Response.json({ ok: false }, { status: 404 });
  const body = JSON.parse(String(init?.body)) as { version: string; patch: Record<string, unknown> };
  remote.log.push(body);
  const gate = remote.gate;
  return gate ? gate.then(() => saveAnswer(body)) : saveAnswer(body);
};
/** The part's route's answer to a save (the version check, the value merged, the new version). */
const saveAnswer = (body: { version: string; patch: Record<string, unknown> }): Response => {
  if (remote.refuse) return Response.json({ ok: false, error: "invalid", fields: remote.refuse }, { status: 400 });
  if (body.version !== remote.version) return Response.json({ ok: false, error: "conflict", version: remote.version, value: remote.value }, { status: 409 });
  remote.n += 1;
  remote.value = { ...remote.value, ...body.patch };
  remote.version = `d:1.${remote.n}`;
  return Response.json({ ok: true, version: remote.version, savedAt: "2026-10-27T09:15:00.000Z" });
};

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => Array.from(container.querySelectorAll<E>(selector));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
type Props = Parameters<typeof CampaignEditor>[0];
const props = (over: Partial<Props> = {}): Props => ({ parts: partsOf(), stamp: 1, shown: { on: true, version: "v1" }, code: true, ...over });
/** The page as read (again): its props; a new `parts` object is a new read. */
const show = async (over: Partial<Props> = {}) => {
  await act(async () => root.render(createElement(EditLangProvider, null, createElement(UndoProvider, null, createElement(CampaignEditor, props(over))))));
  await settle();
};
const type = async (el: Element | null, value: string) => {
  expect(el, "the field to type in").not.toBeNull();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const leave = async (el: Element | null) => {
  await act(async () => void el!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
/** A field by its name: a one-language field's data-field, a two-language field's data-i18n (the side the page's language shows). */
const field = <E extends HTMLElement = HTMLInputElement>(name: string) => $<E>(`[data-field="${name}"], [data-i18n="${name}"]`);
const labelOf = (el: Element | null) => text(container.querySelector(`label[for="${el?.id}"]`));
const describedBy = (el: Element | null) =>
  (el?.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => text(document.getElementById(id)));
const toggle = () => $<HTMLInputElement>("[data-popup-switch]");
const said = () => $("[data-switch-error]");
const undoBar = () => document.querySelector<HTMLElement>("[data-undo-bar]");
const undoButton = () => Array.from(document.querySelectorAll<HTMLButtonElement>("[data-undo-bar] button")).find((b) => text(b) === "Võta tagasi") ?? null;
const posts = () => fetched.calls.filter((c) => c.method === "POST");
const preview = () => $("[data-newsletter-preview]");

beforeEach(() => {
  localStorage.clear();
  resetRemote();
  fetched = stubFetch(respond);
  router.refresh.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetched.restore();
  vi.restoreAllMocks();
});

describe("the screen as drawn (the Part 4 C4 frame; S4-25…S4-29)", () => {
  it("„Eelvaade ↗“ opens the home page in draft mode under the popup's own bar (?riba=hupikaken, ruling c1), never Avaleht's", async () => {
    await show();
    await type(field("offer.discountPercent"), "15");
    await leave(field("offer.discountPercent"));
    expect($<HTMLAnchorElement>("[data-publish-preview]")?.getAttribute("href")).toBe("/api/admin/eelvaade?tee=%2F%3Friba%3Dhupikaken");
  });

  it("„Turundus“ over the H1 „Hüpikaken“, no lead; „Vaata lehel ↗“ opens the home page; no „Salvesta“, no bar while nothing waits; nowhere the word „kampaania“", async () => {
    await show();
    expect(text($("[data-site-eyebrow]"))).toBe("Turundus");
    expect(text($("h1"))).toBe("Hüpikaken");
    expect($("[data-site-lead]")).toBeNull();
    expect($<HTMLAnchorElement>("[data-site-view]")?.getAttribute("href")).toBe("/");
    expect($$("button").map(text)).not.toContain("Salvesta");
    expect($("[data-publish-bar]")).toBeNull();
    expect(container.textContent?.toLowerCase()).not.toContain("kampaania");
  });

  it("the top card: the switch „Lehel näidatakse“, on as the row is, described by S4-25's line", async () => {
    await show();
    const sw = toggle();
    expect(sw?.getAttribute("role")).toBe("switch");
    expect(sw?.checked).toBe(true);
    expect(labelOf(sw)).toBe("Lehel näidatakse");
    expect(describedBy(sw)).toEqual(["Avaneb uuele külastajale 8 s pärast · üks kord 30 päeva jooksul"]);
    // the switch is its own card, before the offer's
    const top = $("[data-popup-shown]");
    expect(top?.contains(sw!)).toBe(true);
    expect(top?.compareDocumentPosition($("#pakkumine")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("„Pakkumine“: „Silt“, „Pealkiri“, „Tekst“, „Pilt“, then „Soodustus (%)“ and „Kood kehtib (päeva)“ side by side with S4-28 under them", async () => {
    await show();
    const card = $("#pakkumine");
    expect(text(card?.querySelector("h2") ?? null)).toBe("Pakkumine");
    const order = Array.from(card?.querySelectorAll<HTMLElement>("[data-single-image], [data-i18n], [data-field]") ?? []).map(
      (el) => el.getAttribute("data-single-image") ?? el.getAttribute("data-i18n") ?? el.getAttribute("data-field"),
    );
    expect(order).toEqual(["offer.kicker", "offer.title", "offer.text", "popup", "offer.discountPercent", "offer.codeDays"]);
    expect(labelOf(field("offer.discountPercent"))).toBe("Soodustus (%)");
    expect(labelOf(field("offer.codeDays"))).toBe("Kood kehtib (päeva)");
    expect(field("offer.discountPercent")!.value).toBe("10");
    expect(field("offer.codeDays")!.value).toBe("");
    const numbers = $("[data-offer-numbers]");
    expect(numbers?.contains(field("offer.discountPercent"))).toBe(true);
    expect(numbers?.contains(field("offer.codeDays"))).toBe(true);
    expect(text(numbers?.nextElementSibling ?? null)).toBe("Koodi saad muuta: Seaded → „Tervituskood“.");
    expect(field("offer.text")?.tagName).toBe("TEXTAREA");
  });

  it("the preview at the right: the popup's card as the home page shows it, a picture of it (inert), with „Reeglid: …“ (S4-29) under it", async () => {
    await show();
    const box = preview();
    expect(box?.hasAttribute("inert")).toBe(true);
    expect(box?.getAttribute("aria-label")).toBe("Eelvaade");
    expect(text(box?.querySelector("h2") ?? null)).toBe("Hea järgmine samm.");
    expect(box?.querySelector("img")?.getAttribute("src")).toBe(`/media/${OFFER.imageKey}`);
    expect(box?.querySelector("form")).toBeNull(); // (a picture: no form inside the page)
    const col = $("[data-popup-preview]");
    expect(text(col)).toContain("Nii näeb hüpikaken välja avalehel.");
    expect(text($("[data-popup-rules]"))).toBe("Reeglid: kood saadetakse e-postiga kohe pärast liitumist; üks kasutus tellija kohta; ei liitu teiste soodustustega.");
  });
});

describe("the preview follows the page's ET | RU (README C4) and its button Seaded's code (S4-Q4)", () => {
  it("ET, then RU: the texts and the form's words in the language the page's switch shows; typed text at once", async () => {
    await show();
    const button = () => text(preview()?.querySelector("button") ?? null);
    expect(preview()?.getAttribute("lang")).toBe("et");
    expect(button()).toBe("Saa kood");
    await click($('[data-edit-lang="ru"]'));
    expect(preview()?.getAttribute("lang")).toBe("ru");
    expect(text(preview()?.querySelector("h2") ?? null)).toBe("Ваш следующий шаг.");
    expect(text(preview())).toContain("Письма MS LAB");
    expect(button()).toBe("Получить код");
    await type(field("offer.title"), "Новый заголовок");
    expect(text(preview()?.querySelector("h2") ?? null)).toBe("Новый заголовок");
    await click($('[data-edit-lang="et"]'));
    expect(text(preview()?.querySelector("h2") ?? null)).toBe("Hea järgmine samm.");
  });

  it("without a welcome code the button is „Liitu“ / „Подписаться“", async () => {
    await show({ code: false });
    expect(text(preview()?.querySelector("button") ?? null)).toBe("Liitu");
    await click($('[data-edit-lang="ru"]'));
    expect(text(preview()?.querySelector("button") ?? null)).toBe("Подписаться");
  });
});

describe("the offer waits for „Avalda muudatused“ (S4-30); the switch never is on the bar", () => {
  it("a discount typed and left is saved into the draft; the bar names „Soodustus“, the field says „· avaldamata“", async () => {
    await show();
    await type(field("offer.discountPercent"), "15");
    await leave(field("offer.discountPercent"));
    expect(remote.log).toEqual([{ version: "l:offer", patch: { discountPercent: "15" } }]);
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 1 · Soodustus. Avalikul lehel on näha eelmine versioon.");
    expect(field("offer.discountPercent")!.closest("[data-unpublished]")).not.toBeNull();
  });

  it("the days and the title too: „Pealkiri, Kood kehtib“; a Russian-only change is „(RU)“", async () => {
    await show();
    await type(field("offer.codeDays"), "30");
    await leave(field("offer.codeDays"));
    await click($('[data-edit-lang="ru"]'));
    await type(field("offer.title"), "Новый заголовок");
    await leave(field("offer.title"));
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 2 · Pealkiri (RU), Kood kehtib. Avalikul lehel on näha eelmine versioon.");
  });

  it("a number the server refuses (`whole`) is said at its field", async () => {
    await show();
    remote.refuse = { discountPercent: "whole" };
    await type(field("offer.discountPercent"), "150");
    await leave(field("offer.discountPercent"));
    expect(field("offer.discountPercent")!.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(field("offer.discountPercent"))).toContain("Sisesta täisarv.");
  });
});

describe("„Lehel näidatakse“: instant, with the UndoBar (S4-26)", () => {
  it("off: what is typed is saved first, then the switch route with the version read; „Hüpikaken peidetud.“; „Võta tagasi“ switches it on from the answer's version", async () => {
    await show();
    await type(field("offer.kicker"), "Uus silt"); // typed, not saved yet: sent first (flush "settle"), so the read after the switch has it
    await click(toggle());
    expect(posts().map((c) => c.url)).toEqual([SAVE, SWITCH]);
    expect(posts()[1].body).toEqual({ on: false, version: "v1" });
    expect(toggle()?.checked).toBe(false);
    expect(text(undoBar())).toContain("Hüpikaken peidetud.");
    // the page is read again; until then the cards wait
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect($("[data-cards-waiting]")).not.toBeNull();
    const typed = { ...OFFER, kicker: { ...OFFER.kicker, et: "Uus silt" } };
    await show({ parts: partsOf(typed, OFFER, "d:1.1"), stamp: 5, shown: { on: false, version: "v1+" } });
    expect($("[data-cards-waiting]")).toBeNull();
    expect(toggle()?.checked).toBe(false);
    expect(field("offer.kicker")!.value).toBe("Uus silt"); // what she typed is still hers
    await click(undoButton());
    expect(posts().at(-1)).toMatchObject({ url: SWITCH, body: { on: true, version: "v1+" } });
    expect(undoBar()?.textContent ?? "").not.toContain("Hüpikaken peidetud.");
    expect(router.refresh).toHaveBeenCalledTimes(2);
    await show({ parts: partsOf(), stamp: 5, shown: { on: true, version: "v1++" } });
    expect(toggle()?.checked).toBe(true);
  });

  it("„Võta tagasi“ pressed while the cards still wait for the hide's read: it waits for that read, then switches on (never „Salvestamine ei õnnestunud“); the wait's bound timer goes with it", async () => {
    await show();
    await click(toggle());
    expect($("[data-cards-waiting]")).not.toBeNull();
    // the wait's own bound (SAVE_TIMEOUT_MS + 1 s, for an editor that has gone): its timer is cleared once the read frees the cards (T4 re-review m3)
    const bounds: unknown[] = [];
    const setTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const id = setTimer(fn, ms);
      if (ms === SAVE_TIMEOUT_MS + 1000) bounds.push(id);
      return id;
    }) as unknown as typeof setTimeout);
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    await click(undoButton());
    await act(async () => void (await new Promise((r) => setTimeout(r, 250))));
    expect(posts().map((c) => c.url)).toEqual([SWITCH]); // (not yet: the cards wait)
    expect(text(undoBar())).toContain("Hüpikaken peidetud.");
    await show({ parts: partsOf(), stamp: 5, shown: { on: false, version: "v1+" } });
    await act(async () => void (await new Promise((r) => setTimeout(r, 250))));
    await settle();
    expect(posts().at(-1)).toMatchObject({ url: SWITCH, body: { on: true, version: "v1+" } });
    expect(text(undoBar())).toBe("");
    expect(bounds).toHaveLength(1);
    expect(cleared.mock.calls.map((c) => c[0])).toContain(bounds[0]);
  });

  it("on: no bar; a hide's bar still up goes", async () => {
    await show({ shown: { on: false, version: "v1" } });
    await click(toggle());
    expect(posts()[0].body).toEqual({ on: true, version: "v1" });
    expect(text(undoBar())).toBe("");
    await show({ parts: partsOf(), stamp: 5, shown: { on: true, version: "v1+" } });
    // off with its bar, then on by hand: the bar goes
    await click(toggle());
    expect(text(undoBar())).toContain("Hüpikaken peidetud.");
    await show({ parts: partsOf(), stamp: 5, shown: { on: false, version: "v1++" } });
    await click(toggle());
    expect(posts().at(-1)?.body).toEqual({ on: true, version: "v1++" });
    expect(text(undoBar())).not.toContain("Hüpikaken peidetud.");
  });

  it("refused on, the live popup lacks its picture: `Puudub: pilt` under the switch, which is off again; never on the bar; nothing read", async () => {
    remote.naita = () => Response.json({ ok: false, missing: ["pilt"] });
    await show({ shown: { on: false, version: "v1" } });
    // a draft waits: the bar is up, and it says nothing of the switch
    await type(field("offer.title"), "Uus pealkiri");
    await leave(field("offer.title"));
    await click(toggle());
    expect(text(said())).toBe("Puudub: pilt");
    expect(describedBy(toggle())).toContain("Puudub: pilt");
    expect(toggle()?.checked).toBe(false);
    expect($("[data-publish-bar]")).not.toBeNull();
    expect($("[data-publish-blocked]")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect($("[data-cards-waiting]")).toBeNull();
    expect(text(undoBar())).toBe("");
  });

  it("refused, another tab changed the popup: „Hüpikakent muudeti vahepeal. Vaata see üle.“ under the switch, and the page is read; the line stays over that read", async () => {
    remote.naita = () => Response.json({ ok: false, error: "changed", stamp: 6 });
    await show();
    await click(toggle());
    expect(router.refresh).toHaveBeenCalledTimes(1);
    await show({ parts: partsOf(), stamp: 6, shown: { on: false, version: "v9" } });
    expect(toggle()?.checked).toBe(false);
    expect(text(said())).toBe("Hüpikakent muudeti vahepeal. Vaata see üle.");
    expect(text(undoBar())).toBe("");
    // the next press: the line goes
    remote.naita = (body) => Response.json({ ok: true, version: `${body.version}+`, stamp: 7 });
    await click(toggle());
    expect(posts().at(-1)?.body).toEqual({ on: true, version: "v9" });
    expect(said()).toBeNull();
  });

  it("„Võta tagasi“ refused, the popup changed meanwhile: the bar goes (its version is stale: nothing is sent again), „Hüpikakent muudeti vahepeal. Vaata see üle.“ under the switch over the read", async () => {
    await show();
    await click(toggle());
    await show({ parts: partsOf(), stamp: 5, shown: { on: false, version: "v1+" } });
    remote.naita = () => Response.json({ ok: false, error: "changed", stamp: 8 });
    await click(undoButton());
    expect(posts().filter((c) => c.url === SWITCH)).toHaveLength(2);
    expect(undoBar()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(2);
    await show({ parts: partsOf(), stamp: 8, shown: { on: true, version: "v7" } });
    expect(text(said())).toBe("Hüpikakent muudeti vahepeal. Vaata see üle.");
    expect(toggle()?.checked).toBe(true);
  });

  it("a field's save on its way when the switch is pressed (the focus left it): the switch goes once that save is answered, so the read after it starts the cards from the saved version (m4)", async () => {
    await show();
    let open: () => void = () => {};
    remote.gate = new Promise<void>((done) => (open = done));
    await type(field("offer.title"), "Uus pealkiri");
    await leave(field("offer.title")); // (the save leaves, and waits at the gate)
    expect(posts().map((c) => c.url)).toEqual([SAVE]);
    await click(toggle());
    await act(async () => void (await new Promise((r) => setTimeout(r, 150))));
    expect(posts().map((c) => c.url)).toEqual([SAVE]); // the switch waits for the save's answer
    await act(async () => open());
    await settle();
    expect(posts().map((c) => c.url)).toEqual([SAVE, SWITCH]);
    remote.gate = null;
    // the read the switch asked for has the saved draft: the next save goes from its version, no conflict
    const typed = { ...OFFER, title: { ...OFFER.title, et: "Uus pealkiri" } };
    await show({ parts: partsOf(typed, OFFER, remote.version), stamp: 5, shown: { on: false, version: "v1+" } });
    await type(field("offer.title"), "Uus pealkiri 2");
    await leave(field("offer.title"));
    expect(remote.log.at(-1)).toEqual({ version: "d:1.1", patch: { title: { ...OFFER.title, et: "Uus pealkiri 2" } } });
    expect(remote.version).toBe("d:1.2");
  });

  it("a field the server holds back (a discount of 150) never stops the switch: it goes anyway (flush „settle“), and the field keeps its words", async () => {
    await show();
    remote.refuse = { discountPercent: "whole" };
    await type(field("offer.discountPercent"), "150");
    await click(toggle());
    expect(posts().map((c) => c.url)).toEqual([SAVE, SWITCH]);
    expect(text(undoBar())).toContain("Hüpikaken peidetud.");
    expect(field("offer.discountPercent")!.value).toBe("150");
    // the page's read after the switch starts the cards again from it: the field still holds her 150 (this browser's copy), never the stored 10
    await show({ parts: partsOf(), stamp: 5, shown: { on: false, version: "v1+" } });
    expect($("[data-cards-waiting]")).toBeNull();
    expect(field("offer.discountPercent")!.value).toBe("150");
  });

  it("a press that fails says the save line under the switch, which shows what it was", async () => {
    remote.naita = () => Response.json({ ok: false, error: "server" }, { status: 500 });
    await show();
    await click(toggle());
    expect(text(said())).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(toggle()?.checked).toBe(true);
    expect(text(undoBar())).toBe("");
  });
});
