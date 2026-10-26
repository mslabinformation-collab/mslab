// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PracticeEditor } from "@/components/admin/PracticeEditor";
import { UndoProvider } from "@/components/admin/UndoBar";
import type { PackageDraft } from "@/domain/site-editor";
import type { SitePartState } from "@/domain/site-entities";
import { stubFetch } from "../fakes";

// C5 Praktika on the draft layer (admin UX pass piece 4a, Task 4; README §4 C5 "the template; points get drag + undo", the Part 4 C5 frame; piece4-texts
// S4-31…S4-34, S4-3; ruling R-h): the site editors' page (site/SiteEditorPage.tsx) with one card per package, MINI and MAXI side by side — „Nimi“,
// „Lühitekst“, the row of three short fields „Hind (€)“, „Modelle“, „Kestus“, then the points „Sisaldab“ (drag, ↑ / ↓, × with „Rida eemaldatud.“
// and its undo, Enter on the last row adds a point). Every field autosaves into its package's draft (POST /api/admin/sisu/practice/0/osa/<code>),
// and ONE bar publishes both packages.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/praktika",
  useSearchParams: () => new URLSearchParams(),
}));

const pkg = (code: string, price: string, models: string, duration: string, items: string[]): PackageDraft => ({
  name: { et: code },
  tagline: { et: `${code} lühitekst` },
  models,
  durationLabel: { et: duration },
  price,
  items: items.map((et) => ({ et })),
});
const MINI = pkg("MINI", "120", "2", "1 päev", ["2 modelli koos Mariaga", "Tagasiside protokolliga", "Töövahendid kohapeal"]);
const MAXI = pkg("MAXI", "210", "4", "2 päeva", ["4 modelli koos Mariaga", "Tagasiside protokolliga", "Fotod portfoolio jaoks"]);
const LIVE: Record<string, PackageDraft> = { MINI, MAXI };

/** The parts as the page reads them (server/site-drafts.ts readSiteEditor): live, no drafts. */
const partsOf = (codes = ["MINI", "MAXI"]): Record<string, SitePartState> =>
  Object.fromEntries(codes.map((code) => [code, { version: `l:${code}`, value: LIVE[code], live: LIVE[code] }]));

/** The routes: each package's stored value and version; a save is a draft; `refuse` answers a field's code; `log` the saves in order. */
const remote = {
  parts: {} as Record<string, { version: string; value: Record<string, unknown> }>,
  n: 0,
  refuse: null as null | ((patch: Record<string, unknown>) => Record<string, string> | null),
  log: [] as { part: string; version: string; patch: Record<string, unknown> }[],
};
function resetRemote() {
  remote.parts = Object.fromEntries(Object.entries(LIVE).map(([code, value]) => [code, { version: `l:${code}`, value: { ...value } }]));
  remote.n = 0;
  remote.refuse = null;
  remote.log = [];
}
const respond = (url: string, init: RequestInit | undefined): Response => {
  const press = url.match(/^\/api\/admin\/sisu\/practice\/0\/(avalda|loobu)$/);
  if (press) return Response.json(press[1] === "avalda" ? { stamp: 5, published: Object.keys(LIVE), blocked: [] } : { stamp: 5 });
  const m = url.match(/^\/api\/admin\/sisu\/practice\/0\/osa\/(\w+)$/);
  if (!m) return Response.json({ ok: false }, { status: 404 });
  const part = m[1];
  const body = JSON.parse(String(init?.body)) as { version: string; patch: Record<string, unknown> };
  remote.log.push({ part, ...body });
  const refused = remote.refuse?.(body.patch);
  if (refused) return Response.json({ ok: false, error: "invalid", fields: refused }, { status: 400 });
  const stored = remote.parts[part];
  if (body.version !== stored.version) return Response.json({ ok: false, error: "conflict", version: stored.version, value: stored.value }, { status: 409 });
  remote.n += 1;
  stored.value = { ...stored.value, ...body.patch };
  stored.version = `d:${part === "MINI" ? 1 : 2}.${remote.n}`;
  return Response.json({ ok: true, version: stored.version, savedAt: "2026-10-26T11:15:00.000Z" });
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
  await act(async () => root.render(createElement(UndoProvider, null, createElement(PracticeEditor, { parts, stamp: 1 }))));
  await settle();
};
const type = async (el: Element | null, value: string) => {
  expect(el, "the field to type in").not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
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
const enter = async (el: Element | null) => {
  expect(el, "the field to press Enter in").not.toBeNull();
  await act(async () => void el!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await settle();
};
const card = (code: string) => $(`[data-package="${code}"]`);
/** A package's field by its name (`MAXI.price`, `MAXI.items.2`): a one-language field's data-field, a two-language field's data-i18n. */
const field = (name: string) => $<HTMLInputElement>(`[data-field="${name}"], [data-i18n="${name}"]`);
const labelOf = (el: Element | null) => text(container.querySelector(`label[for="${el?.id}"]`));
const points = (code: string) => $$<HTMLInputElement>(`[data-list-editor="${code}.items"] [data-drag-row] [data-lang-field]`).map((el) => el.value);
const button = (name: string, within: Element | null = container) => Array.from(within?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((b) => text(b) === name || b.getAttribute("aria-label") === name) ?? null;
const undoBar = () => document.querySelector<HTMLElement>("[data-undo-bar]");
const posts = () => fetched.calls.filter((c) => c.method === "POST").map((c) => c.url.replace("/api/admin/sisu/practice/0/", ""));

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

describe("the page (S4-31, S4-32) and the two package cards (the P4 C5 frame, S4-33)", () => {
  it("eyebrow „Koolitused“, H1 „Praktikapaketid“, the lead S4-32; „Vaata lehel ↗“ opens /praktika; no bar while nothing waits", async () => {
    await show();
    expect(text($("[data-site-eyebrow]"))).toBe("Koolitused");
    expect(text($("h1"))).toBe("Praktikapaketid");
    expect(text($("[data-site-lead]"))).toBe(
      "MINI ja MAXI pakett: nimi, lühitekst, modellide arv, kestus, hind ja punktid. Avaldades uuenevad praktikaleht ja avalehe praktikaplokk.",
    );
    expect($("[data-site-view]")!.getAttribute("href")).toBe("/praktika");
    expect($("[data-publish-bar]")).toBeNull();
    // the old page-wide „Salvesta“ is gone
    expect($("[data-save-bar]")).toBeNull();
    expect(button("Salvesta")).toBeNull();
  });

  it("MINI and MAXI, each titled by its code: „Nimi“, „Lühitekst“, then the row of three short fields, then „Sisaldab“ with its points and S4-33's add button", async () => {
    await show();
    expect($$("[data-package]").map((el) => el.getAttribute("data-package"))).toEqual(["MINI", "MAXI"]);
    for (const code of ["MINI", "MAXI"]) {
      const c = card(code)!;
      expect(text(c.querySelector("h2"))).toBe(code);
      expect(c.getAttribute("aria-labelledby")).toBe(c.querySelector("h2")!.id);
      const labels = $$<HTMLLabelElement>(`[data-package="${code}"] label`)
        .filter((l) => !l.closest("[data-drag-row]"))
        .map((l) => text(l));
      expect(labels).toEqual(["Nimi (eesti keeles)", "Lühitekst (eesti keeles)", "Hind (€)", "Modelle", "Kestus (eesti keeles)"]);
      // the three short fields share one row
      const row = c.querySelector("[data-package-short]")!;
      expect(Array.from(row.children).map((f) => text(f.querySelector("label")))).toEqual(["Hind (€)", "Modelle", "Kestus (eesti keeles)"]);
      expect(field(`${code}.price`)!.closest("[data-package-short]")).toBe(row);
      expect(field(`${code}.models`)!.closest("[data-package-short]")).toBe(row);
      expect(field(`${code}.durationLabel`)!.closest("[data-package-short]")).toBe(row);
      // the hints stay (builder notes §5)
      expect(text(c)).toContain("Mitmel modellil praktika toimub.");
      expect(text(c)).toContain("nt 8 ak. Kaardil: „≈ 8 ak“.");
      expect(text(c)).toContain("Iga rida on üks punkt paketi kaardil.");
      const list = c.querySelector(`[data-list-editor="${code}.items"]`)!;
      expect(text(list.querySelector("h3"))).toBe("Sisaldab");
      expect(button("+ Lisa punkt (või Enter viimasel real)", list)).not.toBeNull();
      expect(points(code)).toEqual(LIVE[code].items.map((i) => i.et));
      // each point's field is named by its row (the leave guard's „Jää siia“, SaveStatus's „Näita“)
      expect(labelOf(field(`${code}.items.1`))).toBe("Punkt 2 (eesti keeles)");
    }
    expect(field("MAXI.price")!.value).toBe("210");
    expect(field("MAXI.models")!.value).toBe("4");
    expect(field("MAXI.durationLabel")!.value).toBe("2 päeva");
  });

  it("no packages in the table: „Praktikapakette pole.“", async () => {
    await show({});
    expect(text($("[data-site-editor]"))).toContain("Praktikapakette pole.");
    expect($("[data-package]")).toBeNull();
  });
});

describe("the fields autosave into the package's draft; one bar for both packages (S4-34)", () => {
  it("a price typed and left: MAXI's draft gets it, the bar says „MAXI hind“, the field is marked „· avaldamata“ (the frame's #9e8993 border)", async () => {
    await show();
    await type(field("MAXI.price"), "230");
    await leave(field("MAXI.price"));
    expect(remote.log).toEqual([{ part: "MAXI", version: "l:MAXI", patch: { price: "230" } }]);
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 1 · MAXI hind. Avalikul lehel on näha eelmine versioon.");
    expect(text($("[data-save-status] [role=status]"))).toBe("Mustand salvestatud 13:15");
    // the changed field waits for „Avalda muudatused“: its box is marked (editor.module.css: the border in --rose, #9e8993), MINI's is not
    const box = (name: string) => field(name)!.closest("[data-unpublished], [data-plain-field], [data-i18n-box]")!;
    expect(box("MAXI.price").hasAttribute("data-unpublished")).toBe(true);
    expect(text(box("MAXI.price").querySelector("[data-unpublished-tag]"))).toBe("· avaldamata");
    expect(box("MINI.price").hasAttribute("data-unpublished")).toBe(false);
    expect(box("MAXI.models").hasAttribute("data-unpublished")).toBe(false);
  });

  it("MINI and MAXI changed: one bar names both, and its one „Avalda muudatused“ publishes them together", async () => {
    await show();
    await type(field("MINI.price"), "125");
    await leave(field("MINI.price"));
    await type(field("MAXI.models"), "5");
    await leave(field("MAXI.models"));
    expect($$("[data-publish-bar]")).toHaveLength(1);
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 2 · MINI hind, MAXI modelle. Avalikul lehel on näha eelmine versioon.");
    await click($("[data-publish-go]"));
    expect(posts().filter((p) => p === "avalda")).toHaveLength(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("each short field is checked on its own: a price the check refuses is held at its field with its words, the models beside it are saved", async () => {
    remote.refuse = (patch) => ("price" in patch && patch.price === "12,3,4" ? { price: "amount" } : null);
    await show();
    await type(field("MAXI.price"), "12,3,4");
    await type(field("MAXI.models"), "6");
    await leave(field("MAXI.models"));
    const price = field("MAXI.price")!;
    expect(price.getAttribute("aria-invalid")).toBe("true");
    const error = container.querySelector(`#${CSS.escape(price.getAttribute("aria-describedby")!.split(" ").at(-1)!)}`);
    expect(text(error)).not.toBe("");
    expect(field("MAXI.models")!.getAttribute("aria-invalid")).toBeNull();
    // the models went through on their own (the engine held only the price back)
    expect(remote.parts.MAXI.value.models).toBe("6");
    expect(remote.parts.MAXI.value.price).toBe("210");
  });
});

describe("„Sisaldab“: the points (README C5 „points get drag + undo“; R-h)", () => {
  it("Enter in the last point adds an empty point after it and puts the cursor in it; the list saves at once; Enter in another point adds nothing", async () => {
    await show();
    await enter(field("MAXI.items.0"));
    expect(points("MAXI")).toHaveLength(3);
    expect(remote.log).toEqual([]);
    field("MAXI.items.2")!.focus();
    await enter(field("MAXI.items.2"));
    expect(points("MAXI")).toEqual([...MAXI.items.map((i) => i.et), ""]);
    expect(document.activeElement).toBe(field("MAXI.items.3"));
    expect(remote.log).toEqual([{ part: "MAXI", version: "l:MAXI", patch: { items: [...MAXI.items, { et: "" }] } }]);
    // the new point typed in: „MAXI punktid“ on the bar (a row added, S4-1)
    await type(field("MAXI.items.3"), "Järelkonsultatsioon 30 min");
    await leave(field("MAXI.items.3"));
    expect(remote.log.at(-1)!.patch).toEqual({ items: [...MAXI.items, { et: "Järelkonsultatsioon 30 min" }] });
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 1 · MAXI punktid. Avalikul lehel on näha eelmine versioon.");
    // MINI's list is its own
    expect(points("MINI")).toEqual(MINI.items.map((i) => i.et));
  });

  it("× takes a point out at once with the UndoBar „Rida eemaldatud.“; „Võta tagasi“ puts it back at its place; each change saved", async () => {
    await show();
    await click(button("Eemalda rida 2", $('[data-list-editor="MINI.items"]')));
    expect(points("MINI")).toEqual(["2 modelli koos Mariaga", "Töövahendid kohapeal"]);
    expect(remote.log.at(-1)).toMatchObject({ part: "MINI", patch: { items: [{ et: "2 modelli koos Mariaga" }, { et: "Töövahendid kohapeal" }] } });
    expect(text(undoBar()!.querySelector("p"))).toBe("Rida eemaldatud.");
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 1 · MINI punktid. Avalikul lehel on näha eelmine versioon.");
    await click(undoBar()!.querySelector("button"));
    expect(points("MINI")).toEqual(MINI.items.map((i) => i.et));
    expect(remote.log.at(-1)).toMatchObject({ part: "MINI", patch: { items: MINI.items } });
    // back as live: nothing waits
    expect($("[data-publish-bar]")).toBeNull();
  });

  it("↑ moves a point at once (saved); the handle „⋮⋮“ is there for a drag", async () => {
    await show();
    const list = $('[data-list-editor="MAXI.items"]')!;
    expect(list.querySelectorAll('[data-drag-tool="handle"]')).toHaveLength(3);
    await click(list.querySelector('[data-row="1"] [data-drag-tool="up"]'));
    expect(points("MAXI")).toEqual(["Tagasiside protokolliga", "4 modelli koos Mariaga", "Fotod portfoolio jaoks"]);
    expect(remote.log.at(-1)).toMatchObject({ part: "MAXI" });
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 1 · MAXI punktid. Avalikul lehel on näha eelmine versioon.");
  });
});
