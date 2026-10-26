// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditLangProvider } from "@/components/admin/EditLang";
import { HomeEditor } from "@/components/admin/HomeEditor";
import { UndoProvider } from "@/components/admin/UndoBar";
import type { FaqDraft, SlideDraft } from "@/domain/site-editor";
import type { SitePartState } from "@/domain/site-entities";
import { stubFetch } from "../fakes";

// C1 Avaleht on the draft layer (admin UX pass piece 4a, Task 6; README §4 C1 "the slide row is drag | thumbnail 72×48 | ET title + RU line |
// Hele/Tume tag | ↑/↓. Errors are keyed by row id. „Koolitaja plokk“ becomes the link row „Muuda lehel Koolitaja →“", the Part 3 / Part 4 C1 frames;
// piece4-texts S4-5…S4-12, S4-3; builder notes §5; rulings R-a, R-d): the site editors' page (site/SiteEditorPage.tsx) with the cards in the public
// page's order — „Slaidid“ (rows; one slide open inline at a time), „MS LABi lause“, „Koolitaja kaart“, „KKK“ (the question shows, the answer folds) —
// and the link row „Koolitaja plokk“. Every field autosaves into its part's draft (POST /api/admin/sisu/home/0/osa/<part>); ONE bar publishes them all.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/avaleht",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/shrink-image", () => ({ shrinkImage: async (file: File) => file, ShrinkError: class ShrinkError extends Error {} }));

const slide = (uid: string, id: number, patch: Partial<SlideDraft>): SlideDraft => ({
  uid,
  id,
  imageKey: `/seed/${uid}.jpg`,
  imagePos: "50% 50%",
  imagePosMobile: "50% 50%",
  tone: "light",
  kicker: { et: `Väike ${id}`, ru: `Малый ${id}` },
  title: { et: `Pealkiri ${id}`, ru: `Заголовок ${id}` },
  text: { et: `Alapealkiri ${id}`, ru: `Подзаголовок ${id}` },
  ctaLabel: { et: "Vaata", ru: "Смотреть" },
  ctaHref: "/koolitused",
  active: true,
  ...patch,
});
const SLIDES: SlideDraft[] = [
  slide("s1", 1, { title: { et: "Õpilase edu on meie eesmärk.", ru: "Успех ученика — наша цель." } }),
  slide("s2", 2, { tone: "dark", title: { et: "Täpsusest sünnib enesekindlus.", ru: "" } }),
  slide("s3", 3, { active: false, title: { et: "Väike detail. Suur muutus.", ru: "Маленькая деталь." } }),
];
const FAQ: FaqDraft[] = [
  { uid: "f1", id: 1, q: { et: "Kas koolitus sobib algajale?", ru: "Подходит ли курс новичку?" }, a: { et: "Jah, sobib.", ru: "Да." } },
  { uid: "f2", id: 2, q: { et: "Mitu modelli on praktikas?", ru: "Сколько моделей?" }, a: { et: "Kaks.", ru: "" } },
];
const STATEMENT = { body: { et: "MS LAB, kus täpsus kohtub hoolega.", ru: "MS LAB, где точность встречает заботу." } };
const TEASER = { body: { et: "Kulmu- ja ripsmetehnikate meister.", ru: "Мастер бровей." } };
/** The key the fake upload route answers (an upload's key: img/<uuid>.jpg). */
const UPLOADED = "img/0b7c3e1a-1d2e-4f5a-8b9c-0d1e2f3a4b5c.jpg";
const LIVE: Record<string, Record<string, unknown>> = { slides: { slides: SLIDES }, statement: STATEMENT, teaser: TEASER, faq: { faq: FAQ } };

/** The parts as the page reads them (server/site-drafts.ts readSiteEditor): live, no drafts; `over` replaces a part's live value. */
const partsOf = (over: Record<string, Record<string, unknown>> = {}): Record<string, SitePartState> =>
  Object.fromEntries(Object.entries({ ...LIVE, ...over }).map(([part, value]) => [part, { version: `l:${part}`, value, live: value }]));

/**
 * The routes: each part's stored value and version; a save is a draft; `refuse` answers a 400's field codes; `hold` keeps a save's answer back until
 * the test lets it go; `log` the saves in order.
 */
const remote = {
  parts: {} as Record<string, { version: string; value: Record<string, unknown> }>,
  n: 0,
  refuse: null as null | ((part: string, patch: Record<string, unknown>) => Record<string, string> | null),
  hold: null as null | ((part: string, patch: Record<string, unknown>) => Promise<void> | null),
  log: [] as { part: string; version: string; patch: Record<string, unknown> }[],
};
function resetRemote() {
  remote.parts = Object.fromEntries(Object.entries(LIVE).map(([part, value]) => [part, { version: `l:${part}`, value: { ...value } }]));
  remote.n = 0;
  remote.refuse = null;
  remote.hold = null;
  remote.log = [];
}
const respond = async (url: string, init: RequestInit | undefined): Promise<Response> => {
  if (url === "/api/admin/upload") return Response.json({ ok: true, key: UPLOADED });
  const press = url.match(/^\/api\/admin\/sisu\/home\/0\/(avalda|loobu)$/);
  if (press) return Response.json(press[1] === "avalda" ? { stamp: 5, published: Object.keys(LIVE), blocked: [] } : { stamp: 5 });
  const m = url.match(/^\/api\/admin\/sisu\/home\/0\/osa\/(\w+)$/);
  if (!m) return Response.json({ ok: false }, { status: 404 });
  const part = m[1];
  const body = JSON.parse(String(init?.body)) as { version: string; patch: Record<string, unknown> };
  remote.log.push({ part, ...body });
  const wait = remote.hold?.(part, body.patch);
  if (wait) await wait;
  const refused = remote.refuse?.(part, body.patch);
  if (refused) return Response.json({ ok: false, error: "invalid", fields: refused }, { status: 400 });
  const stored = remote.parts[part];
  if (body.version !== stored.version) return Response.json({ ok: false, error: "conflict", version: stored.version, value: stored.value }, { status: 409 });
  remote.n += 1;
  stored.value = { ...stored.value, ...body.patch };
  stored.version = `d:9.${remote.n}`;
  return Response.json({ ok: true, version: stored.version, savedAt: "2026-10-26T08:05:00.000Z" });
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
const show = async (parts = partsOf()) => {
  await act(async () =>
    root.render(createElement(EditLangProvider, null, createElement(UndoProvider, null, createElement(HomeEditor, { parts, stamp: 1, links: ["/koolitused", "/praktika"] })))),
  );
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
/** A part's field by its name (`slides.1.title`, `faq.0.q`): a one-language field's data-field, a two-language field's data-i18n. */
const field = (name: string) => $<HTMLInputElement>(`[data-field="${name}"], [data-i18n="${name}"]`);
const labelOf = (el: Element | null) => text(container.querySelector(`label[for="${el?.id}"]`));
/** An element's words as a screen reader names it from its content: without what is aria-hidden (a ▸ that only decorates). */
const named = (el: Element) => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll("[aria-hidden='true']").forEach((x) => x.remove());
  return text(copy);
};
const button = (name: string | RegExp, within: Element | null = container) =>
  Array.from(within?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((b) => {
    const own = b.getAttribute("aria-label") ?? named(b);
    return typeof name === "string" ? own === name : name.test(own);
  }) ?? null;
const card = (id: string) => $(`section#${id}`);
const undoBar = () => document.querySelector<HTMLElement>("[data-undo-bar]");
const barWords = () => text($("[data-publish-words]"));
const draft = (labels: string) => `Avaldamata muudatused: ${labels.split(", ").length} · ${labels}. Avalikul lehel on näha eelmine versioon.`;
const slideRow = (uid: string) => $(`[data-slide="${uid}"]`);
const openSlides = () => $$("[data-slide][data-open]").map((el) => el.getAttribute("data-slide"));
const slideOrder = () => $$("[data-slide]").map((el) => el.getAttribute("data-slide"));
/** The slide's row button that opens it (its name starts „Slaid {n}“). */
const opener = (uid: string) => slideRow(uid)!.querySelector<HTMLButtonElement>("[data-slide-open]");
const faqRow = (uid: string) => $(`[data-faq-row="${uid}"]`);
const faqToggle = (uid: string) => faqRow(uid)!.querySelector<HTMLButtonElement>("[data-faq-toggle]");
const seg = (lang: "et" | "ru") => $<HTMLButtonElement>(`[data-edit-lang-switch] [data-edit-lang="${lang}"]`);

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

describe("the page (S4-5, S4-6) and its cards in the public page's order (the P4 C1 frame)", () => {
  it("eyebrow „Koduleht“, H1 „Avaleht“, the lead S4-6; „Vaata lehel ↗“ opens /; no bar while nothing waits; no „Salvesta“", async () => {
    await show();
    expect(text($("[data-site-eyebrow]"))).toBe("Koduleht");
    expect(text($("h1"))).toBe("Avaleht");
    expect(text($("[data-site-lead]"))).toBe("Avalehe slaidid, MS LABi lause ja korduma kippuvad küsimused. Muudatus on avalehel näha pärast avaldamist.");
    expect($("[data-site-view]")!.getAttribute("href")).toBe("/");
    expect($("[data-publish-bar]")).toBeNull();
    expect($("[data-save-bar]")).toBeNull();
    expect(button("Salvesta")).toBeNull();
  });

  it("„Slaidid“, „MS LABi lause“, „Koolitaja kaart“, „KKK“, then the link row „Koolitaja plokk“ with „Muuda lehel Koolitaja →“; the map's five entries, the link's value „→“", async () => {
    await show();
    const cards = $$<HTMLElement>("[data-home-editor] > section");
    expect(cards.map((c) => text(c.querySelector("h2")))).toEqual(["Slaidid", "MS LABi lause", "Koolitaja kaart", "KKK", "Koolitaja plokk"]);
    for (const c of cards) {
      expect(c.getAttribute("tabindex")).toBe("-1");
      expect(c.getAttribute("aria-labelledby")).toBe(c.querySelector("h2")!.id);
    }
    // the link row: one link to the trainer's page, nothing else to fill in
    const linkRow = cards[4];
    const link = linkRow.querySelector<HTMLAnchorElement>("a")!;
    expect(text(link)).toBe("Muuda lehel Koolitaja →");
    expect(link.getAttribute("href")).toBe("/admin/koolitaja");
    expect(linkRow.querySelector("input, textarea")).toBeNull();
    // the map (from 1180 px; 170 px wide on the C screens): the slides, the questions, „RU puudub“ where a Russian text is missing, the link's „→“
    const links = $$<HTMLAnchorElement>("nav[aria-label='Jaotised'] a");
    expect(links.map((a) => text(a.querySelector("[data-section-label]")))).toEqual(["Slaidid", "MS LABi lause", "Koolitaja kaart", "KKK", "Koolitaja plokk"]);
    expect(links.map((a) => text(a.querySelector("[data-section-status]")))).toEqual(["3 · RU puudub", "", "", "2 · RU puudub", "→"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(cards.map((c) => `#${c.id}`));
    expect($("nav[aria-label='Jaotised']")!.className).toMatch(/narrow/);
  });

  it("„MS LABi lause“ and „Koolitaja kaart“: their text typed and left goes into its own draft; the bar names the card", async () => {
    await show();
    expect(labelOf(field("statement.body"))).toBe("Lause (eesti keeles)");
    expect(field("teaser.body")!.closest("[data-teaser-editor]")).not.toBeNull();
    await type(field("teaser.body"), "Uus kaardi tekst.");
    await leave(field("teaser.body"));
    expect(remote.log).toEqual([{ part: "teaser", version: "l:teaser", patch: { body: { et: "Uus kaardi tekst.", ru: TEASER.body.ru } } }]);
    expect(barWords()).toBe(draft("Koolitaja kaart"));
    expect(field("teaser.body")!.closest("[data-i18n-box]")!.hasAttribute("data-unpublished")).toBe(true);
    expect(field("statement.body")!.closest("[data-i18n-box]")!.hasAttribute("data-unpublished")).toBe(false);
  });
});

describe("„Slaidid“: rows, one slide open inline at a time (README §4 C1, P3 / P4 frames, S4-9, S4-10)", () => {
  it("each row: the handle, the 72 × 48 thumbnail, the ET title over „RU: …“ („RU: RU puudub“ with none), the tone tag, ↑ ↓; „+ Lisa slaid“ on the title's row", async () => {
    await show();
    expect(slideOrder()).toEqual(["s1", "s2", "s3"]);
    expect(openSlides()).toEqual([]);
    const row = slideRow("s2")!;
    expect(row.querySelector('[data-drag-tool="handle"]')!.getAttribute("aria-label")).toBe("Lohista rida 2");
    expect(row.querySelector<HTMLImageElement>("[data-slide-thumb]")!.getAttribute("src")).toBe("/seed/s2.jpg");
    expect(text(row.querySelector("[data-slide-title]"))).toBe("Täpsusest sünnib enesekindlus.");
    expect(text(row.querySelector("[data-slide-ru]"))).toBe("RU: RU puudub");
    expect(text(slideRow("s1")!.querySelector("[data-slide-ru]"))).toBe("RU: Успех ученика — наша цель.");
    expect(text(row.querySelector("[data-slide-tone]"))).toBe("Tume");
    expect(text(slideRow("s1")!.querySelector("[data-slide-tone]"))).toBe("Hele");
    // a slide not shown on the home page says so on its row
    expect(text(slideRow("s3")!)).toContain("Peidetud");
    expect(button("Liiguta slaid 2 ettepoole", row)).not.toBeNull();
    expect(button("Liiguta slaid 2 tahapoole", row)).not.toBeNull();
    // the row's button opens the slide; its name says which slide
    expect(named(opener("s2")!)).toMatch(/^Slaid 2/);
    const add = button("+ Lisa slaid", card("slaidid"));
    expect(add).not.toBeNull();
    expect(add!.compareDocumentPosition($("[data-slide]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opening slide 2 closes slide 1: one slide is open at a time, its fields in the inline box; the open slide is a group named „Slaid {n}“", async () => {
    await show();
    await click(opener("s1"));
    expect(openSlides()).toEqual(["s1"]);
    expect(field("slides.0.title")).not.toBeNull();
    expect(field("slides.1.title")).toBeNull();
    const box = slideRow("s1")!.querySelector<HTMLElement>("[data-slide-box]")!;
    expect(box.getAttribute("role")).toBe("group");
    expect(box.getAttribute("aria-label")).toBe("Slaid 1");
    expect(document.activeElement).toBe(box);

    await click(opener("s2"));
    expect(openSlides()).toEqual(["s2"]);
    expect(field("slides.0.title")).toBeNull();
    expect(field("slides.1.title")!.value).toBe("Täpsusest sünnib enesekindlus.");
    // the closed slide is a row again, with its button
    expect(opener("s1")).not.toBeNull();
  });

  it("the open slide: the picture with its focal point and „Puuduta pilti, et valida fookus · Vaheta pilt“; „Pealkiri“, „Alapealkiri“ and every field it had; Hele | Tume; „Eemalda slaid“", async () => {
    await show();
    await click(opener("s2"));
    const box = slideRow("s2")!.querySelector<HTMLElement>("[data-slide-box]")!;
    const media = box.querySelector("[data-slide-media]")!;
    expect(media.querySelector("[data-focal-pick] img")!.getAttribute("src")).toBe("/seed/s2.jpg");
    expect(text(media.querySelector("[data-focal-hint]"))).toBe("Puuduta pilti, et valida fookus · Vaheta pilt");
    expect(media.querySelector<HTMLInputElement>('input[type="file"]')).not.toBeNull();
    // both focal views are kept (builder notes §5)
    expect($$("[data-focal-tab]").map((b) => text(b))).toEqual(["Arvutis", "Telefonis"]);
    const fields = box.querySelector("[data-slide-fields]")!;
    const labels = Array.from(fields.querySelectorAll("label")).map((l) => text(l));
    expect(labels.slice(0, 2)).toEqual(["Pealkiri (eesti keeles)", "Alapealkiri (eesti keeles)"]);
    for (const kept of ["Väike pealkiri (eesti keeles)", "Nupu tekst (eesti keeles)", "Nupp viib", "Hele", "Tume"]) expect(labels).toContain(kept);
    // „Näidatakse avalehel“ is a drafted box of its own (builder notes §5), named by its words, its hint its description
    const shown = fields.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(shown.checked).toBe(true);
    expect(text(document.getElementById(shown.getAttribute("aria-labelledby")!))).toBe("Näidatakse avalehel");
    const tone = fields.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(Array.from(tone).map((r) => r.checked)).toEqual([false, true]);
    const remove = button("Eemalda slaid 2", box)!;
    expect(named(remove)).toBe("Eemalda slaid");
    // the media column first, then the fields (drawn: the picture on the left)
    expect(media.compareDocumentPosition(fields) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a slide's title typed: „· avaldamata“ at the field, the bar „Slaid 2 pealkiri“; left, the slides' draft gets the list", async () => {
    await show();
    await click(opener("s2"));
    await type(field("slides.1.title"), "Täpsusest sünnib julgus.");
    expect(barWords()).toBe(draft("Slaid 2 pealkiri"));
    expect(field("slides.1.title")!.closest("[data-i18n-box]")!.hasAttribute("data-unpublished")).toBe(true);
    expect(field("slides.1.text")!.closest("[data-i18n-box]")!.hasAttribute("data-unpublished")).toBe(false);
    await leave(field("slides.1.title"));
    expect(remote.log).toEqual([
      { part: "slides", version: "l:slides", patch: { slides: [SLIDES[0], { ...SLIDES[1], title: { et: "Täpsusest sünnib julgus.", ru: "" } }, SLIDES[2]] } },
    ]);
    expect(text($("[data-save-status] [role=status]"))).toBe("Mustand salvestatud 10:05");
  });

  it("„Tume“ chosen is saved at once (a choice), the row's tag follows it", async () => {
    await show();
    await click(opener("s1"));
    const dark = slideRow("s1")!.querySelectorAll<HTMLInputElement>('[data-slide-fields] input[type="radio"]')[1];
    await act(async () => dark.click());
    await settle();
    expect(remote.log).toHaveLength(1);
    expect((remote.log[0].patch.slides as SlideDraft[])[0]).toMatchObject({ uid: "s1", tone: "dark", imagePosMobile: "90% 50%" });
    expect(barWords()).toBe(draft("Slaid 1 pilt, Slaid 1 toon"));
    await click(opener("s2"));
    expect(text(slideRow("s1")!.querySelector("[data-slide-tone]"))).toBe("Tume");
  });

  it("„+ Lisa slaid“ opens a new slide at the end (the others close) with the cursor in its title; the list is saved at once; the bar says „Slaidid“; at 8 it says the limit", async () => {
    await show();
    await click(opener("s1"));
    await click(button("+ Lisa slaid"));
    expect(slideOrder()).toHaveLength(4);
    const added = slideOrder()[3]!;
    expect(openSlides()).toEqual([added]);
    expect(document.activeElement).toBe(field("slides.3.title"));
    expect(remote.log).toHaveLength(1);
    const sent = remote.log[0].patch.slides as SlideDraft[];
    expect(sent.slice(0, 3)).toEqual(SLIDES);
    expect(sent[3]).toMatchObject({ uid: added, id: null, imageKey: "", title: { et: "" }, ctaHref: "/koolitused", active: true });
    expect(barWords()).toBe(draft("Slaidid"));
    // no picture yet: the media column says so and offers „Vali pilt“
    expect(text(slideRow(added)!.querySelector("[data-slide-media]"))).toContain("Pilti pole veel valitud.");
    for (let i = 0; i < 4; i++) await click(button("+ Lisa slaid"));
    expect(slideOrder()).toHaveLength(8);
    expect(button("+ Lisa slaid")!.getAttribute("aria-disabled")).toBe("true");
    expect(text(card("slaidid"))).toContain("Slaide saab olla kuni 8.");
    await click(button("+ Lisa slaid"));
    expect(slideOrder()).toHaveLength(8);
  });

  it("„Eemalda slaid“ takes the slide out at once with „Slaid eemaldatud.“; „Võta tagasi“ puts it back at its place and saves", async () => {
    await show();
    await click(opener("s2"));
    await click(button("Eemalda slaid 2"));
    expect(slideOrder()).toEqual(["s1", "s3"]);
    expect(remote.log.at(-1)).toEqual({ part: "slides", version: "l:slides", patch: { slides: [SLIDES[0], SLIDES[2]] } });
    expect(text(undoBar()!.querySelector("p"))).toBe("Slaid eemaldatud.");
    expect(barWords()).toBe(draft("Slaidid"));
    await click(undoBar()!.querySelector("button"));
    expect(slideOrder()).toEqual(["s1", "s2", "s3"]);
    expect(remote.log.at(-1)!.patch).toEqual({ slides: SLIDES });
    expect($("[data-publish-bar]")).toBeNull();
  });

  it("an upload into the open slide lands on that slide by its key and is saved at once", async () => {
    await show();
    await click(opener("s3"));
    const input = slideRow("s3")!.querySelector<HTMLInputElement>('[data-slide-media] input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(input, "files", { value: [new File(["x"], "uus.jpg", { type: "image/jpeg" })], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(remote.log.at(-1)!.part).toBe("slides");
    expect((remote.log.at(-1)!.patch.slides as SlideDraft[]).map((s) => s.imageKey)).toEqual(["/seed/s1.jpg", "/seed/s2.jpg", UPLOADED]);
    expect(barWords()).toBe(draft("Slaid 3 pilt"));
  });

  it("errors keyed by row: a refused link on slide 2 stays on that slide when the rows move while its save is on its way", async () => {
    // the first save (slide 2's link) is answered only when the test says so; it is refused; the list sent after the move waits for good
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    remote.hold = (part, patch) => {
      if (part !== "slides") return null;
      const sent = patch.slides as SlideDraft[];
      return sent[0]?.uid === "s1" ? first : new Promise<void>(() => {});
    };
    remote.refuse = (part, patch) => ((patch.slides as SlideDraft[] | undefined)?.some((s) => s.ctaHref.startsWith("javascript:")) ? { slides: "href" } : null);
    await show();
    await click(opener("s2"));
    await type(field("slides.1.ctaHref"), "javascript:alert(1)");
    await leave(field("slides.1.ctaHref"));
    expect(remote.log).toHaveLength(1);
    // slide 1 moves down while that save is on its way: slide 2 is first now
    await click(button("Liiguta slaid 1 tahapoole", slideRow("s1")));
    expect(slideOrder()).toEqual(["s2", "s1", "s3"]);
    await act(async () => release());
    await settle();
    // the refusal of the list as it was sent lands on slide 2, wherever it is now: its link, in its box
    const link = slideRow("s2")!.querySelector<HTMLInputElement>('[data-field="slides.0.ctaHref"]')!;
    expect(link.getAttribute("aria-invalid")).toBe("true");
    const words = container.querySelector(`#${CSS.escape(link.getAttribute("aria-describedby")!.split(" ").at(-1)!)}`);
    expect(text(words)).not.toBe("");
    expect(words!.closest("[data-slide]")!.getAttribute("data-slide")).toBe("s2");
    // slide 1 has no error: opened, its link is quiet
    await click(opener("s1"));
    expect(slideRow("s1")!.querySelector('[data-field="slides.1.ctaHref"]')!.getAttribute("aria-invalid")).toBeNull();
    // the map says the slides need a look
    expect(text($$("nav[aria-label='Jaotised'] a")[0].querySelector("[data-section-status]"))).toBe("3 · Kontrolli");
  });

  it("a refused slide opens by itself (the first one refused)", async () => {
    remote.refuse = (part, patch) => ((patch.slides as SlideDraft[] | undefined)?.some((s) => s.ctaHref.startsWith("javascript:")) ? { slides: "href" } : null);
    await show();
    await click(opener("s3"));
    await type(field("slides.2.ctaHref"), "javascript:x");
    await leave(field("slides.2.ctaHref"));
    await click(opener("s1"));
    expect(openSlides()).toEqual(["s1"]);
    // a new refusal (another value sent): slide 3 opens to show it
    await click(opener("s3"));
    await type(field("slides.2.ctaHref"), "javascript:y");
    await click(opener("s1"));
    await leave(field("slides.0.title"));
    expect(openSlides()).toEqual(["s3"]);
    expect(field("slides.2.ctaHref")!.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("„KKK“: the question shows, the answer is folded (P4 note, S4-11), drag, ↑ ↓ and removal with undo (S4-3)", () => {
  it("each row: the handle, the question's field, the state „ET · RU“ or „RU puudub“ with ▸ (the answer folded), ↑ ↓ ×", async () => {
    await show();
    const row = faqRow("f1")!;
    expect(row.querySelector('[data-drag-tool="handle"]')!.getAttribute("aria-label")).toBe("Lohista rida 1");
    expect(field("faq.0.q")!.value).toBe("Kas koolitus sobib algajale?");
    expect(labelOf(field("faq.0.q"))).toBe("Küsimus 1 (eesti keeles)");
    expect(field("faq.0.a")).toBeNull();
    expect(text(faqToggle("f1"))).toBe("Vastus 1 · ET · RU ▸");
    expect(named(faqToggle("f1")!)).toBe("Vastus 1 · ET · RU");
    expect(faqToggle("f1")!.getAttribute("aria-expanded")).toBe("false");
    expect(faqRow("f2")!.querySelector("[data-faq-state]")!.textContent).toBe("RU puudub");
    expect(faqRow("f1")!.querySelector("[data-faq-state]")!.textContent).toBe("ET · RU");
    expect(button("Liiguta küsimus 1 üles", row)).not.toBeNull();
    expect(button("Liiguta küsimus 1 alla", row)).not.toBeNull();
    expect(button("Eemalda küsimus 1", row)).not.toBeNull();
  });

  it("▸ opens the answer under its question (several may be open); typed and left, the FAQ's draft and the bar „KKK vastus 2“", async () => {
    await show();
    await click(faqToggle("f2"));
    expect(faqToggle("f2")!.getAttribute("aria-expanded")).toBe("true");
    expect(field("faq.1.a")!.value).toBe("Kaks.");
    await click(faqToggle("f1"));
    expect(field("faq.0.a")).not.toBeNull();
    expect(field("faq.1.a")).not.toBeNull();
    await type(field("faq.1.a"), "Kaks modelli.");
    await leave(field("faq.1.a"));
    expect(remote.log).toEqual([{ part: "faq", version: "l:faq", patch: { faq: [FAQ[0], { ...FAQ[1], a: { et: "Kaks modelli.", ru: "" } }] } }]);
    expect(barWords()).toBe(draft("KKK vastus 2"));
    await click(faqToggle("f2"));
    expect(field("faq.1.a")).toBeNull();
  });

  it("× takes the question out at once with „Küsimus eemaldatud.“; „Võta tagasi“ puts it back at its place and saves", async () => {
    await show();
    await click(button("Eemalda küsimus 1"));
    expect($$("[data-faq-row]").map((el) => el.getAttribute("data-faq-row"))).toEqual(["f2"]);
    expect(remote.log.at(-1)).toEqual({ part: "faq", version: "l:faq", patch: { faq: [FAQ[1]] } });
    expect(text(undoBar()!.querySelector("p"))).toBe("Küsimus eemaldatud.");
    expect(barWords()).toBe(draft("KKK"));
    await click(undoBar()!.querySelector("button"));
    expect($$("[data-faq-row]").map((el) => el.getAttribute("data-faq-row"))).toEqual(["f1", "f2"]);
    expect(remote.log.at(-1)!.patch).toEqual({ faq: FAQ });
    expect($("[data-publish-bar]")).toBeNull();
  });

  it("↑ moves a question and saves at once; „+ Lisa küsimus“ adds one with its answer open and the cursor in the question", async () => {
    await show();
    await click(button("Liiguta küsimus 2 üles"));
    expect($$("[data-faq-row]").map((el) => el.getAttribute("data-faq-row"))).toEqual(["f2", "f1"]);
    expect(remote.log.at(-1)!.patch).toEqual({ faq: [FAQ[1], FAQ[0]] });
    await click(button("+ Lisa küsimus"));
    const rows = $$("[data-faq-row]");
    expect(rows).toHaveLength(3);
    expect(document.activeElement).toBe(field("faq.2.q"));
    expect(field("faq.2.a")).not.toBeNull();
    expect(barWords()).toBe(draft("KKK"));
  });
});

describe("the RU pass (README §1.9; the P4 note „Järgmine →“ walks through the empty fields)", () => {
  it("with RU on, „Järgmine →“ opens the closed slide and then the folded answer whose Russian is missing, the cursor in each", async () => {
    await show();
    await click(seg("ru"));
    // slide 2's title (a closed slide) and question 2's answer (folded)
    expect(text($("[data-ru-missing]"))).toBe("RU puudub 2 väljal" + "Järgmine →");
    await click($("[data-ru-next]"));
    expect(openSlides()).toEqual(["s2"]);
    expect((document.activeElement as HTMLElement).getAttribute("data-i18n")).toBe("slides.1.title");
    expect((document.activeElement as HTMLElement).getAttribute("data-lang-field")).toBe("ru");
    await click($("[data-ru-next]"));
    expect(faqToggle("f2")!.getAttribute("aria-expanded")).toBe("true");
    expect((document.activeElement as HTMLElement).getAttribute("data-i18n")).toBe("faq.1.a");
    expect((document.activeElement as HTMLElement).getAttribute("data-lang-field")).toBe("ru");
    expect(text($("[data-ru-missing]"))).toContain("RU puudub 2 väljal"); // each counted once, open or folded
  });
});
