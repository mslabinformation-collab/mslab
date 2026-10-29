// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TestPlan } from "@/components/admin/TestPlan";
import { TestplanCard } from "@/components/admin/TestplanCard";
import { OUTBOX_KEY } from "@/components/admin/testplan-outbox";
import { NOTE_MAX, type TestItem, type TestPlan as Plan } from "@/domain/testplan";
import type { PageAnswer } from "@/server/testplan";

// The test page in a browser-like document (happy-dom), with the API answered here. Phase 4, piece 1, Task 3 built it; admin UX pass piece 4c
// (C7, README §4; P4 frame; S4-42…S4-46; R-i) redrew it: the header (eyebrow, H1, the line „{n} kontrolli · {k} läbitud · {v} viga“, one SaveStatus,
// „Värskenda“), one filter row of two labelled groups („Olek“ with counts, „Kes“: Mina / Kõik / Automaattest), area cards with their progress that
// fold together with their notes, check rows with „Sammud ▸“ and the two answers „Läbitud“ | „Viga“, the note box under every answer (Dim 22.10),
// and the empty selection. And the Avaleht card.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const item = (id: string, area: string, who: TestItem["who"], extra: Partial<TestItem> = {}): TestItem => ({
  id, area, who, device: "any", title: `Kontroll ${id}`, steps: ["Tee seda.", "Tee ka teist."], expect: ["Näed seda.", "Näed ka teist."], why: "Sest nii on vaja.", risk: "med", writes: false, ...extra,
});
const PLAN: Plan = {
  version: 1,
  marked: "2026-10-01T00:00:00.000Z",
  areas: [
    { id: "enne", name: "Enne alustamist", note: "Logi sisse samas seadmes.", checks: false },
    { id: "a0", name: "Tehtud" },
    { id: "a1", name: "Pooleli", note: "Siin on mõned avatud." },
    { id: "a2", name: "Uus osa" },
  ],
  items: [
    item("a0-done", "a0", "maria", { device: "telefon", href: "/koolitused" }),
    item("a1-redo", "a1", "dim", { mark: "redo", markedAt: "2026-10-15T09:00:00.000Z" }),
    item("a1-fail", "a1", "koos", { writes: true, device: "arvuti" }),
    item("a1-plain", "a1", "maria"),
    item("a2-fresh", "a2", "maria", { mark: "new" }),
    item("a2-dim", "a2", "dim", { mark: "reworded", device: "tahvel" }),
  ],
};
const BUILD_AT = "2026-10-16T08:00:00.000Z";
const answer = (status: PageAnswer["status"], at: string, byName = "Maria", note = ""): PageAnswer => ({ status, note, at, byName });
const SERVER: Record<string, PageAnswer> = {
  "a0-done": answer("ok", "2026-10-16T10:00:00.000Z"),
  "a1-redo": answer("ok", "2026-10-14T09:00:00.000Z", "Dim"), // before its redo's instant: open, the old answer under it
  "a1-fail": answer("bad", "2026-10-16T11:05:00.000Z", "Dim", "Nupp ei tööta"),
};
const MARIA = { name: "Maria", tester: "maria" as const };
const DIM = { name: "Dim", tester: "dim" as const };

let container: HTMLDivElement;
let root: Root;
/** What the API holds, and what it was asked. */
let server: Record<string, PageAnswer> | null;
/** Automaattest's answers as the API gives them, apart (Dim 25.10). */
let autoServer: Record<string, PageAnswer>;
let getReply: () => Response | Promise<Response>;
let putReply: (body: { answers: Record<string, { status: PageAnswer["status"]; note: string }> }) => Promise<Response>;
const calls: { method: string; body?: { answers: Record<string, { status: PageAnswer["status"]; note: string }> } }[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unauthorized = () => json({ ok: false, error: "unauthorized" }, 401);
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => [...container.querySelectorAll<E>(selector)];
const check = (id: string) => $(`[data-check="${id}"]`)!;
const ids = () => $$("[data-check]").map((c) => c.getAttribute("data-check"));
const areas = () => $$("[data-area]").map((a) => a.getAttribute("data-area"));
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const typeInto = async (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const state = (id: string) => check(id).getAttribute("data-check-state");
const pressed = (id: string) => $$(`[data-check="${id}"] [data-answer][aria-pressed="true"]`).map((b) => b.getAttribute("data-answer"));
/** The SaveStatus chip: its kind (null: no chip) and the words it shows. */
const chip = () => $("[data-save-status]")?.getAttribute("data-save-kind") ?? null;
const chipText = () => $("[data-save-text]")?.textContent ?? "";
const line = () => $("[data-progress]")!.textContent;
const pills = (group: "olek" | "kes") => $$(`[data-filter-group="${group}"] button`).map((b) => b.textContent);
const olek = (f: "all" | "open" | "bad" | "done") => $(`[data-filter="${f}"]`)!;
const kes = (w: "mina" | "all" | "auto") => $(`[data-who="${w}"]`)!;

type Props = { initial?: Record<string, PageAnswer> | null; auto?: Record<string, PageAnswer>; you?: { name: string; tester: "maria" | "dim" | "auto" | null }; plan?: Plan };
const show = async ({ initial = SERVER, auto, you = MARIA, plan = PLAN }: Props = {}) => {
  server = initial === null ? null : { ...initial };
  autoServer = { ...(auto ?? {}) };
  await act(async () => root.render(createElement(TestPlan, { plan, initial, auto, you, buildAt: BUILD_AT })));
  await settle();
};
/** The view the device remembers (`who` is what the „Kes“ group shows). */
const remember = (view: { filter: string; who: string }) => localStorage.setItem("mslab-testplan-view", JSON.stringify(view));
const showAll = async (props: Props = {}) => {
  remember({ filter: "all", who: "all" });
  await show(props);
};
const openAll = async () => {
  for (const toggle of $$("[data-area-toggle]")) if (toggle.getAttribute("aria-expanded") === "false") await click(toggle);
};
const remount = async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
};

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
  server = { ...SERVER };
  autoServer = {};
  getReply = () =>
    server ? json({ ok: true, plan: PLAN, answers: server, auto: autoServer, you: MARIA }) : json({ ok: false, error: "unavailable", plan: PLAN, answers: null, you: MARIA }, 503);
  putReply = async (body) => {
    server = { ...(server ?? {}) };
    for (const [id, a] of Object.entries(body.answers)) server[id] = { status: a.status, note: a.note, at: "2026-10-16T12:00:00.000Z", byName: "Maria" };
    return json({ ok: true, answers: server });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body));
        calls.push({ method, body });
        return putReply(body);
      }
      calls.push({ method });
      return getReply();
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("the header (S4-42, S4-43)", () => {
  test("the eyebrow „Haldus“, the H1 „Testimine“ and the line under it, counted over the „Kes“ choice: „Mina“ by default, Maria's checks and the shared ones", async () => {
    await show();
    expect($("h1")!.textContent).toBe("Testimine");
    expect($("h1")!.previousElementSibling!.textContent).toBe("Haldus");
    // Maria: a0-done (done), a1-fail (koos, Viga), a1-plain, a2-fresh (open); Dim's two are not hers
    expect(line()).toBe("4 kontrolli · 1 läbitud · 1 viga");
    expect(kes("mina").getAttribute("aria-pressed")).toBe("true");
    await click(kes("all"));
    expect(line()).toBe("6 kontrolli · 1 läbitud · 1 viga");
  });

  test("one check is „1 kontroll“", async () => {
    const plan: Plan = { ...PLAN, areas: [{ id: "a", name: "Osa" }], items: [item("only", "a", "maria")] };
    server = {};
    await show({ plan, initial: {} });
    expect(line()).toBe("1 kontroll · 0 läbitud · 0 viga");
  });

  test("Dim's „Mina“ is his checks and the shared ones; an admin who is no tester (or Automaattest's own session) sees every check under „Mina“", async () => {
    await show({ you: DIM });
    expect(line()).toBe("3 kontrolli · 0 läbitud · 1 viga");
    await remount();
    await show({ you: { name: "Kati", tester: null } });
    expect(kes("mina").getAttribute("aria-pressed")).toBe("true");
    expect(line()).toBe("6 kontrolli · 1 läbitud · 1 viga");
  });

  test("no „Sina: …“ line (the sidebar names who is signed in), and „Värskenda“ is there", async () => {
    await show();
    expect($("[data-you]")).toBeNull();
    expect(container.textContent).not.toContain("Sina:");
    expect($("[data-refresh]")!.textContent).toBe("Värskenda");
  });
});

describe("one filter row: „Olek“ and „Kes“ (S4-44)", () => {
  test("two labelled groups; „Olek“ is Kõik / Avatud n / Viga n / Läbitud n, counted under „Mina“; „Kes“ is Mina / Kõik / Automaattest; no „Muudetud“", async () => {
    await show();
    const label = (group: string) => {
      const el = $(`[data-filter-group="${group}"]`)!;
      expect(el.getAttribute("role")).toBe("group");
      return container.querySelector(`[id="${el.getAttribute("aria-labelledby")}"]`)!.textContent;
    };
    expect([label("olek"), label("kes")]).toEqual(["Olek", "Kes"]);
    expect(pills("olek")).toEqual(["Kõik", "Avatud 2", "Viga 1", "Läbitud 1"]);
    expect(pills("kes")).toEqual(["Mina", "Kõik", "Automaattest"]);
    expect($('[data-filter="changed"]')).toBeNull();
    // the counts follow „Kes“
    await click(kes("all"));
    expect(pills("olek")).toEqual(["Kõik", "Avatud 4", "Viga 1", "Läbitud 1"]);
  });

  test("„Viga“ keeps the failed checks, „Avatud“ the open ones, „Läbitud“ the passed ones, „Kõik“ every one; every area with a match is open", async () => {
    await showAll();
    await click(olek("bad"));
    expect(olek("bad").getAttribute("aria-pressed")).toBe("true");
    expect(ids()).toEqual(["a1-fail"]);
    expect(areas()).toEqual(["a1"]); // (an area without a match, and the notes, are not shown)
    await click(olek("open"));
    expect(ids()).toEqual(["a1-redo", "a1-plain", "a2-fresh", "a2-dim"]);
    await click(olek("done"));
    expect(ids()).toEqual(["a0-done"]);
    await click(olek("all"));
    expect(areas()).toEqual(["enne", "a0", "a1", "a2"]);
  });

  test("„Mina“ hides a Dim check and keeps a Koos one; „Kõik“ shows them all", async () => {
    await showAll();
    await openAll();
    expect(ids()).toContain("a1-redo");
    await click(kes("mina"));
    await openAll();
    expect(ids()).not.toContain("a1-redo");
    expect(ids()).not.toContain("a2-dim");
    expect(ids()).toContain("a1-fail");
    await click(kes("all"));
    await openAll();
    expect(ids()).toEqual(["a0-done", "a1-redo", "a1-fail", "a1-plain", "a2-fresh", "a2-dim"]);
  });

  test("an empty selection says „Selle valikuga kontrolle pole.“ with no button, and shows no area; „Kõik“ brings them back", async () => {
    await show({ you: DIM }); // (Dim's checks: none passed)
    expect(pills("olek")).toEqual(["Kõik", "Avatud 2", "Viga 1", "Läbitud 0"]);
    await click(olek("done"));
    const empty = $("[data-list-empty]")!;
    expect(empty.textContent).toBe("Selle valikuga kontrolle pole.");
    expect(empty.querySelector("a, button")).toBeNull();
    expect(areas()).toEqual([]);
    await click(olek("all"));
    expect($("[data-list-empty]")).toBeNull();
    expect(areas()).toEqual(["enne", "a1", "a2"]); // (a0 holds only Maria's check)
  });

  test("„Automaattest“ with nothing answered by it is an empty selection too", async () => {
    await showAll();
    await click(kes("auto"));
    expect($("[data-list-empty]")!.textContent).toBe("Selle valikuga kontrolle pole.");
    expect(line()).toBe("0 kontrolli · 0 läbitud · 0 viga");
  });

  test("the choice is kept on the device: written to storage, and read by the next visit; an old choice („Muudetud“, „Maria“) is the default", async () => {
    await show();
    await click(olek("open"));
    await click(kes("all"));
    expect(JSON.parse(localStorage.getItem("mslab-testplan-view")!)).toEqual({ filter: "open", who: "all" });
    await remount();
    await show();
    expect(olek("open").getAttribute("aria-pressed")).toBe("true");
    expect(kes("all").getAttribute("aria-pressed")).toBe("true");
    remember({ filter: "changed", who: "maria" }); // (what the page before piece 4c kept)
    await remount();
    await show();
    expect(olek("all").getAttribute("aria-pressed")).toBe("true");
    expect(kes("mina").getAttribute("aria-pressed")).toBe("true");
    localStorage.setItem("mslab-testplan-view", "{not json");
    await remount();
    await show();
    expect(kes("mina").getAttribute("aria-pressed")).toBe("true"); // (rubbish: the defaults)
  });

  test("a storage that cannot be written still lets the filters work", async () => {
    await show();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await click(olek("bad"));
    expect(ids()).toEqual(["a1-fail"]);
    set.mockRestore();
  });
});

describe("the area cards", () => {
  test("the first area with an open check starts open, the others closed; each has its progress „{done} / {total}“ with a bar; a notes-only area is a plain card", async () => {
    await showAll();
    expect($$("[data-area-toggle]").map((t) => [t.closest("[data-area]")!.getAttribute("data-area"), t.getAttribute("aria-expanded")])).toEqual([
      ["a0", "false"], // (all its checks are done)
      ["a1", "true"],
      ["a2", "false"],
    ]);
    expect(ids()).toEqual(["a1-redo", "a1-fail", "a1-plain"]); // (a closed area shows no checks)
    expect($$("[data-area-count]").map((c) => c.textContent)).toEqual(["1 / 1", "0 / 3", "0 / 2"]);
    expect($$("[data-area-bar]").map((b) => (b as HTMLElement).style.width)).toEqual(["100%", "0%", "0%"]);
    const notes = $('[data-area="enne"]')!;
    expect(notes.querySelector("button")).toBeNull();
    expect(notes.textContent).toContain("Enne alustamist");
    expect(notes.textContent).toContain("Logi sisse samas seadmes.");
    await click($('[data-area="a2"] [data-area-toggle]')!);
    expect(ids()).toEqual(["a1-redo", "a1-fail", "a1-plain", "a2-fresh", "a2-dim"]);
  });

  test("an area folds together with its note", async () => {
    await showAll();
    const a1 = $('[data-area="a1"]')!;
    expect(a1.querySelector("[data-area-note]")!.textContent).toBe("Siin on mõned avatud.");
    await click(a1.querySelector("[data-area-toggle]")!);
    expect(a1.querySelector("[data-area-toggle]")!.getAttribute("aria-expanded")).toBe("false");
    expect(a1.querySelector("[data-area-note]")).toBeNull();
    expect(a1.textContent).not.toContain("Siin on mõned avatud.");
    expect(ids()).toEqual([]);
    await click(a1.querySelector("[data-area-toggle]")!);
    expect(a1.querySelector("[data-area-note]")!.textContent).toBe("Siin on mõned avatud.");
  });

  test("the progress counts the area's checks of the „Kes“ choice and moves with an answer", async () => {
    await show(); // (Maria's: a1-fail and a1-plain in a1)
    expect($('[data-area="a1"] [data-area-count]')!.textContent).toBe("0 / 2");
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect($('[data-area="a1"] [data-area-count]')!.textContent).toBe("1 / 2");
    expect(($('[data-area="a1"] [data-area-bar]') as HTMLElement).style.width).toBe("50%");
  });
});

describe("a check row (S4-45)", () => {
  test("the title, the who, device and „Loob andmeid“ chips, „Ava ↗“ in a new tab; no mark chips; the answers are „Läbitud“ | „Viga“, and no „Jäta vahele“", async () => {
    await showAll();
    await openAll();
    const fail = check("a1-fail");
    expect(fail.querySelector("h3")!.textContent).toBe("Kontroll a1-fail");
    expect([...fail.querySelectorAll("[data-chip]")].map((c) => c.textContent)).toEqual(["Koos", "Arvuti", "Loob andmeid"]);
    expect($$("[data-mark]")).toEqual([]);
    for (const word of ["Uuesti testida", "Sõnastus muutus"]) expect(container.textContent).not.toContain(word);
    expect(fail.querySelector("a[target]")).toBeNull(); // (no href: no „Ava“)
    const open = check("a0-done").querySelector<HTMLAnchorElement>("a[data-open]")!;
    expect(open.textContent).toContain("Ava ↗");
    expect([open.getAttribute("href"), open.getAttribute("target"), open.getAttribute("rel")]).toEqual(["/koolitused", "_blank", "noopener"]);
    expect([...fail.querySelectorAll("[data-answer]")].map((b) => [b.getAttribute("data-answer"), b.textContent])).toEqual([
      ["ok", "Läbitud"],
      ["bad", "Viga"],
    ]);
    expect($('[data-answer="skip"]')).toBeNull();
    expect(container.textContent).not.toContain("Jäta vahele");
    // the two answers are one group, named by the check's title
    const group = fail.querySelector("[data-answer]")!.parentElement!;
    expect(group.getAttribute("role")).toBe("group");
    expect(container.querySelector(`[id="${group.getAttribute("aria-labelledby")}"]`)!.textContent).toBe("Kontroll a1-fail");
  });

  test("„Sammud ▸“ folds the steps, „Mida näed“ and „Miks“ behind it", async () => {
    await showAll();
    const plain = check("a1-plain");
    const toggle = plain.querySelector<HTMLButtonElement>("[data-steps-toggle]")!;
    expect(toggle.textContent).toBe("Sammud ▸");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const fold = plain.querySelector<HTMLElement>("[data-steps]")!;
    expect(toggle.getAttribute("aria-controls")).toBe(fold.id);
    expect(fold.hidden).toBe(true);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(fold.hidden).toBe(false);
    expect([...fold.querySelectorAll("ol > li")].map((l) => l.textContent)).toEqual(["Tee seda.", "Tee ka teist."]);
    expect(fold.textContent).toContain("Mida näed");
    expect([...fold.querySelectorAll("ul > li")].map((l) => l.textContent)).toEqual(["Näed seda.", "Näed ka teist."]);
    expect(fold.textContent).toContain("Miks");
    expect(fold.textContent).toContain("Sest nii on vaja.");
    await click(toggle);
    expect(fold.hidden).toBe(true);
    expect(check("a1-fail").querySelector<HTMLElement>("[data-steps]")!.hidden).toBe(true); // (one check's fold, not the others')
  });

  test("the states: failed with its last answer and note, done, open; the last answer reads „Dim · 16.10 14:05 · Viga“ in Tallinn time, a pass „Läbitud“", async () => {
    await showAll();
    await openAll();
    expect(state("a1-fail")).toBe("failed");
    expect(pressed("a1-fail")).toEqual(["bad"]);
    expect(check("a1-fail").querySelector("[data-check-last]")!.textContent).toBe("Dim · 16.10 14:05 · Viga");
    expect(check("a1-fail").querySelector<HTMLTextAreaElement>("[data-check-note]")!.value).toBe("Nupp ei tööta");
    expect(state("a1-plain")).toBe("open");
    expect(pressed("a1-plain")).toEqual([]);
    expect(check("a1-plain").querySelector("[data-check-last]")).toBeNull();
    expect(check("a1-plain").querySelector("[data-check-note]")).toBeNull(); // (no answer, nothing to write a note on)
    expect(state("a0-done")).toBe("done");
    expect(pressed("a0-done")).toEqual(["ok"]);
    expect(check("a0-done").querySelector("[data-check-last]")!.textContent).toBe("Maria · 16.10 13:00 · Läbitud");
  });

  test("a „Jäta vahele“ stored before the button went stays as it was: done, counted „Läbitud“, neither answer pressed, its last line and note box", async () => {
    await showAll({ initial: { ...SERVER, "a1-plain": answer("skip", "2026-10-16T09:30:00.000Z", "Maria", "Hiljem") } });
    expect(state("a1-plain")).toBe("done");
    expect(pressed("a1-plain")).toEqual([]);
    expect(check("a1-plain").querySelector("[data-check-last]")!.textContent).toBe("Maria · 16.10 12:30 · Jäta vahele");
    const note = check("a1-plain").querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    expect([note.value, note.placeholder]).toEqual(["Hiljem", "Märkus"]);
    expect(pills("olek")).toContain("Läbitud 2");
    // a note typed on it keeps its answer
    await act(async () => note.focus());
    await typeInto(note, "Hiljem, tahvlis");
    await act(async () => note.blur());
    await settle();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-plain": { status: "skip", note: "Hiljem, tahvlis" } } }]);
  });

  test("a redo answered before its instant is open, with the old answer under it as „Varasem vastus“, and no answer pressed", async () => {
    await showAll();
    const redo = check("a1-redo");
    expect(state("a1-redo")).toBe("open");
    expect(redo.querySelector("[data-overtaken]")!.textContent).toBe("Varasem vastus (enne muudatust): Läbitud");
    expect(pressed("a1-redo")).toEqual([]);
    expect(redo.querySelector("[data-check-last]")).toBeNull();
    expect(check("a1-fail").querySelector("[data-overtaken]")).toBeNull();
    await click(redo.querySelector('[data-answer="ok"]')!);
    expect(state("a1-redo")).toBe("done");
    expect(redo.querySelector("[data-overtaken]")).toBeNull();
    expect(pressed("a1-redo")).toEqual(["ok"]);
  });

  test("„Viga“ opens the note field and focuses it, asking „Mis läks valesti?“, and sends the answer at once", async () => {
    await showAll();
    const plain = check("a1-plain");
    expect(plain.querySelector("[data-check-note]")).toBeNull();
    await click(plain.querySelector('[data-answer="bad"]')!);
    const note = plain.querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    expect(note).not.toBeNull();
    expect(note.placeholder).toBe("Mis läks valesti?");
    expect(document.activeElement).toBe(note);
    expect(state("a1-plain")).toBe("failed");
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-plain": { status: "bad", note: "" } } }]);
    expect(chip()).toBe("saved");
    expect(plain.querySelector("[data-check-last]")!.textContent).toBe("Maria · 16.10 15:00 · Viga");
  });

  // Dim 22.10 (as on Rempire's test page): every answer has its note box open under it at once.
  test("„Läbitud“ opens the note box at once, asking „Märkus“, without taking the focus; one box whatever the answer", async () => {
    await showAll();
    const plain = check("a1-plain");
    await click(plain.querySelector('[data-answer="ok"]')!);
    const note = plain.querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    expect(note.placeholder).toBe("Märkus");
    expect(note.getAttribute("aria-label")).toBe("Märkus");
    expect(document.activeElement).not.toBe(note); // (a phone's keyboard does not jump up after a pass)
    expect(note.maxLength).toBe(1000);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-plain": { status: "ok", note: "" } } }]);
    await click(plain.querySelector('[data-answer="bad"]')!);
    expect(plain.querySelector<HTMLTextAreaElement>("[data-check-note]")!.placeholder).toBe("Mis läks valesti?");
    expect(document.activeElement).toBe(plain.querySelector("[data-check-note]"));
    expect(plain.querySelectorAll("[data-check-note]")).toHaveLength(1);
  });

  test("a note typed is sent when the field loses the focus, with the answer it was written on; pressing „Läbitud“ later keeps it", async () => {
    await showAll();
    const plain = check("a1-plain");
    await click(plain.querySelector('[data-answer="bad"]')!);
    const note = plain.querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    await typeInto(note, "Nupp ei tööta ");
    expect(note.value).toBe("Nupp ei tööta "); // (a trailing space is not eaten while she types)
    await act(async () => note.blur());
    await settle();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
      { answers: { "a1-plain": { status: "bad", note: "" } } },
      { answers: { "a1-plain": { status: "bad", note: "Nupp ei tööta " } } },
    ]);
    await click(plain.querySelector('[data-answer="ok"]')!);
    expect(calls.at(-1)!.body).toEqual({ answers: { "a1-plain": { status: "ok", note: "Nupp ei tööta " } } });
  });

  test("a note of 1 001 characters is stopped at 1 000: by maxLength in the field, and in what is sent", async () => {
    await showAll();
    const note = check("a1-fail").querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    expect(NOTE_MAX).toBe(1000);
    expect(note.maxLength).toBe(1000);
    await act(async () => note.focus());
    await typeInto(note, "x".repeat(1001));
    expect(note.value).toHaveLength(1000);
    await act(async () => note.blur());
    await settle();
    expect(calls.at(-1)!.body!.answers["a1-fail"].note).toHaveLength(1000);
  });

  test("a link to a check (#id) opens its area and shows the check, whatever the filters say", async () => {
    window.location.hash = "#a2-fresh";
    await show({ you: DIM }); // (Dim's „Mina“ hides Maria's checks)
    expect(ids()).toContain("a2-fresh");
    expect($('[data-area="a2"] [data-area-toggle]')!.getAttribute("aria-expanded")).toBe("true");
  });

  test("a check called „constructor“ or „valueOf“ is not answered because Object.prototype has such a member", async () => {
    const plan: Plan = { ...PLAN, areas: [{ id: "a", name: "Osa" }], items: [item("constructor", "a", "maria"), item("valueOf", "a", "maria")] };
    server = {};
    await show({ plan, initial: {} });
    expect($$("[data-check-state]").map((c) => c.getAttribute("data-check-state"))).toEqual(["open", "open"]);
    expect(line()).toBe("2 kontrolli · 0 läbitud · 0 viga");
  });
});

describe("SaveStatus in place of the outbox line (R-i)", () => {
  test("no chip before anything is sent; „✓ Salvestatud HH:MM“ after a save; „Salvestamata — proovin uuesti“ while one fails", async () => {
    await showAll();
    expect(chip()).toBeNull();
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(chip()).toBe("saved");
    expect(chipText()).toMatch(/^✓ Salvestatud \d\d:\d\d$/);
    putReply = async () => {
      throw new TypeError("Failed to fetch");
    };
    await click($('[data-area="a2"] [data-area-toggle]')!);
    await click(check("a2-fresh").querySelector('[data-answer="bad"]')!);
    expect(chip()).toBe("retry");
    expect(chipText()).toBe("Salvestamata — proovin uuesti");
    expect(pressed("a2-fresh")).toEqual(["bad"]); // (her press is shown all the same)
  });

  test("a press after the session ended (401) shows „Salvestamata — logi uuesti sisse“; the press is kept on the device and on the page, and not sent again by itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      await showAll();
      putReply = async () => unauthorized();
      await click(check("a1-plain").querySelector('[data-answer="bad"]')!);
      expect(chip()).toBe("signedOut");
      expect(chipText()).toBe("Salvestamata — logi uuesti sisse");
      expect(state("a1-plain")).toBe("failed");
      expect(JSON.parse(localStorage.getItem(OUTBOX_KEY)!)["a1-plain"]).toMatchObject({ status: "bad", note: "" });
      await act(async () => vi.advanceTimersByTime(5 * 60_000));
      await settle();
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
      expect(chip()).toBe("signedOut");
    } finally {
      vi.useRealTimers();
    }
  });

  test("„Värskenda“ shows „Kontrollin salvestatud teksti…“ while it reads; a read refused with 401 shows the signed-out state, a good one takes it away", async () => {
    await showAll();
    let release: (r: Response) => void = () => {};
    getReply = () => new Promise<Response>((r) => (release = r));
    await click($("[data-refresh]")!);
    expect(chip()).toBe("checking");
    expect(chipText()).toBe("Kontrollin salvestatud teksti…");
    expect($("[data-refresh]")!.getAttribute("aria-busy")).toBe("true");
    await act(async () => release(unauthorized()));
    await settle();
    expect(chip()).toBe("signedOut");
    getReply = () => json({ ok: true, plan: PLAN, answers: server, auto: {}, you: MARIA });
    await click($("[data-refresh]")!);
    expect(chip()).toBeNull();
  });

  test("the database is down (initial: null): no chip, every check shown open, and a press is kept and retried", async () => {
    await showAll({ initial: null });
    expect(chip()).toBeNull();
    await openAll();
    expect(ids()).toEqual(["a0-done", "a1-redo", "a1-fail", "a1-plain", "a2-fresh", "a2-dim"]);
    expect($$("[data-check-state]").every((c) => c.getAttribute("data-check-state") === "open")).toBe(true);
    expect(line()).toBe("6 kontrolli · 0 läbitud · 0 viga");
    putReply = async () => json({ ok: false, error: "unavailable" }, 503);
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(state("a1-plain")).toBe("done");
    expect(JSON.parse(localStorage.getItem(OUTBOX_KEY)!)["a1-plain"]).toMatchObject({ status: "ok" });
    expect(chip()).toBe("retry");
  });

  test("a GET that is not ok, or not JSON (a 500 page), or no connection keeps what was read before; the database back, „Värskenda“ reads again", async () => {
    await showAll();
    getReply = () => new Response("<html>Internal Server Error</html>", { status: 500 });
    await click($("[data-refresh]")!);
    expect(chip()).toBeNull();
    await openAll();
    expect(ids()).toHaveLength(6);
    expect(state("a1-fail")).toBe("failed"); // (what was read before is still shown)
    getReply = () => {
      throw new TypeError("Failed to fetch");
    };
    await click($("[data-refresh]")!);
    expect(state("a1-fail")).toBe("failed");
    server = { ...SERVER, "a1-plain": answer("ok", "2026-10-16T11:30:00.000Z", "Dim") };
    getReply = () => json({ ok: true, plan: PLAN, answers: server, you: MARIA });
    await click($("[data-refresh]")!);
    expect(state("a1-plain")).toBe("done");
  });

  test("with the database down at the start, the first good read fills the answers in", async () => {
    await showAll({ initial: null });
    server = { ...SERVER };
    getReply = () => json({ ok: true, plan: PLAN, answers: server, you: MARIA });
    await click($("[data-refresh]")!);
    await openAll();
    expect(state("a1-fail")).toBe("failed");
  });

  test("every load reads the answers again, and „Värskenda“ reads them again: what the other admin answered shows without a reload", async () => {
    await showAll();
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(state("a1-plain")).toBe("open");
    server = { ...SERVER, "a1-plain": answer("bad", "2026-10-16T12:00:00.000Z", "Dim", "Ei avane") };
    await click($("[data-refresh]")!);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(state("a1-plain")).toBe("failed");
    expect(check("a1-plain").querySelector("[data-check-last]")!.textContent).toBe("Dim · 16.10 15:00 · Viga");
    expect(check("a1-plain").querySelector<HTMLTextAreaElement>("[data-check-note]")!.value).toBe("Ei avane");
  });

  test("an answer not sent yet shows over the server's, and a read does not take it away", async () => {
    await showAll();
    putReply = async () => json({ ok: false, error: "unavailable" }, 503);
    await click(check("a1-fail").querySelector('[data-answer="ok"]')!);
    expect(state("a1-fail")).toBe("done");
    await click($("[data-refresh]")!);
    expect(state("a1-fail")).toBe("done"); // (the server still says Viga)
    expect(chip()).toBe("retry");
    expect(check("a1-fail").querySelector("[data-check-last]")).toBeNull();
  });

  test("a read that began before a save came back is older than that save and is not taken", async () => {
    let release: (r: Response) => void = () => {};
    const stale = json({ ok: true, plan: PLAN, answers: SERVER, you: MARIA });
    getReply = () => new Promise<Response>((r) => (release = r));
    remember({ filter: "all", who: "all" });
    await act(async () => root.render(createElement(TestPlan, { plan: PLAN, initial: SERVER, you: MARIA, buildAt: BUILD_AT })));
    await settle(); // (the read on load is still on its way)
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(state("a1-plain")).toBe("done");
    expect(check("a1-plain").querySelector("[data-check-last]")!.textContent).toBe("Maria · 16.10 15:00 · Läbitud"); // (the save's answer)
    await act(async () => release(stale));
    await settle();
    expect(state("a1-plain")).toBe("done"); // (the read saw the answers before the save)
    expect(check("a1-plain").querySelector("[data-check-last]")).not.toBeNull();
  });

  test("answers left on the device by an earlier visit (one signed out, say) are sent at once and shown", async () => {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify({ "a1-plain": { status: "bad", note: "Jäi saatmata", clientAt: "2026-10-16T09:00:00.000Z" } }));
    await showAll();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-plain": { status: "bad", note: "Jäi saatmata" } } }]);
    expect(state("a1-plain")).toBe("failed");
    expect(localStorage.getItem(OUTBOX_KEY)).toBeNull();
    expect(chip()).toBe("saved");
  });
});

describe("a tap while the page is still loading", () => {
  /** Lets the page's work run with no act() around it (the tap below must land between the hydration and what its effects set). */
  const ticks = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };

  test("a tap that hydration replays (the page's effects have not drawn yet) is sent; a Viga then, and the note typed after it, are saved as Viga with that note", async () => {
    // a1-plain holds a pass with a note; an admin who sees every check, so the area a1 is open in the server's HTML as well
    const initial = { ...SERVER, "a1-plain": answer("ok", "2026-10-16T10:30:00.000Z", "Maria", "Tahvlis korras") };
    server = { ...initial };
    const props = { plan: PLAN, initial, you: { name: "Kati", tester: null }, buildAt: BUILD_AT };
    const box = document.createElement("div");
    document.body.append(box);
    box.innerHTML = renderToString(createElement(TestPlan, props));
    const inBox = <E extends Element = HTMLElement>(selector: string) => box.querySelector<E>(selector)!;
    const puts = () => calls.filter((c) => c.method === "PUT").map((c) => c.body);
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    const hydrated = hydrateRoot(box, createElement(TestPlan, props));
    try {
      inBox('[data-check="a1-plain"] [data-answer="bad"]').click(); // (before anything has settled: React hydrates, then runs the click)
      await ticks();
      expect(puts()).toEqual([{ answers: { "a1-plain": { status: "bad", note: "Tahvlis korras" } } }]);
      expect(inBox('[data-check="a1-plain"]').getAttribute("data-check-state")).toBe("failed");
      const note = inBox<HTMLTextAreaElement>('[data-check="a1-plain"] [data-check-note]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Nupp ei tööta");
      note.dispatchEvent(new Event("input", { bubbles: true }));
      note.focus();
      note.blur();
      await ticks();
      expect(puts().at(-1)).toEqual({ answers: { "a1-plain": { status: "bad", note: "Nupp ei tööta" } } });
      expect(puts().every((body) => body!.answers["a1-plain"].status === "bad")).toBe(true);
    } finally {
      hydrated.unmount();
      box.remove();
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    }
  });
});

// Dim 25.10: a third tester, „Automaattest“, whose answers never count as Maria's or Dim's. Maria and Dim see each of its answers as one quiet line
// under the check; the Automaattest session answers in its own right and sees every check.
describe("Automaattest (Dim 25.10)", () => {
  const AUTO_ANSWERS: Record<string, PageAnswer> = {
    "a1-redo": answer("bad", "2026-10-14T10:00:00.000Z", "Automaattest"), // before its redo's instant (15.10)
    "a1-fail": answer("ok", "2026-10-16T12:06:00.000Z", "Automaattest"),
    "a1-plain": answer("ok", "2026-10-16T12:05:00.000Z", "Automaattest", "Kõik sammud läbitud."),
  };
  const AUTO_YOU = { name: "Automaattest", tester: "auto" as const };
  const autoLine = (id: string) => check(id).querySelector("[data-check-auto]")?.textContent ?? null;
  const autoNote = (id: string) => check(id).querySelector("[data-check-auto-note]")?.textContent ?? null;

  test("for Maria: one quiet line „Automaattest: Läbitud · 16.10 15:05“ under each check it answered, with its note; her own answers and counts are as without it", async () => {
    const seen = () => ({ line: line(), pills: pills("olek"), states: ids().map((id) => state(id!)), last: $$("[data-check-last]").map((p) => p.textContent) });
    await showAll();
    await openAll();
    const without = seen();
    await remount();

    await showAll({ auto: AUTO_ANSWERS });
    await openAll();
    expect(autoLine("a1-plain")).toBe("Automaattest: Läbitud · 16.10 15:05");
    expect(autoNote("a1-plain")).toBe("Kõik sammud läbitud.");
    expect(autoLine("a1-fail")).toBe("Automaattest: Läbitud · 16.10 15:06");
    expect(autoNote("a1-fail")).toBeNull();
    expect(autoLine("a0-done")).toBeNull();
    expect(state("a1-plain")).toBe("open");
    expect(pressed("a1-plain")).toEqual([]);
    expect(check("a1-plain").querySelector("[data-check-last]")).toBeNull();
    expect(check("a1-plain").querySelector("[data-check-note]")).toBeNull();
    expect(state("a1-fail")).toBe("failed");
    expect(check("a1-fail").querySelector("[data-check-last]")!.textContent).toBe("Dim · 16.10 14:05 · Viga");
    expect(seen()).toEqual(without);
  });

  test("an answer a redo has overtaken shows as one from before the change, in the page's own words", async () => {
    await showAll({ auto: AUTO_ANSWERS });
    await openAll();
    expect(autoLine("a1-redo")).toBe("Automaattest: Varasem vastus (enne muudatust): Viga · 14.10 13:00");
  });

  test("Maria's press on a check Automaattest answered saves her answer only, and its line stays", async () => {
    await showAll({ auto: AUTO_ANSWERS });
    await openAll();
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-plain": { status: "ok", note: "" } } }]);
    expect(state("a1-plain")).toBe("done");
    expect(autoLine("a1-plain")).toBe("Automaattest: Läbitud · 16.10 15:05");
    expect((check("a1-plain").querySelector("[data-check-note]") as HTMLTextAreaElement).value).toBe(""); // (its note is not hers)
  });

  test("the „Kes“ choice „Automaattest“ shows the checks Automaattest answered and nothing else, counted in „Olek“, and is kept on the device", async () => {
    await showAll({ auto: AUTO_ANSWERS });
    await click(kes("auto"));
    expect(kes("auto").getAttribute("aria-pressed")).toBe("true");
    await openAll();
    expect(ids()).toEqual(["a1-redo", "a1-fail", "a1-plain"]);
    // (the counts are Maria's answers on those checks: a1-redo open again, a1-fail her Viga, a1-plain open)
    expect(pills("olek")).toEqual(["Kõik", "Avatud 2", "Viga 1", "Läbitud 0"]);
    expect(JSON.parse(localStorage.getItem("mslab-testplan-view")!)).toEqual({ filter: "all", who: "auto" });
  });

  test("the Automaattest session sees every check under „Mina“, its own answers as the checks' answers and no quiet line; a press saves its answer", async () => {
    await show({ initial: AUTO_ANSWERS, auto: AUTO_ANSWERS, you: AUTO_YOU });
    expect(kes("mina").getAttribute("aria-pressed")).toBe("true");
    await openAll();
    expect(ids()).toEqual(["a0-done", "a1-redo", "a1-fail", "a1-plain", "a2-fresh", "a2-dim"]);
    // its own: a1-fail and a1-plain passed, a1-redo open over its overtaken Viga, the rest open
    expect(line()).toBe("6 kontrolli · 2 läbitud · 0 viga");
    expect($$("[data-check-auto]")).toEqual([]);
    expect(pressed("a1-plain")).toEqual(["ok"]);
    expect(check("a1-plain").querySelector("[data-check-last]")!.textContent).toBe("Automaattest · 16.10 15:05 · Läbitud");
    expect(check("a1-redo").querySelector("[data-overtaken]")!.textContent).toBe("Varasem vastus (enne muudatust): Viga");
    await click(check("a1-plain").querySelector('[data-answer="bad"]')!);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-plain": { status: "bad", note: "Kõik sammud läbitud." } } }]);
    await click(kes("auto"));
    await openAll();
    expect(ids()).toEqual(["a1-redo", "a1-fail", "a1-plain"]);
  });
});

describe("TestplanCard", () => {
  test("says how many checks are open and failed, and links to the page", async () => {
    await act(async () => root.render(createElement(TestplanCard, { open: 5, bad: 2 })));
    const card = $("[data-testplan-card]")!;
    expect(card.textContent).toContain("Testimine: 5 avatud, 2 viga");
    const link = card.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/admin/testimine");
    expect(link.textContent).toBe("Ava");
  });

  test("zero failures still say so (the counts are the plan's, both of them)", async () => {
    await act(async () => root.render(createElement(TestplanCard, { open: 12, bad: 0 })));
    expect($("[data-testplan-card]")!.textContent).toContain("Testimine: 12 avatud, 0 viga");
  });
});
