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

// The test page (phase 4, piece 1, Task 3) in a browser-like document (happy-dom), with the API answered here: the progress line, the areas
// (the first with an open check starts open), "Viga" opening its note, a redo answered before its instant, the filters, a database that is down,
// the note's limit, the answers kept on the device and sent again, "Värskenda". And the Avaleht card.

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
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => [...container.querySelectorAll<E>(selector)];
const check = (id: string) => $(`[data-check="${id}"]`)!;
const ids = () => $$("[data-check]").map((c) => c.getAttribute("data-check"));
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
const status = () => $("[data-save-status]")!.textContent;

type Props = { initial?: Record<string, PageAnswer> | null; auto?: Record<string, PageAnswer>; you?: { name: string; tester: "maria" | "dim" | "auto" | null } };
const show = async ({ initial = SERVER, auto, you = MARIA }: Props = {}) => {
  server = initial === null ? null : { ...initial };
  autoServer = { ...(auto ?? {}) };
  await act(async () => root.render(createElement(TestPlan, { plan: PLAN, initial, auto, you, buildAt: BUILD_AT })));
  await settle();
};
/** The view the device remembers (`who` is what the "Kes" filter shows). */
const remember = (view: { filter: string; who: string }) => localStorage.setItem("mslab-testplan-view", JSON.stringify(view));
const showAll = async (props: Props = {}) => {
  remember({ filter: "all", who: "all" });
  await show(props);
};
const openAll = async () => {
  for (const toggle of $$("[data-area-toggle]")) if (toggle.getAttribute("aria-expanded") === "false") await click(toggle);
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

describe("TestPlan", () => {
  test("the progress line counts the checks of the 'Kes' choice: the session's tester by default (his own and the shared ones), everybody's for 'Kõik'", async () => {
    await show();
    // Maria: a0-done (done), a1-fail (koos, bad), a1-plain, a2-fresh (open) — Dim's two are not hers
    expect($("[data-progress]")!.textContent).toBe("1 / 4 tehtud · 1 viga · 0 uuesti testida");
    expect($("[data-you]")!.textContent).toBe("Sina: Maria");
    expect($('[data-who="maria"]')!.getAttribute("aria-pressed")).toBe("true");
    await click($('[data-who="all"]')!);
    // all six: one done, one failed, four open, one of them a redo
    expect($("[data-progress]")!.textContent).toBe("1 / 6 tehtud · 1 viga · 1 uuesti testida");
    await click($('[data-who="koos"]')!);
    expect($("[data-progress]")!.textContent).toBe("0 / 1 tehtud · 1 viga · 0 uuesti testida");
  });

  test("an admin who is neither Maria nor Dim sees every check, and no 'Sina' line", async () => {
    await show({ you: { name: "Kati", tester: null } });
    expect($('[data-who="all"]')!.getAttribute("aria-pressed")).toBe("true");
    expect($("[data-progress]")!.textContent).toBe("1 / 6 tehtud · 1 viga · 1 uuesti testida");
    expect($("[data-you]")).toBeNull();
  });

  test("the first area with an open check starts open, the others closed; a notes-only area is a plain card with its note and no toggle; each area has its count", async () => {
    await showAll();
    expect($$("[data-area-toggle]").map((t) => [t.closest("[data-area]")!.getAttribute("data-area"), t.getAttribute("aria-expanded")])).toEqual([
      ["a0", "false"], // (all its checks are done)
      ["a1", "true"],
      ["a2", "false"],
    ]);
    expect(ids()).toEqual(["a1-redo", "a1-fail", "a1-plain"]); // (a closed area shows no checks)
    const notes = $('[data-area="enne"]')!;
    expect(notes.querySelector("button")).toBeNull();
    expect(notes.textContent).toContain("Enne alustamist");
    expect(notes.textContent).toContain("Logi sisse samas seadmes.");
    expect($('[data-area="a1"]')!.textContent).toContain("Siin on mõned avatud.");
    expect($$("[data-area-toggle]").map((t) => t.textContent)).toEqual(["Tehtud1 / 1", "Pooleli0 / 3", "Uus osa0 / 2"]);
    await click($('[data-area="a2"] [data-area-toggle]')!);
    expect(ids()).toEqual(["a1-redo", "a1-fail", "a1-plain", "a2-fresh", "a2-dim"]);
    await click($('[data-area="a1"] [data-area-toggle]')!);
    expect(ids()).toEqual(["a2-fresh", "a2-dim"]);
  });

  test("a check shows its title, who and device, 'Loob andmeid' when it writes, its mark, 'Ava' in a new tab, its steps as a list, 'Mida näed', and 'Miks' folded", async () => {
    await showAll();
    await openAll();
    const fail = check("a1-fail");
    expect(fail.querySelector("h3")!.textContent).toBe("Kontroll a1-fail");
    expect([...fail.querySelectorAll("[data-chip]")].map((c) => c.textContent)).toEqual(["Koos", "Arvuti", "Loob andmeid"]);
    expect(check("a2-dim").querySelector("[data-mark]")!.textContent).toBe("Sõnastus muutus");
    expect(check("a2-fresh").querySelector("[data-mark]")!.textContent).toBe("Uus");
    expect(check("a1-redo").querySelector("[data-mark]")!.textContent).toBe("Uuesti testida");
    expect(check("a1-plain").querySelector("[data-mark]")).toBeNull();
    expect(fail.querySelector("a[target]")).toBeNull(); // (no href: no "Ava")
    const open = check("a0-done").querySelector<HTMLAnchorElement>("a[target]")!;
    expect(open.textContent).toContain("Ava");
    expect([open.getAttribute("href"), open.getAttribute("target"), open.getAttribute("rel")]).toEqual(["/koolitused", "_blank", "noopener"]);
    expect([...fail.querySelectorAll("ol > li")].map((l) => l.textContent)).toEqual(["Tee seda.", "Tee ka teist."]);
    expect(fail.textContent).toContain("Mida näed");
    expect([...fail.querySelectorAll("ul > li")].map((l) => l.textContent)).toEqual(["Näed seda.", "Näed ka teist."]);
    const why = fail.querySelector("details")!;
    expect(why.open).toBe(false);
    expect(why.querySelector("summary")!.textContent).toBe("Miks");
    expect(why.textContent).toContain("Sest nii on vaja.");
    expect([...fail.querySelectorAll("[data-answer]")].map((b) => b.textContent)).toEqual(["OK", "Viga", "Jäta vahele"]);
  });

  test("the states: failed with its last answer and note, done, open; the last answer reads 'Dim · 16.10 14:05 · Viga' in Tallinn time", async () => {
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
    // the done one, in the closed area it sits in
    expect(state("a0-done")).toBe("done");
    expect(pressed("a0-done")).toEqual(["ok"]);
    expect(check("a0-done").querySelector("[data-check-last]")!.textContent).toBe("Maria · 16.10 13:00 · OK");
  });

  test("a redo answered before its instant is open, with the old answer under it as 'Varasem vastus', and no button pressed", async () => {
    await showAll();
    const redo = check("a1-redo");
    expect(state("a1-redo")).toBe("open");
    expect(redo.querySelector("[data-overtaken]")!.textContent).toBe("Varasem vastus (enne muudatust): OK");
    expect(pressed("a1-redo")).toEqual([]);
    expect(redo.querySelector("[data-check-last]")).toBeNull();
    expect(check("a1-fail").querySelector("[data-overtaken]")).toBeNull();
    // answering it again closes it: the old answer is gone from under it
    await click(redo.querySelector('[data-answer="ok"]')!);
    expect(state("a1-redo")).toBe("done");
    expect(redo.querySelector("[data-overtaken]")).toBeNull();
    expect(pressed("a1-redo")).toEqual(["ok"]);
  });

  test("'Viga' opens the note field and focuses it, asking 'Mis läks valesti?', and sends the answer at once", async () => {
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
    expect(status()).toBe("Salvestatud");
    // the server's answer is the one shown now: the answerer and the hour
    expect(plain.querySelector("[data-check-last]")!.textContent).toBe("Maria · 16.10 15:00 · Viga");
  });

  test("a note typed is sent when the field loses the focus, with the status it was written on; pressing OK later keeps it", async () => {
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
    expect(note.value).toBe("Nupp ei tööta ");
    await click(plain.querySelector('[data-answer="skip"]')!);
    expect(calls.at(-1)!.body).toEqual({ answers: { "a1-plain": { status: "skip", note: "Nupp ei tööta " } } });
  });

  test("a note of 1 001 characters is stopped at 1 000: by maxLength in the field, and in what is sent", async () => {
    await showAll();
    const fail = check("a1-fail");
    const note = fail.querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    expect(NOTE_MAX).toBe(1000);
    expect(note.maxLength).toBe(1000);
    await act(async () => note.focus());
    await typeInto(note, "x".repeat(1001));
    expect(note.value).toHaveLength(1000);
    await act(async () => note.blur());
    await settle();
    expect(calls.at(-1)!.body!.answers["a1-fail"].note).toHaveLength(1000);
  });

  // Dim 22.10 (as on Rempire's test page): every answer has its note box open under it at once; the extra tap on „Märkus“ is gone.
  test("'OK' opens the note box at once, asking 'Märkus', without taking the focus; 'Viga' asks 'Mis läks valesti?'; 'Jäta vahele' opens it too", async () => {
    await showAll();
    const plain = check("a1-plain");
    expect(plain.querySelector("[data-check-note]")).toBeNull(); // (no answer, no box)
    await click(plain.querySelector('[data-answer="ok"]')!);
    const note = plain.querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    expect(note).not.toBeNull();
    expect(note.placeholder).toBe("Märkus");
    expect(note.getAttribute("aria-label")).toBe("Märkus");
    expect(document.activeElement).not.toBe(note); // (a phone's keyboard does not jump up after an OK)
    expect(note.maxLength).toBe(1000);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-plain": { status: "ok", note: "" } } }]);

    await click(plain.querySelector('[data-answer="bad"]')!);
    expect(plain.querySelector<HTMLTextAreaElement>("[data-check-note]")!.placeholder).toBe("Mis läks valesti?");
    expect(document.activeElement).toBe(plain.querySelector("[data-check-note]"));

    await click(plain.querySelector('[data-answer="skip"]')!);
    const skipNote = plain.querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    expect(skipNote).not.toBeNull();
    expect(skipNote.placeholder).toBe("Märkus");
    expect(state("a1-plain")).toBe("done");
    expect(plain.querySelectorAll("[data-check-note]")).toHaveLength(1); // one box, whatever the answer
  });

  test("an answered check shows its note box with no tap on 'Märkus' (there is no such button any more), empty or not", async () => {
    await showAll();
    await openAll();
    const done = check("a0-done"); // an OK with no note
    const note = done.querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    expect(note).not.toBeNull();
    expect(note.value).toBe("");
    expect(note.placeholder).toBe("Märkus");
    expect(done.querySelector("[data-note-toggle]")).toBeNull();
    expect(check("a1-fail").querySelector("[data-note-toggle]")).toBeNull();
    expect($$("[data-note-toggle]")).toHaveLength(0);
    expect(check("a1-fail").querySelector<HTMLTextAreaElement>("[data-check-note]")!.placeholder).toBe("Mis läks valesti?");
    // a check with no answer, and a redo's overtaken answer, have no box (nothing to write a note on yet)
    expect(check("a1-plain").querySelector("[data-check-note]")).toBeNull();
    expect(check("a1-redo").querySelector("[data-check-note]")).toBeNull();
  });

  test("a note typed under an OK is sent when the field loses the focus, with the status it was written on (and under a Jäta vahele too)", async () => {
    await showAll();
    const plain = check("a1-plain");
    await click(plain.querySelector('[data-answer="ok"]')!);
    const note = plain.querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    await act(async () => note.focus()); // (she taps into the box: an OK does not move the focus there)
    await typeInto(note, "Telefonis korras");
    await act(async () => note.blur());
    await settle();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
      { answers: { "a1-plain": { status: "ok", note: "" } } },
      { answers: { "a1-plain": { status: "ok", note: "Telefonis korras" } } },
    ]);
    expect(note.value).toBe("Telefonis korras");
    await click(plain.querySelector('[data-answer="skip"]')!);
    expect(calls.at(-1)!.body).toEqual({ answers: { "a1-plain": { status: "skip", note: "Telefonis korras" } } });
    const again = plain.querySelector<HTMLTextAreaElement>("[data-check-note]")!;
    await act(async () => again.focus());
    await typeInto(again, "Telefonis korras, hiljem tahvlis");
    await act(async () => again.blur());
    await settle();
    expect(calls.at(-1)!.body).toEqual({ answers: { "a1-plain": { status: "skip", note: "Telefonis korras, hiljem tahvlis" } } });
  });

  test("the 'Vead' filter hides the done and the open checks; 'Avatud' keeps the open ones; 'Muudetud' the marked ones; every area with a match is open", async () => {
    await showAll();
    await click($('[data-filter="bad"]')!);
    expect($('[data-filter="bad"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(ids()).toEqual(["a1-fail"]);
    expect($$("[data-area]").map((a) => a.getAttribute("data-area"))).toEqual(["a1"]); // (an area without a match, and the notes, are not shown)
    await click($('[data-filter="open"]')!);
    expect(ids()).toEqual(["a1-redo", "a1-plain", "a2-fresh", "a2-dim"]);
    await click($('[data-filter="changed"]')!);
    expect(ids()).toEqual(["a1-redo", "a2-fresh", "a2-dim"]);
    await click($('[data-filter="all"]')!);
    expect($$("[data-area]").map((a) => a.getAttribute("data-area"))).toEqual(["enne", "a0", "a1", "a2"]);
  });

  test("the 'Kes' choice 'Maria' hides a Dim check and keeps a Koos one", async () => {
    await showAll();
    await openAll();
    expect(ids()).toContain("a1-redo");
    await click($('[data-who="maria"]')!);
    expect(ids()).not.toContain("a1-redo");
    expect(ids()).not.toContain("a2-dim");
    expect(ids()).toContain("a1-fail");
    await click($('[data-who="dim"]')!);
    expect(ids()).toEqual(expect.arrayContaining(["a1-redo", "a1-fail", "a2-dim"]));
    expect(ids()).not.toContain("a1-plain");
    await click($('[data-who="koos"]')!);
    expect(ids()).toEqual([]); // (nothing is open now, so no area starts open)
    await click($('[data-area="a1"] [data-area-toggle]')!);
    expect(ids()).toEqual(["a1-fail"]);
  });

  test("the choice is kept on the device: written to storage, and read by the next visit", async () => {
    await show();
    await click($('[data-filter="open"]')!);
    await click($('[data-who="dim"]')!);
    expect(JSON.parse(localStorage.getItem("mslab-testplan-view")!)).toEqual({ filter: "open", who: "dim" });
    await act(async () => root.unmount());
    root = createRoot(container);
    await show();
    expect($('[data-filter="open"]')!.getAttribute("aria-pressed")).toBe("true");
    expect($('[data-who="dim"]')!.getAttribute("aria-pressed")).toBe("true");
    localStorage.setItem("mslab-testplan-view", "{not json");
    await act(async () => root.unmount());
    root = createRoot(container);
    await show();
    expect($('[data-who="maria"]')!.getAttribute("aria-pressed")).toBe("true"); // (rubbish: the defaults)
  });

  test("a storage that cannot be written still lets the filters work", async () => {
    await show();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await click($('[data-filter="bad"]')!);
    expect(ids()).toEqual(["a1-fail"]);
    set.mockRestore();
  });

  test("the database is down (initial: null): the page says offline, still shows every check, and answers can still be given", async () => {
    await showAll({ initial: null });
    expect(status()).toBe("Vastuseid ei saa praegu salvestada; need on selles seadmes alles.");
    await openAll();
    expect(ids()).toEqual(["a0-done", "a1-redo", "a1-fail", "a1-plain", "a2-fresh", "a2-dim"]);
    expect($$("[data-check-state]").every((c) => c.getAttribute("data-check-state") === "open")).toBe(true);
    expect($("[data-progress]")!.textContent).toBe("0 / 6 tehtud · 0 viga · 0 uuesti testida");
    // the press is kept (the API says 503 again) and shown
    putReply = async () => json({ ok: false, error: "unavailable" }, 503);
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(state("a1-plain")).toBe("done");
    expect(JSON.parse(localStorage.getItem(OUTBOX_KEY)!)["a1-plain"]).toMatchObject({ status: "ok" });
    expect(status()).toBe("Salvestamata — proovin uuesti");
  });

  test("the database is down on a device that cannot keep answers (no storage): no 'offline' text, which would promise they are kept here; a press is retrying", async () => {
    const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      await show({ initial: null, you: { name: "Kati", tester: null } });
      expect(status()).toBe("");
      expect($("[data-save-status]")!.getAttribute("data-save-status")).toBe("idle");
      putReply = async () => json({ ok: false, error: "unavailable" }, 503);
      await openAll();
      await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
      expect(state("a1-plain")).toBe("done");
      expect(status()).toBe("Salvestamata — proovin uuesti");
    } finally {
      blocked.mockRestore();
    }
  });

  test("a GET that is not ok, or not JSON (a 500 page), is the same as the database being down: the plan and the answers stay, the page says offline", async () => {
    await showAll();
    expect(status()).toBe("");
    getReply = () => new Response("<html>Internal Server Error</html>", { status: 500 });
    await click($("[data-refresh]")!);
    expect(status()).toBe("Vastuseid ei saa praegu salvestada; need on selles seadmes alles.");
    await openAll();
    expect(ids()).toHaveLength(6);
    expect(state("a1-fail")).toBe("failed"); // (what was read before is still shown)
    // the connection itself fails
    getReply = () => {
      throw new TypeError("Failed to fetch");
    };
    await click($("[data-refresh]")!);
    expect(status()).toContain("Vastuseid ei saa");
    // the database is back: 'Värskenda' reads again and the notice goes
    server = { ...SERVER, "a1-plain": answer("ok", "2026-10-16T11:30:00.000Z", "Dim") };
    getReply = () => json({ ok: true, plan: PLAN, answers: server, you: MARIA });
    await click($("[data-refresh]")!);
    expect(status()).toBe("");
    expect(state("a1-plain")).toBe("done");
  });

  test("with the database down at the start, the first good read fills the answers in", async () => {
    await showAll({ initial: null });
    expect(status()).toContain("Vastuseid ei saa");
    server = { ...SERVER };
    getReply = () => json({ ok: true, plan: PLAN, answers: server, you: MARIA });
    await click($("[data-refresh]")!);
    expect(status()).toBe("");
    await openAll();
    expect(state("a1-fail")).toBe("failed");
  });

  test("every load reads the answers again, and 'Värskenda' reads them again: what the other admin answered shows without a reload", async () => {
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
    expect(status()).toBe("Salvestamata — proovin uuesti");
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
    expect(check("a1-plain").querySelector("[data-check-last]")!.textContent).toBe("Maria · 16.10 15:00 · OK"); // (the save's answer)
    await act(async () => release(stale));
    await settle();
    expect(state("a1-plain")).toBe("done"); // (the read saw the answers before the save)
    expect(check("a1-plain").querySelector("[data-check-last]")).not.toBeNull();
  });

  test("answers left on the device by an earlier visit are sent at once and shown", async () => {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify({ "a1-plain": { status: "bad", note: "Jäi saatmata", clientAt: "2026-10-16T09:00:00.000Z" } }));
    await showAll();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-plain": { status: "bad", note: "Jäi saatmata" } } }]);
    expect(state("a1-plain")).toBe("failed");
    expect(localStorage.getItem(OUTBOX_KEY)).toBeNull();
  });

  test("the save status: saved after a send, retrying while it fails", async () => {
    await showAll();
    expect(status()).toBe("");
    await click(check("a1-plain").querySelector('[data-answer="ok"]')!);
    expect(status()).toBe("Salvestatud");
    expect($("[data-save-status]")!.getAttribute("data-save-status")).toBe("saved");
    putReply = async () => {
      throw new TypeError("Failed to fetch");
    };
    await click($('[data-area="a2"] [data-area-toggle]')!);
    await click(check("a2-fresh").querySelector('[data-answer="skip"]')!);
    expect(status()).toBe("Salvestamata — proovin uuesti");
    expect($("[data-save-status]")!.getAttribute("data-save-status")).toBe("retrying");
    expect(pressed("a2-fresh")).toEqual(["skip"]); // (her press is shown all the same)
  });

  test("a link to a check (#id) opens its area and shows the check, whatever the filters say", async () => {
    window.location.hash = "#a2-fresh";
    await show({ you: { name: "Dim", tester: "dim" } }); // (Dim's view hides Maria's checks)
    expect(ids()).toContain("a2-fresh");
    expect($('[data-area="a2"] [data-area-toggle]')!.getAttribute("aria-expanded")).toBe("true");
  });

  test("a check called 'constructor' or 'valueOf' is not answered because Object.prototype has such a member", async () => {
    const plan: Plan = { ...PLAN, areas: [{ id: "a", name: "Osa" }], items: [item("constructor", "a", "maria"), item("valueOf", "a", "maria")] };
    server = {};
    await act(async () => root.render(createElement(TestPlan, { plan, initial: {}, you: MARIA, buildAt: BUILD_AT })));
    await settle();
    expect($$("[data-check-state]").map((c) => c.getAttribute("data-check-state"))).toEqual(["open", "open"]);
    expect($("[data-progress]")!.textContent).toBe("0 / 2 tehtud · 0 viga · 0 uuesti testida");
  });
});

describe("a tap while the page is still loading", () => {
  /** Lets the page's work run with no act() around it (the tap below must land between the hydration and what its effects set). */
  const ticks = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };

  test("a tap that hydration replays (the page's effects have not drawn yet) is sent; a Viga then, and the note typed after it, are saved as Viga with that note", async () => {
    // a1-plain holds an OK with a note; an admin who sees every check, so the area a1 is open in the server's HTML as well
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

  test("for Maria: one quiet line „Automaattest: OK · 16.10 15:05“ under each check it answered, with its note; her own answers and counts are as without it", async () => {
    // (the page's own numbers, states and last answers: what Automaattest's answers must leave as they are)
    const seen = () => ({ progress: $("[data-progress]")!.textContent, states: ids().map((id) => state(id!)), last: $$("[data-check-last]").map((p) => p.textContent) });
    await showAll();
    await openAll();
    const without = seen();
    await act(async () => root.unmount());
    root = createRoot(container);

    await showAll({ auto: AUTO_ANSWERS });
    await openAll();
    expect(autoLine("a1-plain")).toBe("Automaattest: OK · 16.10 15:05");
    expect(autoNote("a1-plain")).toBe("Kõik sammud läbitud.");
    expect(autoLine("a1-fail")).toBe("Automaattest: OK · 16.10 15:06");
    expect(autoNote("a1-fail")).toBeNull();
    expect(autoLine("a0-done")).toBeNull();
    // never her answer: a1-plain stays open with no button pressed, a1-fail stays her Viga
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
    await click(check("a1-plain").querySelector('[data-answer="skip"]')!);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-plain": { status: "skip", note: "" } } }]);
    expect(state("a1-plain")).toBe("done");
    expect(autoLine("a1-plain")).toBe("Automaattest: OK · 16.10 15:05");
    expect((check("a1-plain").querySelector("[data-check-note]") as HTMLTextAreaElement).value).toBe(""); // (its note is not hers)
  });

  test("the 'Kes' choice „Automaattest“ shows the checks Automaattest answered and nothing else, and is kept on the device", async () => {
    await showAll({ auto: AUTO_ANSWERS });
    const pill = $('[data-who="auto"]')!;
    expect(pill.textContent).toBe("Automaattest");
    expect($$("[data-who]").map((b) => b.textContent)).toEqual(["Kõik", "Maria", "Dim", "Koos", "Automaattest"]);
    await click(pill);
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    await openAll();
    expect(ids()).toEqual(["a1-redo", "a1-fail", "a1-plain"]);
    expect(JSON.parse(localStorage.getItem("mslab-testplan-view")!)).toEqual({ filter: "all", who: "auto" });
  });

  test("the Automaattest session sees every check (Kes: Kõik) as „Sina: Automaattest“, its own answers as the checks' answers and no quiet line; a press saves its answer", async () => {
    await show({ initial: AUTO_ANSWERS, auto: AUTO_ANSWERS, you: AUTO_YOU });
    expect($('[data-who="all"]')!.getAttribute("aria-pressed")).toBe("true");
    expect($("[data-you]")!.textContent).toBe("Sina: Automaattest");
    await openAll();
    expect(ids()).toEqual(["a0-done", "a1-redo", "a1-fail", "a1-plain", "a2-fresh", "a2-dim"]);
    // its own: a1-fail and a1-plain done, a1-redo open over its overtaken Viga, the rest open
    expect($("[data-progress]")!.textContent).toBe("2 / 6 tehtud · 0 viga · 1 uuesti testida");
    expect($$("[data-check-auto]")).toEqual([]);
    expect(pressed("a1-plain")).toEqual(["ok"]);
    expect(check("a1-plain").querySelector("[data-check-last]")!.textContent).toBe("Automaattest · 16.10 15:05 · OK");
    expect(check("a1-redo").querySelector("[data-overtaken]")!.textContent).toBe("Varasem vastus (enne muudatust): Viga");
    await click(check("a1-plain").querySelector('[data-answer="bad"]')!);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ answers: { "a1-plain": { status: "bad", note: "Kõik sammud läbitud." } } }]);
    // its „Kes: Automaattest“ is the checks it answered
    await click($('[data-who="auto"]')!);
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
