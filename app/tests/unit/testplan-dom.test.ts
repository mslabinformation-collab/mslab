// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TestPlan } from "@/components/admin/TestPlan";
import { TestplanCard } from "@/components/admin/TestplanCard";
import { OUTBOX_KEY } from "@/components/admin/testplan-outbox";
import { NOTE_MAX, type TestItem, type TestPlan as Plan } from "@/domain/testplan";
import { adminEt } from "@/i18n/dict/admin";
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
/** A save's body: a press, a note, or (Dim 29.10) "clear", an answer taken back. */
type PutBody = { answers: Record<string, { status: PageAnswer["status"] | "clear"; note: string }> };
let putReply: (body: PutBody) => Promise<Response>;
const calls: { method: string; body?: PutBody }[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The API's PUT as the server answers it: each answer stored as Maria's at 12:00 UTC, a clear removing the check's answer; every answer back. */
const saveOnServer = async (body: PutBody): Promise<Response> => {
  server = { ...(server ?? {}) };
  for (const [id, a] of Object.entries(body.answers))
    if (a.status === "clear") delete server[id];
    else server[id] = { status: a.status, note: a.note, at: "2026-10-16T12:00:00.000Z", byName: "Maria" };
  return json({ ok: true, answers: server });
};
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
/** Dim 29.10 (review Q1): the line when the answers cannot be read, word for word. */
const UNREAD = "Vastuseid ei saanud praegu lugeda. Need on alles; vajuta hiljem „Värskenda“.";
const unreadLine = () => $("[data-unread]")!.textContent;
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
  putReply = saveOnServer;
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
    expect(fail.querySelector("h3 [data-check-title]")!.textContent).toBe("Kontroll a1-fail");
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

  // Admin polish Part A (Dim 29.10): the steps are open on a check still to do, folded on one done or failed; „Sammud ▸“ toggles either way.
  test("an open check shows its steps, „Mida näed“ and „Miks“; a done or failed one has them folded; „Sammud ▸“ toggles either way, one check's only", async () => {
    await showAll();
    await openAll();
    const plain = check("a1-plain");
    const toggle = plain.querySelector<HTMLButtonElement>("[data-steps-toggle]")!;
    expect(toggle.textContent).toBe("Sammud ▸");
    const fold = plain.querySelector<HTMLElement>("[data-steps]")!;
    expect(toggle.getAttribute("aria-controls")).toBe(fold.id);
    // (one of many „Sammud“ buttons on the page: the check's title describes it, review M-5)
    expect(container.querySelector(`[id="${toggle.getAttribute("aria-describedby")}"]`)!.textContent).toBe("Kontroll a1-plain");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(fold.hidden).toBe(false);
    expect([...fold.querySelectorAll("ol > li")].map((l) => l.textContent)).toEqual(["Tee seda.", "Tee ka teist."]);
    expect(fold.textContent).toContain("Mida näed");
    expect([...fold.querySelectorAll("ul > li")].map((l) => l.textContent)).toEqual(["Näed seda.", "Näed ka teist."]);
    expect(fold.textContent).toContain("Miks");
    expect(fold.textContent).toContain("Sest nii on vaja.");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(fold.hidden).toBe(true);
    expect(check("a1-redo").querySelector<HTMLElement>("[data-steps]")!.hidden).toBe(false); // (one check's fold, not the others')
    await click(toggle);
    expect(fold.hidden).toBe(false);
    // done and failed: folded, and they open on a press
    const steps = (id: string) => [check(id).querySelector("[data-steps-toggle]")!.getAttribute("aria-expanded"), check(id).querySelector<HTMLElement>("[data-steps]")!.hidden];
    expect(steps("a0-done")).toEqual(["false", true]);
    expect(steps("a1-fail")).toEqual(["false", true]);
    await click(check("a1-fail").querySelector("[data-steps-toggle]")!);
    expect(steps("a1-fail")).toEqual(["true", false]);
  });

  // (controller ruling on review Minor 6: a „Viga“ leaves the steps as they are — she is about to write in the note what failed —, a „Läbitud“ folds
  // them, an answer taken back opens them; on load a done or failed check has them folded)
  test("„Läbitud“ folds the steps, „Viga“ leaves them as they are, an answer taken back opens them; a choice of the tester's own holds", async () => {
    await showAll();
    await openAll();
    const steps = (id: string) => check(id).querySelector<HTMLElement>("[data-steps]")!.hidden;
    expect(steps("a1-plain")).toBe(false);
    await click(check("a1-plain").querySelector('[data-answer="bad"]')!);
    expect(steps("a1-plain")).toBe(false); // (a Viga: still open, under the note box asking what went wrong)
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(steps("a1-plain")).toBe(true);
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!); // (pressed again: taken back)
    expect(steps("a1-plain")).toBe(false);
    // a Viga on a passed check, whose steps are folded, leaves them folded
    expect(steps("a0-done")).toBe(true);
    await click(check("a0-done").querySelector('[data-answer="bad"]')!);
    expect(steps("a0-done")).toBe(true);
    // she folds them herself: they stay folded through the next press and its take-back
    await click(check("a1-plain").querySelector("[data-steps-toggle]")!);
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(steps("a1-plain")).toBe(true);
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

  // Dim 29.10 (review Q2): a check answered „Jäta vahele“ before that button went is open again — in the line, the „Olek“ pills and filters and
  // the area bar — while the stored answer and its note stay as they are, and its last line still says it was skipped.
  test("a „Jäta vahele“ stored before the button went counts as „Avatud“: open, in the line, the pills and the area bar; its last line and note box stay", async () => {
    await showAll({ initial: { ...SERVER, "a1-plain": answer("skip", "2026-10-16T09:30:00.000Z", "Maria", "Hiljem") } });
    expect(state("a1-plain")).toBe("open");
    expect(pressed("a1-plain")).toEqual([]);
    expect(check("a1-plain").querySelector("[data-check-last]")!.textContent).toBe("Maria · 16.10 12:30 · Jäta vahele");
    const note = check("a1-plain").querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    expect([note.value, note.placeholder]).toEqual(["Hiljem", "Märkus"]);
    // (as without it: a1-plain was open then too)
    expect(line()).toBe("6 kontrolli · 1 läbitud · 1 viga");
    expect(pills("olek")).toEqual(["Kõik", "Avatud 4", "Viga 1", "Läbitud 1"]);
    expect($('[data-area="a1"] [data-area-count]')!.textContent).toBe("0 / 3");
    // a note typed on it keeps its answer
    await act(async () => note.focus());
    await typeInto(note, "Hiljem, tahvlis");
    await act(async () => note.blur());
    await settle();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-plain": { status: "skip", note: "Hiljem, tahvlis" } } }]);
  });

  test("a stored „Jäta vahele“ is listed under „Avatud“ with its note, and not under „Läbitud“", async () => {
    await showAll({ initial: { ...SERVER, "a1-plain": answer("skip", "2026-10-16T09:30:00.000Z", "Maria", "Hiljem") } });
    await click(olek("open"));
    expect(ids()).toContain("a1-plain");
    expect(check("a1-plain").querySelector<HTMLTextAreaElement>("[data-check-note]")!.value).toBe("Hiljem");
    expect(check("a1-plain").querySelector("[data-check-last]")!.textContent).toContain("· Jäta vahele");
    await click(olek("done"));
    expect(ids()).toEqual(["a0-done"]);
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

// Admin polish Part A (Dim 29.10: "needs to be simple and understandable, clear which tests are done and which need doing"): a marker before each
// title, a row that stays where it was once answered, and an answer that can be taken back.
describe("what is done and what is to do (admin polish Part A, Dim 29.10)", () => {
  const marker = (id: string) => check(id).querySelector("[data-check-marker]")!;
  const word = (id: string) => check(id).querySelector("[data-check-state-word]")!.textContent;
  const puts = () => calls.filter((c) => c.method === "PUT").map((c) => c.body);
  const takeBack = (id: string) => check(id).querySelector<HTMLButtonElement>("[data-take-back]");
  const note = (id: string) => check(id).querySelector<HTMLTextAreaElement>("[data-check-note]");

  test("a marker before each title: an empty ring for an open check, a ✓ for a done one, a ✕ for a failed one, with the state's word for a screen reader", async () => {
    await showAll();
    await openAll();
    expect([marker("a1-plain").getAttribute("data-check-marker"), marker("a1-plain").textContent, word("a1-plain")]).toEqual(["open", "", "Avatud"]);
    expect([marker("a0-done").getAttribute("data-check-marker"), marker("a0-done").textContent, word("a0-done")]).toEqual(["done", "✓", "Läbitud"]);
    expect([marker("a1-fail").getAttribute("data-check-marker"), marker("a1-fail").textContent, word("a1-fail")]).toEqual(["failed", "✕", "Viga"]);
    expect(word("a1-redo")).toBe("Avatud"); // (a redo answered before its instant is to do again)
    // the glyph is not read; the word is, in the heading, before the title (its own element: the answers' group is named by the title alone)
    const h3 = check("a0-done").querySelector("h3")!;
    expect(marker("a0-done").getAttribute("aria-hidden")).toBe("true");
    expect(marker("a0-done").closest("h3")).toBe(h3);
    expect(h3.textContent).toBe("✓Läbitud Kontroll a0-done");
    // the state word follows a press at once
    await click(check("a1-plain").querySelector('[data-answer="bad"]')!);
    expect([marker("a1-plain").getAttribute("data-check-marker"), word("a1-plain")]).toEqual(["failed", "Viga"]);
  });

  test("Review Focus 5: under „Avatud“ a press keeps the row in its place with its new state, the counts and the bar move at once; „Avatud“ chosen again drops it", async () => {
    await showAll();
    await click(olek("open"));
    expect(ids()).toEqual(["a1-redo", "a1-plain", "a2-fresh", "a2-dim"]);
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(ids()).toEqual(["a1-redo", "a1-plain", "a2-fresh", "a2-dim"]);
    expect(state("a1-plain")).toBe("done");
    expect(pills("olek")).toEqual(["Kõik", "Avatud 3", "Viga 1", "Läbitud 2"]);
    expect(line()).toBe("6 kontrolli · 2 läbitud · 1 viga");
    expect($('[data-area="a1"] [data-area-count]')!.textContent).toBe("1 / 3");
    // a second press, a Viga, on another one: both stay
    await click(check("a2-fresh").querySelector('[data-answer="bad"]')!);
    expect(ids()).toEqual(["a1-redo", "a1-plain", "a2-fresh", "a2-dim"]);
    await click(olek("open"));
    expect(ids()).toEqual(["a1-redo", "a2-dim"]);
  });

  test("Review Focus 5: a row kept by a press is dropped by „Värskenda“, or by another „Olek“ or „Kes“ choice", async () => {
    await showAll();
    await click(olek("open"));
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(ids()).toContain("a1-plain");
    await click($("[data-refresh]")!);
    expect(ids()).not.toContain("a1-plain");
    // a choice of „Olek“ and back
    await click(check("a2-fresh").querySelector('[data-answer="ok"]')!);
    expect(ids()).toContain("a2-fresh");
    await click(olek("bad"));
    await click(olek("open"));
    expect(ids()).not.toContain("a2-fresh");
    // a choice of „Kes“
    await click(check("a2-dim").querySelector('[data-answer="ok"]')!);
    expect(ids()).toContain("a2-dim");
    await click(kes("mina"));
    await click(kes("all"));
    expect(ids()).toEqual(["a1-redo"]);
  });

  test("under „Läbitud“ an answer taken back keeps its row too, now open; and the page loaded again does not keep it", async () => {
    await showAll();
    await click(olek("done"));
    expect(ids()).toEqual(["a0-done"]);
    await click(check("a0-done").querySelector('[data-answer="ok"]')!);
    expect(ids()).toEqual(["a0-done"]);
    expect(state("a0-done")).toBe("open");
    expect(pills("olek")).toEqual(["Kõik", "Avatud 5", "Viga 1", "Läbitud 0"]);
    const now = { ...server! };
    await remount();
    await show({ initial: now }); // (the choice „Läbitud“ is kept on the device)
    expect(olek("done").getAttribute("aria-pressed")).toBe("true");
    expect($("[data-list-empty]")!.textContent).toBe("Selle valikuga kontrolle pole.");
  });

  test("the pressed half pressed again takes the answer back: a „clear“ is sent, the check is „Avatud“, no half is pressed, the note box and the last line go", async () => {
    await showAll();
    await openAll();
    expect(pressed("a0-done")).toEqual(["ok"]);
    await click(check("a0-done").querySelector('[data-answer="ok"]')!);
    expect(puts()).toEqual([{ answers: { "a0-done": { status: "clear", note: "" } } }]);
    expect(state("a0-done")).toBe("open");
    expect(word("a0-done")).toBe("Avatud");
    expect(pressed("a0-done")).toEqual([]);
    expect(note("a0-done")).toBeNull();
    expect(check("a0-done").querySelector("[data-check-last]")).toBeNull();
    expect(server!["a0-done"]).toBeUndefined();
    expect(chip()).toBe("saved");
    // a half that is not pressed is an ordinary answer
    await click(check("a1-fail").querySelector('[data-answer="ok"]')!);
    expect(puts().at(-1)).toEqual({ answers: { "a1-fail": { status: "ok", note: "Nupp ei tööta" } } });
    expect(state("a1-fail")).toBe("done");
  });

  // review Minor 1: a double-click (or a tablet's double-tap) presses once; its second click must not take the answer back at once
  test("a double-click on a half presses it and does not take it back; a click from the keyboard (detail 0) on the pressed half still does", async () => {
    await showAll();
    const ok = check("a1-plain").querySelector<HTMLButtonElement>('[data-answer="ok"]')!;
    const clickWith = async (detail: number) => {
      await act(async () => void ok.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail })));
      await settle();
    };
    await clickWith(1);
    await clickWith(2); // (the second click of the double-click: event.detail 2)
    expect(state("a1-plain")).toBe("done");
    expect(pressed("a1-plain")).toEqual(["ok"]);
    expect(puts()).toEqual([{ answers: { "a1-plain": { status: "ok", note: "" } } }]);
    await clickWith(3); // (a third click of the same burst too)
    expect(state("a1-plain")).toBe("done");
    // Enter or Space on the focused pressed half: a click with detail 0, which takes the answer back
    await clickWith(0);
    expect(state("a1-plain")).toBe("open");
    expect(puts().at(-1)).toEqual({ answers: { "a1-plain": { status: "clear", note: "" } } });
    // a single click later (detail 1 again) presses as ever, and a single click on the pressed half takes it back
    await clickWith(1);
    expect(state("a1-plain")).toBe("done");
    await clickWith(1);
    expect(state("a1-plain")).toBe("open");
  });

  test("the last-answer line ends with „Võta vastus tagasi“, which takes the answer back the same way; the focus stays on the check, on the half that was pressed", async () => {
    await showAll();
    const last = check("a1-fail").querySelector("[data-check-last]")!;
    expect(last.textContent).toBe("Dim · 16.10 14:05 · Viga");
    const link = takeBack("a1-fail")!;
    expect(link.textContent).toBe("Võta vastus tagasi");
    expect(link.tagName).toBe("BUTTON");
    expect(link.getAttribute("type")).toBe("button");
    expect(last.parentElement).toBe(link.parentElement); // (the same line, the words first)
    expect(last.parentElement!.lastElementChild).toBe(link);
    // (one of many on the page: the check's title describes it)
    expect(container.querySelector(`[id="${link.getAttribute("aria-describedby")}"]`)!.textContent).toBe("Kontroll a1-fail");
    await act(async () => link.focus());
    await click(link);
    expect(puts()).toEqual([{ answers: { "a1-fail": { status: "clear", note: "" } } }]);
    expect(state("a1-fail")).toBe("open");
    expect(note("a1-fail")).toBeNull();
    expect(takeBack("a1-fail")).toBeNull();
    expect(document.activeElement).toBe(check("a1-fail").querySelector('[data-answer="bad"]'));
    // no line, no link while an answer has not reached the server; a check with no answer has neither
    putReply = async () => json({ ok: false, error: "unavailable" }, 503);
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(takeBack("a1-plain")).toBeNull();
    expect(takeBack("a1-redo")).toBeNull(); // (its only answer is one a redo has overtaken)
  });

  // (happy-dom's click moves no focus, so here the note box keeps it through the press and its note is still waiting for its second: the outbox's
  // clear replaces it. A real browser blurs the box first, which sends the note: the next test.)
  test("its note goes with the answer: the box is gone, a note still waiting in the outbox is replaced by the clear, and the next press carries no note (Task 4's open concern)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      await showAll();
      const box = note("a1-fail")!;
      await act(async () => box.focus());
      await typeInto(box, "Nupp ei tööta, ka teisel korral");
      await click(check("a1-fail").querySelector('[data-answer="bad"]')!); // (the pressed half, while the note waits for its second)
      expect(note("a1-fail")).toBeNull();
      await act(async () => vi.advanceTimersByTime(5000));
      await settle();
      expect(puts()).toEqual([{ answers: { "a1-fail": { status: "clear", note: "" } } }]);
      await click(check("a1-fail").querySelector('[data-answer="ok"]')!);
      expect(puts().at(-1)).toEqual({ answers: { "a1-fail": { status: "ok", note: "" } } });
      expect(note("a1-fail")!.value).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  // review Minor 3: in a real browser the press blurs the note box first, and the blur sends what she typed (a first note earns its Telegram
  // message); the clear follows it, so in the end the check has no answer and no note
  test("a note blurred by the press (a real browser) is sent first, then the clear: the check ends with no answer, no note and no box", async () => {
    await showAll();
    const box = note("a1-fail")!;
    await act(async () => box.focus());
    await typeInto(box, "Nupp ei tööta, ka teisel korral");
    await act(async () => box.blur()); // (what the browser does when the half is pressed)
    await settle();
    await click(check("a1-fail").querySelector('[data-answer="bad"]')!);
    expect(puts()).toEqual([
      { answers: { "a1-fail": { status: "bad", note: "Nupp ei tööta, ka teisel korral" } } },
      { answers: { "a1-fail": { status: "clear", note: "" } } },
    ]);
    expect(server!["a1-fail"]).toBeUndefined();
    expect([state("a1-fail"), note("a1-fail")]).toEqual(["open", null]);
    await click(check("a1-fail").querySelector('[data-answer="bad"]')!);
    expect(puts().at(-1)).toEqual({ answers: { "a1-fail": { status: "bad", note: "" } } }); // (the next press carries none of it)
  });

  test("a „Jäta vahele“ stored before that button went has no half pressed; „Võta vastus tagasi“ takes it back, its note with it", async () => {
    await showAll({ initial: { ...SERVER, "a1-plain": answer("skip", "2026-10-16T09:30:00.000Z", "Maria", "Hiljem") } });
    expect(pressed("a1-plain")).toEqual([]);
    expect(takeBack("a1-plain")!.textContent).toBe("Võta vastus tagasi");
    await click(takeBack("a1-plain")!);
    expect(puts()).toEqual([{ answers: { "a1-plain": { status: "clear", note: "" } } }]);
    expect(note("a1-plain")).toBeNull();
    expect(check("a1-plain").querySelector("[data-check-last]")).toBeNull();
  });

  test("„Võta vastus tagasi“ is the page's one new text, in adminEt", () => {
    expect(adminEt.testplan.takeBack).toBe("Võta vastus tagasi");
  });
});

describe("SaveStatus in place of the outbox line (R-i)", () => {
  test("„✓ Salvestatud“ from the start once the answers were read; „✓ Salvestatud HH:MM“ after a save; „Salvestamata — proovin uuesti“ while one fails", async () => {
    await showAll();
    expect(chip()).toBe("saved");
    expect(chipText()).toBe("✓ Salvestatud");
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

  test("the chip is there from the start, so its first change is spoken: the status region says „Salvestan…“ while the first save is on its way", async () => {
    await showAll();
    const spoken = () => $('[data-save-status] [role="status"]')!.textContent;
    expect(spoken()).toBe("Salvestatud");
    let finish: (r: Response) => void = () => {};
    putReply = () => new Promise<Response>((r) => (finish = r));
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(chip()).toBe("saving");
    expect(spoken()).toBe("Salvestan…");
    await act(async () => finish(json({ ok: true, answers: { ...SERVER, "a1-plain": answer("ok", "2026-10-16T12:00:00.000Z") } })));
    await settle();
    expect(chip()).toBe("saved");
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
    expect(chip()).toBe("saved");
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]); // (nothing waited: the read's flush sends nothing)
  });

  test("signed in again, „Värskenda“ sends the presses kept while signed out, and the chip stops asking her to sign in (review M-2)", async () => {
    await showAll();
    putReply = async () => unauthorized();
    await click(check("a1-plain").querySelector('[data-answer="bad"]')!);
    expect(chip()).toBe("signedOut");
    // she signs in in another tab; back here, she presses „Värskenda“
    putReply = saveOnServer;
    await click($("[data-refresh]")!);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
      { answers: { "a1-plain": { status: "bad", note: "" } } },
      { answers: { "a1-plain": { status: "bad", note: "" } } },
    ]);
    expect(chip()).toBe("saved");
    expect(localStorage.getItem(OUTBOX_KEY)).toBeNull();
    expect(check("a1-plain").querySelector("[data-check-last]")!.textContent).toBe("Maria · 16.10 15:00 · Viga");
  });

  test("the database is down (initial: null): no chip, every check shown open, and a press is kept and retried", async () => {
    await showAll({ initial: null });
    expect(chip()).toBeNull();
    await openAll();
    expect(ids()).toEqual(["a0-done", "a1-redo", "a1-fail", "a1-plain", "a2-fresh", "a2-dim"]);
    expect($$("[data-check-state]").every((c) => c.getAttribute("data-check-state") === "open")).toBe(true);
    expect(unreadLine()).toBe(UNREAD); // (and no counts: Dim 29.10, below)
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
    expect(unreadLine()).toBe(UNREAD);
    expect(chip()).toBeNull(); // (nothing waits, and „Salvestatud“ would say more than is known)
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
    expect(unreadLine()).toBe("");
  });

  test("with the database down at the start, the first good read fills the answers in, and brings the chip", async () => {
    await showAll({ initial: null });
    expect(chip()).toBeNull();
    server = { ...SERVER };
    getReply = () => json({ ok: true, plan: PLAN, answers: server, you: MARIA });
    await click($("[data-refresh]")!);
    expect(chip()).toBe("saved");
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

  // (server side of Task 4 only: no control takes an answer back yet. A clear left on the device is sent, and until the server has said so the page
  // shows the check without the answer the server still holds.)
  test("a clear left on the device by an earlier visit is sent, and the check shows without its answer meanwhile", async () => {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify({ "a1-fail": { status: "clear", note: "", clientAt: "2026-10-16T09:00:00.000Z" } }));
    putReply = async () => json({ ok: false, error: "unavailable" }, 503);
    await showAll();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-fail": { status: "clear", note: "" } } }]);
    expect(state("a1-fail")).toBe("open"); // (the server still holds Dim's Viga)
    expect(check("a1-fail").querySelector("[data-check-last]")).toBeNull();
    expect(localStorage.getItem(OUTBOX_KEY)).not.toBeNull(); // (the save failed: it waits on the device)
  });
});

// Dim 29.10 (review Q1, ruling c2): when the answers cannot be read, the page says so in his words and shows no numbers until a read goes through
// (every check would show „Avatud“, and „… · 0 läbitud · 0 viga“ would be false).
describe("the answers cannot be read (Dim 29.10)", () => {
  /** No number anywhere: no line of counts, the „Olek“ pills by their words, no area progress. */
  const noCounts = () => {
    expect($("[data-progress]")).toBeNull();
    expect(pills("olek")).toEqual(["Kõik", "Avatud", "Viga", "Läbitud"]);
    expect($$("[data-area-count]")).toEqual([]);
    expect($$("[data-area-bar]")).toEqual([]);
  };

  test("the first read fails: the line in a status region, no counts, no chip; the checks and the filters still work", async () => {
    await showAll({ initial: null }); // (the page's read failed, and so does the read on load: 503)
    expect(unreadLine()).toBe(UNREAD);
    expect($("[data-unread]")!.getAttribute("role")).toBe("status");
    noCounts();
    expect(chip()).toBeNull();
    expect($$("[data-area-toggle]").length).toBeGreaterThan(0); // (the areas are there, with their names and ▾)
    await click(olek("open"));
    expect(ids()).toHaveLength(6);
  });

  test("„Värskenda“ fails (a 503, a 500 page, no connection): the line, and the counts go; a 401 is the signed-out state instead", async () => {
    await showAll();
    expect(unreadLine()).toBe("");
    expect(line()).toBe("6 kontrolli · 1 läbitud · 1 viga");
    for (const reply of [() => json({ ok: false, error: "unavailable" }, 503), () => new Response("<html>500</html>", { status: 500 })]) {
      getReply = reply;
      await click($("[data-refresh]")!);
      expect(unreadLine()).toBe(UNREAD);
      noCounts();
    }
    getReply = () => {
      throw new TypeError("Failed to fetch");
    };
    await click($("[data-refresh]")!);
    expect(unreadLine()).toBe(UNREAD);
    getReply = () => json({ ok: true, plan: PLAN, answers: server, auto: {}, you: MARIA }); // (the next page's read on load goes through)
    await remount();
    await showAll();
    getReply = () => unauthorized();
    await click($("[data-refresh]")!);
    expect(unreadLine()).toBe("");
    expect(chip()).toBe("signedOut");
    expect(line()).toBe("6 kontrolli · 1 läbitud · 1 viga");
  });

  test("unread, then a 401 on „Värskenda“: the line and the signed-out chip both show, and no counts come back — both are true (re-review Minor 3)", async () => {
    await showAll({ initial: null });
    expect(unreadLine()).toBe(UNREAD);
    getReply = () => unauthorized();
    await click($("[data-refresh]")!);
    expect(unreadLine()).toBe(UNREAD);
    expect(chip()).toBe("signedOut");
    noCounts();
  });

  test("a read that fails after a save came back with every answer leaves no line: that save is newer than the read (re-review Minor 2)", async () => {
    await showAll();
    let fail: () => void = () => {};
    getReply = () => new Promise<Response>((done) => (fail = () => done(json({ ok: false, error: "unavailable" }, 503))));
    await click($("[data-refresh]")!); // (the read is on its way)
    await openAll();
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!); // (its save comes back with every answer)
    expect(line()).toBe("6 kontrolli · 2 läbitud · 1 viga");
    await act(async () => fail());
    await settle();
    expect(unreadLine()).toBe("");
    expect(line()).toBe("6 kontrolli · 2 läbitud · 1 viga");
    // a read that fails with no save since still says so
    getReply = () => json({ ok: false, error: "unavailable" }, 503);
    await click($("[data-refresh]")!);
    expect(unreadLine()).toBe(UNREAD);
  });

  test("a read that goes through takes the line away and brings the counts back; so does a save that comes back", async () => {
    await showAll({ initial: null });
    expect(unreadLine()).toBe(UNREAD);
    server = { ...SERVER };
    await click($("[data-refresh]")!);
    expect(unreadLine()).toBe("");
    expect(line()).toBe("6 kontrolli · 1 läbitud · 1 viga");
    expect(pills("olek")).toEqual(["Kõik", "Avatud 4", "Viga 1", "Läbitud 1"]);
    expect($$("[data-area-count]").map((c) => c.textContent)).toEqual(["1 / 1", "0 / 3", "0 / 2"]);
    expect(chip()).toBe("saved");
    // the database down again, then a press whose save comes back with every answer
    getReply = () => json({ ok: false, error: "unavailable" }, 503);
    await click($("[data-refresh]")!);
    expect(unreadLine()).toBe(UNREAD);
    await openAll();
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(unreadLine()).toBe("");
    expect(line()).toBe("6 kontrolli · 2 läbitud · 1 viga");
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

// Dim 25.10: a third tester, „Automaattest“, whose answers are kept apart from Maria's and Dim's; the Automaattest session answers in its own right and
// sees every check. Admin polish Part A (Dim 29.10, reversing D10's "never counts" of 25.10): on Maria's and Dim's page its answer is a check's state
// where no person's answer stands (its OK „Läbitud“, its Viga „Viga“, its Jäta vahele open), and its result is a chip in the row's meta line.
describe("Automaattest (Dim 25.10; counts for us since Dim 29.10)", () => {
  const AUTO_ANSWERS: Record<string, PageAnswer> = {
    "a1-redo": answer("bad", "2026-10-14T10:00:00.000Z", "Automaattest"), // before its redo's instant (15.10)
    "a1-fail": answer("ok", "2026-10-16T12:06:00.000Z", "Automaattest"),
    "a1-plain": answer("ok", "2026-10-16T12:05:00.000Z", "Automaattest", "Kõik sammud läbitud."),
  };
  /** And one Viga and one Jäta vahele of its own, on checks nobody else answered. */
  const AUTO_MORE: Record<string, PageAnswer> = {
    ...AUTO_ANSWERS,
    "a2-fresh": answer("bad", "2026-10-16T12:07:00.000Z", "Automaattest", "Nupp puudub."),
    "a2-dim": answer("skip", "2026-10-16T12:08:00.000Z", "Automaattest"),
  };
  const AUTO_YOU = { name: "Automaattest", tester: "auto" as const };
  const autoChip = (id: string) => check(id).querySelector("[data-check-auto]");
  const autoText = (id: string) => autoChip(id)?.textContent ?? null;
  const autoKind = (id: string) => autoChip(id)?.getAttribute("data-check-auto") ?? null;
  const autoNote = (id: string) => check(id).querySelector("[data-check-auto-note]")?.textContent ?? null;
  const word = (id: string) => check(id).querySelector("[data-check-state-word]")!.textContent;
  const puts = () => calls.filter((c) => c.method === "PUT").map((c) => c.body);

  test("for Maria: a check only Automaattest passed is „Läbitud“ in the marker, the line, the pills and the bar, with no half pressed, no note box, no last line", async () => {
    await showAll({ auto: AUTO_ANSWERS });
    await openAll();
    expect([state("a1-plain"), word("a1-plain")]).toEqual(["done", "Läbitud"]);
    expect(pressed("a1-plain")).toEqual([]);
    expect(check("a1-plain").querySelector("[data-check-note]")).toBeNull();
    expect(check("a1-plain").querySelector("[data-check-last]")).toBeNull();
    expect(check("a1-plain").querySelector<HTMLElement>("[data-steps]")!.hidden).toBe(true); // (done: its steps are folded)
    // a0-done Maria's, a1-plain Automaattest's; a1-fail Dim's Viga (his answer wins over Automaattest's OK); a1-redo, a2-fresh, a2-dim open
    expect(line()).toBe("6 kontrolli · 2 läbitud · 1 viga");
    expect(pills("olek")).toEqual(["Kõik", "Avatud 3", "Viga 1", "Läbitud 2"]);
    expect($('[data-area="a1"] [data-area-count]')!.textContent).toBe("1 / 3");
    expect(($('[data-area="a1"] [data-area-bar]') as HTMLElement).style.width).toBe("33%");
    expect([state("a1-fail"), pressed("a1-fail")]).toEqual(["failed", ["bad"]]);
    expect(check("a1-fail").querySelector("[data-check-last]")!.textContent).toBe("Dim · 16.10 14:05 · Viga");
    await click(olek("done"));
    expect(ids()).toEqual(["a0-done", "a1-plain"]);
  });

  test("its result is a chip in the row's meta line — green „Automaattest: Läbitud“, red „Automaattest: Viga“, grey „Automaattest: Jäta vahele“ — and its note stays under the row", async () => {
    await showAll({ auto: AUTO_MORE });
    await openAll();
    expect([autoText("a1-plain"), autoKind("a1-plain")]).toEqual(["Automaattest: Läbitud", "ok"]);
    expect([autoText("a1-fail"), autoKind("a1-fail")]).toEqual(["Automaattest: Läbitud", "ok"]);
    expect([autoText("a2-fresh"), autoKind("a2-fresh")]).toEqual(["Automaattest: Viga", "bad"]);
    expect([autoText("a2-dim"), autoKind("a2-dim")]).toEqual(["Automaattest: Jäta vahele", "skip"]);
    expect(autoChip("a0-done")).toBeNull();
    expect(autoChip("a1-plain")!.closest("[data-check-meta]")).toBe(check("a1-plain").querySelector("[data-check-meta]"));
    // the note, under the row, named
    expect(autoNote("a1-plain")).toBe("Kõik sammud läbitud.");
    expect(check("a1-plain").querySelector("[data-check-auto-note]")!.closest("[data-check-meta]")).toBeNull();
    expect(check("a1-plain").querySelector("[data-check-auto-note]")!.parentElement!.textContent).toBe("Automaattest: Kõik sammud läbitud.");
    expect(autoNote("a1-fail")).toBeNull();
    // its Viga is „Viga“ for us; its Jäta vahele leaves the check open
    expect([state("a2-fresh"), word("a2-fresh"), pressed("a2-fresh")]).toEqual(["failed", "Viga", []]);
    expect(check("a2-fresh").querySelector("[data-check-note]")).toBeNull();
    expect(autoNote("a2-fresh")).toBe("Nupp puudub.");
    expect([state("a2-dim"), word("a2-dim")]).toEqual(["open", "Avatud"]);
    expect(line()).toBe("6 kontrolli · 2 läbitud · 2 viga");
  });

  test("an answer a redo has overtaken is a grey chip in the page's own words, and counts for neither", async () => {
    await showAll({ auto: AUTO_ANSWERS });
    await openAll();
    expect([autoText("a1-redo"), autoKind("a1-redo")]).toEqual(["Automaattest: Varasem vastus (enne muudatust): Viga", "overtaken"]);
    expect(state("a1-redo")).toBe("open");
    expect(check("a1-redo").querySelector("[data-overtaken]")!.textContent).toBe("Varasem vastus (enne muudatust): Läbitud"); // (Dim's own)
  });

  test("Maria's press over its answer is an ordinary answer of hers, and its chip stays", async () => {
    await showAll({ auto: AUTO_ANSWERS });
    await openAll();
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(puts()).toEqual([{ answers: { "a1-plain": { status: "ok", note: "" } } }]);
    expect([state("a1-plain"), pressed("a1-plain")]).toEqual(["done", ["ok"]]);
    expect(autoText("a1-plain")).toBe("Automaattest: Läbitud");
    expect((check("a1-plain").querySelector("[data-check-note]") as HTMLTextAreaElement).value).toBe(""); // (its note is not hers)
    await click(check("a1-plain").querySelector('[data-answer="bad"]')!);
    expect([state("a1-plain"), word("a1-plain")]).toEqual(["failed", "Viga"]);
    expect(line()).toBe("6 kontrolli · 1 läbitud · 2 viga");
  });

  test("Review Focus 5: a person's answer taken back on a check Automaattest passed makes it „Läbitud“ again, Automaattest's — not „Avatud“", async () => {
    await showAll({ auto: AUTO_ANSWERS });
    await openAll();
    await click(check("a1-plain").querySelector('[data-answer="bad"]')!);
    expect(line()).toBe("6 kontrolli · 1 läbitud · 2 viga");
    await click(check("a1-plain").querySelector('[data-answer="bad"]')!); // (the pressed half again)
    expect(puts().at(-1)).toEqual({ answers: { "a1-plain": { status: "clear", note: "" } } });
    expect([state("a1-plain"), word("a1-plain"), pressed("a1-plain")]).toEqual(["done", "Läbitud", []]);
    expect(check("a1-plain").querySelector("[data-check-note]")).toBeNull();
    expect(autoText("a1-plain")).toBe("Automaattest: Läbitud");
    expect(line()).toBe("6 kontrolli · 2 läbitud · 1 viga");
    // and by „Võta vastus tagasi“: Dim's Viga on a1-fail, which Automaattest passed
    await click(check("a1-fail").querySelector("[data-take-back]")!);
    expect([state("a1-fail"), word("a1-fail"), pressed("a1-fail")]).toEqual(["done", "Läbitud", []]);
    expect(line()).toBe("6 kontrolli · 3 läbitud · 0 viga");
    expect(pills("olek")).toEqual(["Kõik", "Avatud 3", "Viga 0", "Läbitud 3"]);
  });

  test("the „Kes“ choice „Automaattest“ shows the checks Automaattest answered and nothing else, counted in „Olek“, and is kept on the device", async () => {
    await showAll({ auto: AUTO_ANSWERS });
    await click(kes("auto"));
    expect(kes("auto").getAttribute("aria-pressed")).toBe("true");
    await openAll();
    expect(ids()).toEqual(["a1-redo", "a1-fail", "a1-plain"]);
    // (a1-redo open again, both its answers from before the redo; a1-fail Dim's Viga; a1-plain Automaattest's OK)
    expect(pills("olek")).toEqual(["Kõik", "Avatud 1", "Viga 1", "Läbitud 1"]);
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
    // its own answer taken back: open (nothing under it to fall back on), and under „Kes: Automaattest“ the row stays until the choice changes
    await click(check("a1-plain").querySelector('[data-answer="bad"]')!);
    expect(puts().at(-1)).toEqual({ answers: { "a1-plain": { status: "clear", note: "" } } });
    expect([state("a1-plain"), word("a1-plain")]).toEqual(["open", "Avatud"]);
    expect(ids()).toEqual(["a1-redo", "a1-fail", "a1-plain"]);
    await click(kes("mina"));
    await click(kes("auto"));
    expect(ids()).toEqual(["a1-redo", "a1-fail"]);
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
