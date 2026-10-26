// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrainerEditor } from "@/components/admin/TrainerEditor";
import { UndoProvider } from "@/components/admin/UndoBar";
import type { PageDraft, TrainerDraft, WorkDraft } from "@/domain/site-editor";
import type { SitePartState } from "@/domain/site-entities";
import { stubFetch } from "../fakes";

// C2 Koolitaja on the draft layer (admin UX pass piece 4a, Task 5; README §4 C2 "the template; the gallery is shared with the course editor (drag +
// undo); empty story cards fold", the Part 4 C2 frame; piece4-texts S4-13…S4-17, S4-3; builder notes §5; rulings R-a, R-g): the site editors' page
// (site/SiteEditorPage.tsx) with five cards in the public page's order — „Portree ja tutvustus“ (the portrait with its focal point beside „Nimi“,
// „Amet“ and „Tutvustus“: the parts `trainer` and `bio`), „Numbrid“ (three fixed pairs of `trainer.stats`), „Galerii“ (the works as a grid of tiles,
// GalleryEditor layout="grid"), „Koolituskeskuse lugu“ and „Koolitaja teekond“ (folded while empty). Every field autosaves into its part's draft
// (POST /api/admin/sisu/trainer/0/osa/<part>), and ONE bar publishes them all.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/koolitaja",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/shrink-image", () => ({ shrinkImage: async (file: File) => file, ShrinkError: class ShrinkError extends Error {} }));

const TRAINER: TrainerDraft = {
  portraitKey: "img/portree.jpg",
  portraitPos: "50% 30%",
  name: { et: "Maria Sosnina", ru: "Мария Соснина" },
  role: { et: "Kulmumeister ja koolitaja", ru: "Мастер и преподаватель" },
  stats: [
    { uid: "t0", value: "8+", label: { et: "aastat kogemust", ru: "лет опыта" } },
    { uid: "t1", value: "600+", label: { et: "koolitatud õpilast", ru: "учеников" } },
  ],
};
const BIO = { body: { et: "Kulmumeister ja koolitaja, kes usub täpsesse analüüsi.", ru: "Мастер бровей." } };
const WORKS: { works: WorkDraft[] } = {
  works: [
    { key: "/seed/a.jpg", alt: { et: "Esimene", ru: "Первый" } },
    { key: "/seed/b.jpg", alt: { et: "Teine", ru: "Второй" } },
    { key: "/seed/c.jpg", alt: { et: "Kolmas", ru: "Третий" } },
  ],
};
const CENTER: PageDraft = { title: { et: "MS LAB Koolituskeskus", ru: "Учебный центр MS LAB" }, body: { et: "MS LAB ühendab teooria ja praktika.", ru: "MS LAB объединяет." } };
const EMPTY: PageDraft = { title: { et: "" }, body: { et: "" } };
const LIVE: Record<string, Record<string, unknown>> = { trainer: TRAINER, bio: BIO, works: WORKS, center_story: CENTER, trainer_journey: EMPTY };

/** The parts as the page reads them (server/site-drafts.ts readSiteEditor): live, no drafts; `over` replaces a part's live value. */
const partsOf = (over: Record<string, Record<string, unknown>> = {}): Record<string, SitePartState> =>
  Object.fromEntries(Object.entries({ ...LIVE, ...over }).map(([part, value]) => [part, { version: `l:${part}`, value, live: value }]));

/** The routes: each part's stored value and version; a save is a draft; `refuse` answers a 400's field codes; `log` the saves in order. */
const remote = {
  parts: {} as Record<string, { version: string; value: Record<string, unknown> }>,
  n: 0,
  refuse: null as null | ((part: string, patch: Record<string, unknown>) => Record<string, string> | null),
  log: [] as { part: string; version: string; patch: Record<string, unknown> }[],
};
function resetRemote() {
  remote.parts = Object.fromEntries(Object.entries(LIVE).map(([part, value]) => [part, { version: `l:${part}`, value: { ...value } }]));
  remote.n = 0;
  remote.refuse = null;
  remote.log = [];
}
const respond = (url: string, init: RequestInit | undefined): Response => {
  if (url === "/api/admin/upload") return Response.json({ ok: true, key: "img/uus.jpg" });
  const press = url.match(/^\/api\/admin\/sisu\/trainer\/0\/(avalda|loobu)$/);
  if (press) return Response.json(press[1] === "avalda" ? { stamp: 5, published: Object.keys(LIVE), blocked: [] } : { stamp: 5 });
  const m = url.match(/^\/api\/admin\/sisu\/trainer\/0\/osa\/(\w+)$/);
  if (!m) return Response.json({ ok: false }, { status: 404 });
  const part = m[1];
  const body = JSON.parse(String(init?.body)) as { version: string; patch: Record<string, unknown> };
  remote.log.push({ part, ...body });
  const refused = remote.refuse?.(part, body.patch);
  if (refused) return Response.json({ ok: false, error: "invalid", fields: refused }, { status: 400 });
  const stored = remote.parts[part];
  if (body.version !== stored.version) return Response.json({ ok: false, error: "conflict", version: stored.version, value: stored.value }, { status: 409 });
  remote.n += 1;
  stored.value = { ...stored.value, ...body.patch };
  stored.version = `d:7.${remote.n}`;
  return Response.json({ ok: true, version: stored.version, savedAt: "2026-10-26T07:40:00.000Z" });
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
    root.render(
      createElement(UndoProvider, null, createElement(TrainerEditor, { parts, stamp: 1, storyTitles: { center_story: "Koolituskeskuse lugu", trainer_journey: "Koolitaja teekond" } })),
    ),
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
/** A part's field by its name (`trainer.name`, `trainer.stats.2.value`): a one-language field's data-field, a two-language field's data-i18n. */
const field = (name: string) => $<HTMLInputElement>(`[data-field="${name}"], [data-i18n="${name}"]`);
const labelOf = (el: Element | null) => text(container.querySelector(`label[for="${el?.id}"]`));
/** An element's words as a screen reader names it from its content: without what is aria-hidden (a ▸ that only decorates). */
const named = (el: Element) => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll("[aria-hidden='true']").forEach((x) => x.remove());
  return text(copy);
};
const button = (name: string, within: Element | null = container) =>
  Array.from(within?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((b) => named(b) === name || b.getAttribute("aria-label") === name) ?? null;
const card = (id: string) => $(`section#${id}`);
const undoBar = () => document.querySelector<HTMLElement>("[data-undo-bar]");
const barWords = () => text($("[data-publish-words]"));
const draft = (labels: string) => `Avaldamata muudatused: ${labels.split(", ").length} · ${labels}. Avalikul lehel on näha eelmine versioon.`;
const tiles = () => $$("[data-gallery-item]").map((el) => el.getAttribute("data-gallery-item"));

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

describe("the page (S4-13) and its five cards in the public page's order (the P4 C2 frame)", () => {
  it("eyebrow „Koduleht“, H1 „Koolitaja“, the lead; „Vaata lehel ↗“ opens /koolitaja; no bar while nothing waits; no „Salvesta“", async () => {
    await show();
    expect(text($("[data-site-eyebrow]"))).toBe("Koduleht");
    expect(text($("h1"))).toBe("Koolitaja");
    expect(text($("[data-site-lead]"))).toBe("Koolitaja leht: portree, nimi, tutvustus, numbrid, tööde galerii ja kaks lugu. Avalehe koolitaja plokk kasutab samu andmeid.");
    expect($("[data-site-view]")!.getAttribute("href")).toBe("/koolitaja");
    expect($("[data-publish-bar]")).toBeNull();
    expect($("[data-save-bar]")).toBeNull();
    expect(button("Salvesta")).toBeNull();
  });

  it("„Portree ja tutvustus“, „Numbrid“, „Galerii“, „Koolituskeskuse lugu“, „Koolitaja teekond“, each a site card in the screen's marker; the section map's five entries", async () => {
    await show();
    const cards = $$<HTMLElement>("[data-trainer-editor] > section");
    expect(cards.map((c) => text(c.querySelector("h2")))).toEqual(["Portree ja tutvustus", "Numbrid", "Galerii", "Koolituskeskuse lugu", "Koolitaja teekond"]);
    for (const c of cards) {
      expect(c.getAttribute("tabindex")).toBe("-1");
      expect(c.getAttribute("aria-labelledby")).toBe(c.querySelector("h2")!.id);
    }
    // the map (from 1180 px; 170 px wide on the C screens): the cards' names, the numbers' pairs filled, the pictures, an empty story's „tühi“
    const links = $$<HTMLAnchorElement>("nav[aria-label='Jaotised'] a");
    expect(links.map((a) => text(a.querySelector("[data-section-label]")))).toEqual(["Portree ja tutvustus", "Numbrid", "Galerii", "Koolituskeskuse lugu", "Koolitaja teekond"]);
    expect(links.map((a) => text(a.querySelector("[data-section-status]")))).toEqual(["", "2", "3", "", "tühi"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(cards.map((c) => `#${c.id}`));
    expect($("nav[aria-label='Jaotised']")!.className).toMatch(/narrow/);
  });

  it("„Portree ja tutvustus“: the portrait with its focal point in its column, beside „Nimi“, „Amet“ and „Tutvustus“ (`trainer` and `bio`)", async () => {
    await show();
    const c = card("portree")!;
    const picture = c.querySelector("[data-portrait-column]")!;
    expect(picture.querySelector("[data-focal-point]")).not.toBeNull();
    expect(picture.querySelector('[data-single-image="portrait"]')).not.toBeNull();
    const fields = c.querySelector("[data-portrait-text]")!;
    expect(Array.from(fields.querySelectorAll("label")).map((l) => text(l))).toEqual(["Nimi (eesti keeles)", "Amet (eesti keeles)", "Tutvustus (eesti keeles)"]);
    expect(field("trainer.name")!.value).toBe("Maria Sosnina");
    expect(field("trainer.role")!.value).toBe("Kulmumeister ja koolitaja");
    expect(field("bio.body")!.value).toBe(BIO.body.et);
    // the picture first, then the text (the public page's order; the frame's 240 px column at the left)
    expect(picture.compareDocumentPosition(fields) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the fields autosave into their parts' drafts; the bar names them (S4-17)", () => {
  it("the focal point moved: the bar says „Portree“, and the trainer's draft gets it when the card is left", async () => {
    await show();
    const x = $<HTMLInputElement>('[data-focal-axis="portrait-x"]');
    await type(x, "30");
    expect(barWords()).toBe(draft("Portree"));
    // the picture has no label of its own on screen: its card says „· avaldamata“ (README §1.8), as „Numbrid“ and „Galerii“ do
    expect(text(card("portree")!.querySelector("h2"))).toBe("Portree ja tutvustus · avaldamata");
    await leave(x);
    expect(remote.log).toEqual([{ part: "trainer", version: "l:trainer", patch: { portraitPos: "30% 30%" } }]);
    expect(text($("[data-save-status] [role=status]"))).toBe("Mustand salvestatud 09:40");
  });

  it("the bio typed and left: the bio's draft, the bar „Tutvustus“, the field marked „· avaldamata“", async () => {
    await show();
    await type(field("bio.body"), "Uus tutvustus.");
    await leave(field("bio.body"));
    expect(remote.log).toEqual([{ part: "bio", version: "l:bio", patch: { body: { et: "Uus tutvustus.", ru: BIO.body.ru } } }]);
    expect(barWords()).toBe(draft("Tutvustus"));
    expect(field("bio.body")!.closest("[data-i18n-box]")!.hasAttribute("data-unpublished")).toBe(true);
    expect(field("trainer.name")!.closest("[data-i18n-box]")!.hasAttribute("data-unpublished")).toBe(false);
  });

  it("„Numbrid“: three fixed pairs whatever live holds; a third typed in is in the draft, and emptied again the draft is live's (an empty pair is never kept)", async () => {
    await show();
    const c = card("numbrid")!;
    expect(c.querySelectorAll("[data-stat-pair]")).toHaveLength(3);
    expect(labelOf(field("trainer.stats.0.value"))).toBe("Number 1");
    expect(labelOf(field("trainer.stats.2.label"))).toBe("Selgitus 3 (eesti keeles)");
    expect(field("trainer.stats.1.value")!.value).toBe("600+");
    expect(field("trainer.stats.2.value")!.value).toBe("");
    await type(field("trainer.stats.2.value"), "3");
    await type(field("trainer.stats.2.label"), "linna Eestis");
    await leave(field("trainer.stats.2.label"));
    expect(remote.log.at(-1)).toEqual({
      part: "trainer",
      version: "l:trainer",
      patch: { stats: [...TRAINER.stats, { uid: "t2", value: "3", label: { et: "linna Eestis" } }] },
    });
    expect(barWords()).toBe(draft("Numbrid"));
    expect(text(c.querySelector("h2"))).toBe("Numbrid · avaldamata");
    await type(field("trainer.stats.2.value"), "");
    await type(field("trainer.stats.2.label"), "");
    await leave(field("trainer.stats.2.label"));
    expect(remote.log.at(-1)!.patch).toEqual({ stats: TRAINER.stats });
    expect($("[data-publish-bar]")).toBeNull();
    // (the pair is still there to type in)
    expect(c.querySelectorAll("[data-stat-pair]")).toHaveLength(3);
  });

  it("„Numbrid“: a refused pair is said at its own field (aria-invalid, the words under it), the other pairs and the card's foot stay quiet", async () => {
    remote.refuse = (part, patch) => (part === "trainer" && "stats" in patch ? { "stats.1.value": "tooLong", stats: "tooLong" } : null);
    await show();
    // (the field's maxLength stops a typist at 12; the server's limit is the same)
    await type(field("trainer.stats.1.value"), "1234567890123");
    await leave(field("trainer.stats.1.value"));
    expect(remote.log.at(-1)!.part).toBe("trainer");
    const value = field("trainer.stats.1.value")!;
    expect(value.getAttribute("aria-invalid")).toBe("true");
    const words = container.querySelector(`#${CSS.escape(value.getAttribute("aria-describedby")!.split(" ").at(-1)!)}`);
    expect(text(words)).not.toBe("");
    expect(words!.closest("[data-stat-pair]")).toBe(card("numbrid")!.querySelectorAll("[data-stat-pair]")[1]);
    expect(field("trainer.stats.1.label")!.getAttribute("aria-invalid")).toBeNull();
    expect(field("trainer.stats.0.value")!.getAttribute("aria-invalid")).toBeNull();
    expect(card("numbrid")!.querySelector("[data-stats-error]")).toBeNull();
    // the map says the card needs a look; the portrait card does not
    const status = $$("nav[aria-label='Jaotised'] a").map((a) => text(a.querySelector("[data-section-status]")));
    expect(status.slice(0, 2)).toEqual(["", "2 · Kontrolli"]);
  });

  it("„Galerii“: the counter „Lohista järjekorra muutmiseks · {n} / 24“ and the tile „+ Lisa“; ✕ takes a picture out at once with „Pilt eemaldatud.“, whose undo puts it back", async () => {
    await show();
    const c = card("galerii")!;
    expect(text(c.querySelector("[data-gallery-count]"))).toBe("Lohista järjekorra muutmiseks · 3 / 24");
    expect(tiles()).toEqual(["/seed/a.jpg", "/seed/b.jpg", "/seed/c.jpg"]);
    // the tile's words „+ Lisa“; the field it opens is named „Lisa pilte“ for a screen reader (S4-15 note)
    const add = c.querySelector<HTMLInputElement>('[data-gallery-add] input[type="file"]')!;
    expect(labelOf(add)).toBe("+ Lisa");
    expect(add.getAttribute("aria-label")).toBe("Lisa pilte");
    expect(add.multiple).toBe(true);
    // each tile's description stays (builder notes §5): the course gallery's field and words, as its hidden name and its placeholder
    const describe = (n: number) => field(`works.${n}.alt`)!;
    expect(WORKS.works.map((_, n) => describe(n).value)).toEqual(["Esimene", "Teine", "Kolmas"]);
    expect(labelOf(describe(1))).toBe("Pildi kirjeldus (eesti keeles)");
    expect(describe(1).getAttribute("placeholder")).toBe("Pildi kirjeldus");
    expect(describe(1).closest("[data-gallery-item]")!.getAttribute("data-gallery-item")).toBe("/seed/b.jpg");
    await click(button("Eemalda pilt 2", c));
    expect(tiles()).toEqual(["/seed/a.jpg", "/seed/c.jpg"]);
    expect(remote.log.at(-1)).toEqual({ part: "works", version: "l:works", patch: { works: [WORKS.works[0], WORKS.works[2]] } });
    expect(text(undoBar()!.querySelector("p"))).toBe("Pilt eemaldatud.");
    expect(text(c.querySelector("[data-gallery-count]"))).toBe("Lohista järjekorra muutmiseks · 2 / 24");
    expect(barWords()).toBe(draft("Galerii"));
    await click(undoBar()!.querySelector("button"));
    expect(tiles()).toEqual(["/seed/a.jpg", "/seed/b.jpg", "/seed/c.jpg"]);
    expect(remote.log.at(-1)!.patch).toEqual({ works: WORKS.works });
    expect($("[data-publish-bar]")).toBeNull();
  });

  it("„Galerii“: a picture's description typed under its tile is saved when it is left, „Galerii“ on the bar", async () => {
    await show();
    await type(field("works.0.alt"), "Kulmukoolituse tunnistus");
    await leave(field("works.0.alt"));
    expect(remote.log.at(-1)).toEqual({
      part: "works",
      version: "l:works",
      patch: { works: [{ key: "/seed/a.jpg", alt: { et: "Kulmukoolituse tunnistus", ru: "Первый" } }, WORKS.works[1], WORKS.works[2]] },
    });
    expect(barWords()).toBe(draft("Galerii"));
    expect(text($$("nav[aria-label='Jaotised'] a")[2].querySelector("[data-section-status]"))).toBe("3");
  });

  it("„Galerii“: a description with its Estonian side only flags the map's entry „RU puudub“", async () => {
    await show(partsOf({ works: { works: [WORKS.works[0], { key: "/seed/b.jpg", alt: { et: "Teine" } }] } }));
    expect(text($$("nav[aria-label='Jaotised'] a")[2].querySelector("[data-section-status]"))).toBe("2 · RU puudub");
  });

  it("„Galerii“: a picture's refused description is said at its own tile (aria-invalid, the words under it), not under the grid", async () => {
    remote.refuse = (part, patch) => (part === "works" && "works" in patch ? { "works.1.alt": "tooLong", works: "tooLong" } : null);
    await show();
    // (the field's maxLength stops a typist at 200; the server's limit is the same)
    await type(field("works.1.alt"), "x".repeat(201));
    await leave(field("works.1.alt"));
    expect(remote.log.at(-1)!.part).toBe("works");
    const second = field("works.1.alt")!;
    expect(second.getAttribute("aria-invalid")).toBe("true");
    const words = container.querySelector(`#${CSS.escape(second.getAttribute("aria-describedby")!.split(" ").at(-1)!)}`);
    expect(text(words)).not.toBe("");
    expect(words!.closest("[data-gallery-item]")!.getAttribute("data-gallery-item")).toBe("/seed/b.jpg");
    expect(field("works.0.alt")!.getAttribute("aria-invalid")).toBeNull();
    // said once, at the tile: not again on the grid's own line (a refusal of the list as a whole)
    expect(Array.from(card("galerii")!.querySelectorAll("p")).filter((p) => text(p) === text(words))).toHaveLength(1);
  });

  it("„Galerii“: a tile moved with its arrow is saved at once, „Galerii“ on the bar", async () => {
    await show();
    await click(card("galerii")!.querySelector('[data-gallery-item="/seed/c.jpg"] [data-drag-tool="up"]'));
    expect(tiles()).toEqual(["/seed/a.jpg", "/seed/c.jpg", "/seed/b.jpg"]);
    expect(remote.log.at(-1)).toEqual({ part: "works", version: "l:works", patch: { works: [WORKS.works[0], WORKS.works[2], WORKS.works[1]] } });
    expect(barWords()).toBe(draft("Galerii"));
  });
});

describe("the stories fold while empty (S4-16)", () => {
  it("an empty story is one row „tühi“ + „Lisa tekst“; the button opens it with the cursor in its title; a story with text is open", async () => {
    await show();
    const journey = card("teekond")!;
    expect(journey.querySelector("input, textarea")).toBeNull();
    expect(text(journey.querySelector("h2"))).toBe("Koolitaja teekond");
    expect(text(journey.querySelector("[data-story-fold]"))).toBe("tühi · Lisa tekst ▸");
    const open = button("Lisa tekst", journey);
    expect(open).not.toBeNull();
    // the story with text: its title and text
    expect(field("center_story.title")!.value).toBe(CENTER.title.et);
    expect(field("center_story.body")!.value).toBe(CENTER.body.et);
    await click(open);
    expect(document.activeElement).toBe(field("trainer_journey.title"));
    expect(field("trainer_journey.body")).not.toBeNull();
    expect(button("Lisa tekst", journey)).toBeNull();
    // typed in: its draft, the bar names the story
    await type(field("trainer_journey.title"), "Minu teekond");
    await leave(field("trainer_journey.title"));
    expect(remote.log.at(-1)).toEqual({ part: "trainer_journey", version: "l:trainer_journey", patch: { title: { et: "Minu teekond" } } });
    expect(barWords()).toBe(draft("Koolitaja teekond"));
  });

  it("both stories empty: both fold, and the map says „tühi“ for each", async () => {
    await show(partsOf({ center_story: EMPTY }));
    expect(card("lugu")!.querySelector("input, textarea")).toBeNull();
    expect(card("teekond")!.querySelector("input, textarea")).toBeNull();
    const status = $$("nav[aria-label='Jaotised'] a").map((a) => text(a.querySelector("[data-section-status]")));
    expect(status.slice(3)).toEqual(["tühi", "tühi"]);
  });
});
