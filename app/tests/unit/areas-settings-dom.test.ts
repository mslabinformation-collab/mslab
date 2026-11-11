// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEBOUNCE_MS } from "@/components/admin/autosave/constants";
import type { AdminArea } from "@/server/course-areas";
import { stubFetch } from "../fakes";

// Seaded → „Valdkonnad“ (course areas, spec 2026-11-11-course-areas-filter-design.md §4.1; components/admin/AreasSettings.tsx) in a browser-like
// document (happy-dom): one row per area — „Nimi (eesti keeles)“, „Nimi (vene keeles)“, the handle and ↑ ↓, „Kustuta“ or, for an area courses use,
// „Seda valdkonda kasutab {n} koolitust.“ in its place — and „Lisa valdkond“ below. A row's names autosave on api/admin/valdkond/<id> from its
// version, held back in the browser while a name is empty or too long; the adds, moves and deletes are presses whose answer is the list.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/admin/seaded", useSearchParams: () => new URLSearchParams() }));

import { AreasSettings } from "@/components/admin/AreasSettings";

const area = (id: number, et: string, ru: string, used = 0): AdminArea => ({ id, name: { et, ru }, version: `v${id}`, used });
const KULM = area(1, "Kulmukoolitused", "Курсы по бровям", 2);
const RIPS = area(2, "Ripsmekoolitused", "Курсы по ресницам");

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
let answer: (url: string, body: unknown) => Response | null;
const statuses: [string, string][] = [];
const onStatus = (part: string, status: { kind: string }) => void statuses.push([part, status.kind]);

const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => Array.from(container.querySelectorAll<E>(selector));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const show = async (areas: AdminArea[] = [KULM, RIPS]) => {
  await act(async () => root.render(createElement(AreasSettings, { initial: areas, onStatus })));
  await settle();
};
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());
const field = (id: number, lang: "et" | "ru") => $<HTMLInputElement>(`[data-field="area-${id}.${lang}"]`)!;
const rowNames = () => $$("[data-area]").map((r) => r.querySelector<HTMLInputElement>('[data-field$=".et"]')!.value);

beforeEach(() => {
  for (const fn of Object.values(router)) fn.mockReset();
  statuses.length = 0;
  answer = () => null;
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  fetched = stubFetch(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const own = answer(url, body);
    if (own) return own;
    const version = (body as { version?: string } | null)?.version;
    return Response.json({ ok: true, version: `${version}+`, savedAt: "2026-11-11T08:20:00.000Z" });
  });
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

describe("the card", () => {
  test("its title and lead; a row per area with both names, the handle and ↑ ↓; „Kustuta“ only where no course uses it; „Lisa valdkond“ below", async () => {
    await show();
    const card = $("[data-areas-card]")!;
    expect(text(card.querySelector("h2"))).toBe("Valdkonnad");
    expect(text(card)).toContain("Valdkonnad, mille järgi õpilane saab koolituskalendris ja koolituste lehel koolitusi valida. Koolituse valdkonna valid koolituse kaardil „Põhiinfo“.");
    expect(rowNames()).toEqual(["Kulmukoolitused", "Ripsmekoolitused"]);
    expect(field(2, "ru").value).toBe("Курсы по ресницам");
    const labels = Array.from($('[data-area="1"]')!.querySelectorAll("label")).map(text);
    expect(labels).toEqual(["Nimi (eesti keeles)", "Nimi (vene keeles)"]);
    expect($('[data-area="1"] [data-drag-tool="handle"]')).not.toBeNull();
    expect($('[data-area="1"] [data-drag-tool="down"]')!.getAttribute("aria-label")).toContain("Kulmukoolitused");
    expect($('[data-area="1"] [data-area-delete]')).toBeNull();
    expect(text($('[data-area="1"] [data-area-used]'))).toBe("Seda valdkonda kasutab 2 koolitust.");
    expect(text($('[data-area="2"] [data-area-delete]'))).toBe("Kustuta");
    expect(text($("[data-area-add] button[type=submit]"))).toBe("Lisa valdkond");
  });

  test("one course: „Seda valdkonda kasutab 1 koolitus.“; no areas at all: „Valdkondi veel pole.“ and the add form", async () => {
    await show([area(1, "Kulmukoolitused", "Брови", 1)]);
    expect(text($('[data-area="1"] [data-area-used]'))).toBe("Seda valdkonda kasutab 1 koolitus.");
    await act(async () => root.render(createElement(AreasSettings, { key: "none", initial: [], onStatus })));
    expect(text($("[data-areas-card]"))).toContain("Valdkondi veel pole.");
    expect($("[data-area-add]")).not.toBeNull();
  });
});

describe("a row's names autosave", () => {
  test("on api/admin/valdkond/<id> from the row's version, after the typing; the page's chip hears of it as the row's part", async () => {
    await show();
    await type(field(1, "et"), "Kulmud");
    await wait(DEBOUNCE_MS + 100);
    await settle();
    expect(fetched.calls.map((c) => [c.url, c.body])).toEqual([["/api/admin/valdkond/1", { version: "v1", patch: { et: "Kulmud" } }]]);
    expect(statuses).toContainEqual(["area-1", "dirty"]);
    expect(statuses.at(-1)).toEqual(["area-1", "saved"]);
  });

  test("an empty name is held back in the browser and said in the field; one the route refuses (another area's name) in its words", async () => {
    await show();
    await type(field(2, "ru"), "  ");
    await wait(DEBOUNCE_MS + 100);
    await settle();
    expect(fetched.calls).toEqual([]);
    expect(field(2, "ru").getAttribute("aria-invalid")).toBe("true");
    expect(text($('[data-area="2"]'))).toContain("Kirjuta nimi.");
    answer = (url) => (url === "/api/admin/valdkond/1" ? Response.json({ ok: false, error: "invalid", fields: { et: "taken" } }, { status: 400 }) : null);
    await type(field(1, "et"), "Ripsmekoolitused");
    await wait(DEBOUNCE_MS + 100);
    await settle();
    expect(text($('[data-area="1"]'))).toContain("Sellise nimega valdkond on juba olemas.");
  });
});

describe("the presses", () => {
  test("„Lisa valdkond“: both names to api/admin/valdkond/uus; the answer's list on screen, the form empty again", async () => {
    answer = (url) => (url === "/api/admin/valdkond/uus" ? Response.json({ ok: true, id: 3, areas: [KULM, RIPS, area(3, "Meik", "Макияж")] }) : null);
    await show();
    await type($<HTMLInputElement>('[data-field="area-new.et"]')!, "Meik");
    await type($<HTMLInputElement>('[data-field="area-new.ru"]')!, "Макияж");
    await click($("[data-area-add] button[type=submit]"));
    await settle();
    expect(fetched.calls.map((c) => [c.url, c.body])).toEqual([["/api/admin/valdkond/uus", { et: "Meik", ru: "Макияж" }]]);
    expect(rowNames()).toEqual(["Kulmukoolitused", "Ripsmekoolitused", "Meik"]);
    expect($<HTMLInputElement>('[data-field="area-new.et"]')!.value).toBe("");
    expect(text($('[data-area="3"] [data-area-delete]'))).toBe("Kustuta");
  });

  test("„Lisa valdkond“ refused: the route's words at the field, the names stay", async () => {
    answer = (url) => (url === "/api/admin/valdkond/uus" ? Response.json({ ok: false, error: "invalid", fields: { et: "taken" } }, { status: 400 }) : null);
    await show();
    await type($<HTMLInputElement>('[data-field="area-new.et"]')!, "kulmukoolitused");
    await type($<HTMLInputElement>('[data-field="area-new.ru"]')!, "Брови");
    await click($("[data-area-add] button[type=submit]"));
    await settle();
    expect(text($("[data-area-add]"))).toContain("Sellise nimega valdkond on juba olemas.");
    expect($<HTMLInputElement>('[data-field="area-new.et"]')!.value).toBe("kulmukoolitused");
    expect(rowNames()).toEqual(["Kulmukoolitused", "Ripsmekoolitused"]);
  });

  test("↓: the move to api/admin/valdkond/<id>/liiguta with the place; the order at once, then the answer's", async () => {
    answer = (url) => (url === "/api/admin/valdkond/1/liiguta" ? Response.json({ ok: true, areas: [RIPS, KULM] }) : null);
    await show();
    await click($('[data-area="1"] [data-drag-tool="down"]'));
    await settle();
    expect(fetched.calls.map((c) => [c.url, c.body])).toEqual([["/api/admin/valdkond/1/liiguta", { index: 1 }]]);
    expect(rowNames()).toEqual(["Ripsmekoolitused", "Kulmukoolitused"]);
  });

  test("a move refused: the order goes back, the line under the row", async () => {
    answer = (url) => (url.endsWith("/liiguta") ? Response.json({ ok: false, error: "server" }, { status: 500 }) : null);
    await show();
    await click($('[data-area="1"] [data-drag-tool="down"]'));
    await settle();
    expect(rowNames()).toEqual(["Kulmukoolitused", "Ripsmekoolitused"]);
    expect(text($('[data-area="1"] [data-area-error]'))).toBe("Järjekorra muutmine ei õnnestunud. Proovi uuesti.");
  });

  test("„Kustuta“ asks with the name; yes: api/admin/valdkond/<id>/kustuta and the row is gone; „Katkesta“ asks nothing more", async () => {
    answer = (url) => (url === "/api/admin/valdkond/2/kustuta" ? Response.json({ ok: true, areas: [KULM] }) : null);
    await show();
    await click($('[data-area="2"] [data-area-delete]'));
    expect(text($('[data-area="2"]'))).toContain("Kas kustutan valdkonna „Ripsmekoolitused“?");
    const cancel = Array.from($('[data-area="2"]')!.querySelectorAll("button")).find((b) => text(b) === "Katkesta")!;
    await click(cancel);
    expect(fetched.calls).toEqual([]);
    await click($('[data-area="2"] [data-area-delete]'));
    const yes = Array.from($('[data-area="2"]')!.querySelectorAll("button")).find((b) => text(b) === "Jah, kustuta")!;
    await click(yes);
    await settle();
    expect(fetched.calls.map((c) => c.url)).toEqual(["/api/admin/valdkond/2/kustuta"]);
    expect(rowNames()).toEqual(["Kulmukoolitused"]);
  });

  test("„Kustuta“ of an area a course took meanwhile: the row stays and says how many use it", async () => {
    answer = (url) => (url === "/api/admin/valdkond/2/kustuta" ? Response.json({ ok: false, error: "inUse", used: 1, areas: [KULM, { ...RIPS, used: 1 }] }, { status: 409 }) : null);
    await show();
    await click($('[data-area="2"] [data-area-delete]'));
    await click(Array.from($('[data-area="2"]')!.querySelectorAll("button")).find((b) => text(b) === "Jah, kustuta")!);
    await settle();
    expect(rowNames()).toEqual(["Kulmukoolitused", "Ripsmekoolitused"]);
    expect(text($('[data-area="2"] [data-area-used]'))).toBe("Seda valdkonda kasutab 1 koolitus.");
    expect($('[data-area="2"] [data-area-delete]')).toBeNull();
  });
});
