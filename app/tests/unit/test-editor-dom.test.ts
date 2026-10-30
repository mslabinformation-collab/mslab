// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TestEditor, type TestErrors } from "@/components/admin/TestEditor";
import { UndoProvider } from "@/components/admin/UndoBar";
import type { TestQuestion } from "@/db/schema";
import { emptyTestDraft, type TestDraft } from "@/domain/course-editor";

// "Teadmiste test" in the course editor (e-course completion, spec §5.1): the pass mark and the tries as typed, a card per question with its kind,
// its text and (a choice question) 2–6 options each with "Õige"; add, move and remove with the focus kept; the save's refusal shown in the card
// of the question it names (and on its option), or under the list.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let current: TestDraft;
/** The page changes the questions itself (another tab's text read again, the cards started over): set from outside the editor. */
let fromOutside: (fn: (v: TestDraft) => TestDraft) => void = () => {};
let mounts = 0;
/** The question list's changes asked for through `onUpdate` (a question added, moved or removed, an option removed, an undo). */
const updates = vi.fn();
function Harness({ initial, errors, unpublished }: { initial: TestDraft; errors: TestErrors; unpublished?: { questions?: boolean } }) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    current = value; // (not during the render: react-hooks/globals; act() flushes the effect)
    fromOutside = setValue;
  }, [value]);
  const onUpdate = (fn: (questions: TestQuestion[]) => TestQuestion[]) => {
    updates();
    setValue((v) => ({ ...v, questions: fn(v.questions) }));
  };
  return createElement(TestEditor, { value, onChange: setValue, onUpdate, errors, unpublished });
}
// a new key each time: a new editor, as the course editor's reload gives one
const render = async (initial: TestDraft, errors: TestErrors = {}, unpublished?: { questions?: boolean }) =>
  act(async () => root.render(createElement(UndoProvider, null, createElement(Harness, { key: ++mounts, initial, errors, unpublished }))));
const $ = <T extends Element = HTMLElement>(selector: string) => container.querySelector<T>(selector);
const $$ = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const click = async (el: Element | null) => act(async () => (el as HTMLElement).click());
const type = async (el: Element | null, value: string) =>
  act(async () => {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
const choice = (id: string, text: string, options: [string, boolean][]): TestQuestion => ({
  id,
  kind: "choice",
  text,
  options: options.map(([t, correct], j) => ({ id: `o${id.slice(1, 7)}${j}`, text: t, correct })),
});
const draft = (questions: TestQuestion[]): TestDraft => ({ ...emptyTestDraft(), questions });

beforeEach(() => {
  updates.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("'Lisa küsimus' adds a choice question with two options, its text takes the focus; the text, the options and 'Õige' go into the draft", async () => {
  await render(emptyTestDraft());
  const editor = $("[data-test-editor]")!;
  expect(editor.querySelector("h3")!.textContent).toBe("Teadmiste test");
  expect(editor.textContent).toContain("Muudatused kehtivad uutele katsetele; tehtud katsed jäävad nii, nagu need esitati.");
  expect(editor.textContent).toContain("Küsimusi veel pole");
  await click($("[data-question-add]"));
  expect($$("[data-question]")).toHaveLength(1);
  const text = $<HTMLTextAreaElement>('[data-question="0"] [data-question-text]')!;
  expect(document.activeElement).toBe(text);
  expect(container.querySelector(`label[for="${text.id}"]`)!.textContent).toBe("Küsimus 1");
  const [q] = current.questions;
  expect(q).toMatchObject({ kind: "choice", text: "", options: [{ text: "", correct: false }, { text: "", correct: false }] });
  if (q.kind !== "choice") throw new Error("a new question is a choice question");
  const ids = [q.id, ...q.options.map((o) => o.id)];
  expect(ids.every((id) => /^[0-9a-z]{8}$/.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(3);
  await type(text, "Mitu kihti värvi kanname?");
  await type($('[data-question="0"] [data-option="0"] [data-option-text]'), "Ühe");
  await type($('[data-question="0"] [data-option="1"] [data-option-text]'), "Kaks");
  await click($('[data-question="0"] [data-option="1"] [data-option-correct]'));
  expect(current.questions).toEqual([
    { id: q.id, kind: "choice", text: "Mitu kihti värvi kanname?", options: [{ id: q.options[0].id, text: "Ühe", correct: false }, { id: q.options[1].id, text: "Kaks", correct: true }] },
  ]);
  // no browser cut: a pasted text over the limit is refused by the save with a field error in place (testTooLong), never silently shortened
  expect(text.hasAttribute("maxlength")).toBe(false);
  expect($('[data-question="0"] [data-option="0"] [data-option-text]')!.hasAttribute("maxlength")).toBe(false);
});

test("a choice question has 2–6 options: × is off at two, '+ Lisa vastusevariant' is off at six; a new option's field takes the focus", async () => {
  await render(draft([choice("q0000001", "Mis?", [["A", true], ["B", false]])]));
  const card = () => $('[data-question="0"]')!;
  const options = () => card().querySelectorAll("[data-option]");
  expect(card().querySelector("[data-option-remove]")!.getAttribute("aria-disabled")).toBe("true");
  await click(card().querySelector("[data-option-remove]"));
  expect(options()).toHaveLength(2);
  await click(card().querySelector("[data-option-add]"));
  expect(options()).toHaveLength(3);
  expect(document.activeElement).toBe(card().querySelector('[data-option="2"] [data-option-text]'));
  for (let k = 0; k < 3; k++) await click(card().querySelector("[data-option-add]"));
  expect(options()).toHaveLength(6);
  expect(card().querySelector("[data-option-add]")!.getAttribute("aria-disabled")).toBe("true");
  await click(card().querySelector("[data-option-add]"));
  expect(options()).toHaveLength(6);
  const before = current.questions[0];
  if (before.kind !== "choice") throw new Error("a choice question");
  await click(card().querySelector('[data-option="1"] [data-option-remove]'));
  const after = current.questions[0];
  expect(after.kind === "choice" ? after.options.map((o) => o.id) : []).toEqual([before.options[0].id, ...before.options.slice(2).map((o) => o.id)]);
});

test("'Vaba vastusega' has no options and says how it is assessed; back to 'Valikvastustega' brings the options back", async () => {
  const q = choice("q0000001", "Mis kuulub ettevalmistusse?", [["Puhastamine", true], ["Värvimine", false], ["Kuju määramine", true]]);
  await render(draft([q]));
  expect($<HTMLInputElement>('[data-question="0"] [data-question-kind="choice"]')!.checked).toBe(true);
  await click($('[data-question="0"] [data-question-kind="open"]'));
  expect(current.questions).toEqual([{ id: "q0000001", kind: "open", text: "Mis kuulub ettevalmistusse?" }]);
  expect($$('[data-question="0"] [data-option]')).toHaveLength(0);
  expect($('[data-question="0"]')!.textContent).toContain("Õpilane kirjutab vastuse ise");
  await click($('[data-question="0"] [data-question-kind="choice"]'));
  expect(current.questions).toEqual([q]);
});

test("questions move ↑ / ↓ (off at the ends) and go with ×, the focus kept; at 50 'Lisa küsimus' adds nothing and says so", async () => {
  const a = choice("q0000001", "Esimene", [["A", true], ["B", false]]);
  const b: TestQuestion = { id: "q0000002", kind: "open", text: "Teine" };
  await render(draft([a, b]));
  // the list editors' order control (DragList, Task 8): the handle „Lohista rida {n}“ (S3-P3-m); the arrows keep the questions' own words (review M-1)
  expect($('[data-question="0"] [data-drag-tool="up"]')!.getAttribute("aria-disabled")).toBe("true");
  expect($('[data-question="1"] [data-drag-tool="down"]')!.getAttribute("aria-disabled")).toBe("true");
  expect($('[data-question="1"] [data-drag-tool="up"]')!.getAttribute("aria-label")).toBe("Liiguta küsimus 2 üles");
  expect($('[data-question="0"] [data-drag-tool="down"]')!.getAttribute("aria-label")).toBe("Liiguta küsimus 1 alla");
  expect($('[data-question="1"] [data-drag-tool="handle"]')!.getAttribute("aria-label")).toBe("Lohista rida 2");
  await click($('[data-question="1"] [data-drag-tool="up"]'));
  expect(current.questions.map((q) => q.id)).toEqual(["q0000002", "q0000001"]);
  expect(document.activeElement).toBe($('[data-question="0"] [data-drag-tool="up"]'));
  expect($('[data-question="0"] [data-question-remove]')!.getAttribute("aria-label")).toBe("Eemalda küsimus 1");
  await click($('[data-question="0"] [data-question-remove]'));
  expect(current.questions.map((q) => q.id)).toEqual(["q0000001"]);
  expect(document.activeElement).toBe($('[data-question="0"] [data-question-text]'));
  await click($('[data-question="0"] [data-question-remove]'));
  expect(current.questions).toEqual([]);
  expect(document.activeElement).toBe($("[data-question-add]"));

  await render(draft(Array.from({ length: 50 }, (_, i): TestQuestion => ({ id: `q${String(i + 1).padStart(7, "0")}`, kind: "open", text: `Küsimus ${i + 1}` }))));
  const add = $("[data-question-add]")!;
  expect(add.getAttribute("aria-disabled")).toBe("true");
  await click(add);
  expect(current.questions).toHaveLength(50);
  expect($("[data-test-editor]")!.textContent).toContain("Rohkem kui 50 küsimust ei saa lisada.");
});

test("the pass mark and the tries are typed into the draft as text; their refusals are marked on the field", async () => {
  await render(emptyTestDraft());
  expect($<HTMLInputElement>("[data-test-pass]")!.value).toBe("80");
  expect($<HTMLInputElement>("[data-test-tries]")!.value).toBe("3");
  await type($("[data-test-pass]"), "90");
  await type($("[data-test-tries]"), "2");
  expect(current).toMatchObject({ passPercent: "90", tries: "2" });
  await render(emptyTestDraft(), { testPassPercent: "Sisesta täisarv.", testTries: "Sisesta täisarv." });
  for (const selector of ["[data-test-pass]", "[data-test-tries]"]) {
    const input = $(selector)!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const errorId = input.getAttribute("aria-describedby")!.split(" ")[1];
    expect(document.getElementById(errorId)!.textContent).toBe("Sisesta täisarv.");
  }
});

test("the save's refusal is shown where it is: in the question's card (its option marked), or under the list", async () => {
  const qs = [choice("q0000001", "Esimene", [["A", true], ["B", false]]), choice("q0000002", "Teine", [["A", false], ["B", false]])];
  // (keyed by the question's and the option's id, not by their places: README B2 "errors keyed by row id")
  await render(draft(qs), { test: "Märgi vähemalt üks vastus õigeks.", at: { question: "q0000002" } });
  expect($('[data-question="1"]')!.hasAttribute("data-invalid")).toBe(true);
  expect($('[data-question="1"]')!.textContent).toContain("Märgi vähemalt üks vastus õigeks.");
  expect($('[data-question="0"]')!.hasAttribute("data-invalid")).toBe(false);
  expect($("[data-test-editor]")!.hasAttribute("data-invalid")).toBe(false);

  await render(draft(qs), { test: "Täida küsimuse tekst ja iga vastusevariant.", at: { question: "q0000001", option: "o0000001" } });
  expect($('[data-question="0"] [data-option="1"] [data-option-text]')!.getAttribute("aria-invalid")).toBe("true");
  expect($('[data-question="0"] [data-option="0"] [data-option-text]')!.hasAttribute("aria-invalid")).toBe(false);

  // the whole list, or a question that is no longer there: under the list
  for (const at of [undefined, { question: "q0000009" }]) {
    await render(draft(qs), { test: "Testis saab olla kuni 50 küsimust.", at });
    expect($("[data-test-editor]")!.hasAttribute("data-invalid")).toBe(true);
    expect($$("[data-question][data-invalid]")).toHaveLength(0);
    expect($("[data-test-editor]")!.textContent).toContain("Testis saab olla kuni 50 küsimust.");
  }
});

// Task 8 (admin UX pass piece 3a; README B2, BEH B5, S3-P3-d): × at once with the UndoBar, the question or the option back with its id

const bar = () => document.querySelector<HTMLElement>("[data-undo-bar]");
const undoIt = () => click(bar()!.querySelector("button"));

test("a removed test question comes back at its place with its original question id, and its options keep theirs („Küsimus eemaldatud.“)", async () => {
  const a = choice("q0000001", "Esimene", [["A", true], ["B", false]]);
  const b = choice("q0000002", "Teine", [["C", false], ["D", true], ["E", false]]);
  const c: TestQuestion = { id: "q0000003", kind: "open", text: "Kolmas" };
  await render(draft([a, b, c]));
  await click($('[data-question="1"] [data-question-remove]'));
  expect(current.questions.map((q) => q.id)).toEqual(["q0000001", "q0000003"]);
  expect(bar()!.querySelector("p")!.textContent).toBe("Küsimus eemaldatud.");
  expect(document.activeElement).toBe($('[data-question="1"] [data-question-text]'));
  await undoIt();
  expect(current.questions).toEqual([a, b, c]);
  expect(updates).toHaveBeenCalledTimes(2);
  // the row is the question's own again (its key is its id), with its three options
  expect($$('[data-question="1"] [data-option]')).toHaveLength(3);
  expect($('[data-question="1"]')!.closest("[data-drag-row]")!.getAttribute("data-drag-row")).toBe("q0000002");
});

test("an answer option removed says „Vastusevariant eemaldatud.“; the undo puts it back at its place with its id", async () => {
  const q = choice("q0000001", "Mis?", [["A", true], ["B", false], ["C", false]]);
  await render(draft([q]));
  await click($('[data-question="0"] [data-option="1"] [data-option-remove]'));
  const after = current.questions[0];
  expect(after.kind === "choice" ? after.options.map((o) => o.text) : []).toEqual(["A", "C"]);
  expect(bar()!.querySelector("p")!.textContent).toBe("Vastusevariant eemaldatud.");
  await undoIt();
  expect(current.questions).toEqual([q]);
});

test("the undo goes into the list as it is then: a question typed in meanwhile keeps its text, a question added meanwhile stays", async () => {
  const a = choice("q0000001", "Esimene", [["A", true], ["B", false]]);
  const b: TestQuestion = { id: "q0000002", kind: "open", text: "Teine" };
  await render(draft([a, b]));
  await click($('[data-question="0"] [data-question-remove]'));
  await type($('[data-question="0"] [data-question-text]'), "Teine, parandatud");
  await click($("[data-question-add]"));
  await undoIt();
  expect(current.questions).toHaveLength(3);
  expect(current.questions[0]).toEqual(a);
  expect(current.questions[1]).toEqual({ ...b, text: "Teine, parandatud" });
  expect(current.questions[2].id).not.toBe("q0000001");
});

test("an error on question X stays on X after a move (keyed by its id, not its place)", async () => {
  const a = choice("q0000001", "Esimene", [["A", true], ["B", false]]);
  const b = choice("q0000002", "Teine", [["A", false], ["B", false]]);
  await render(draft([a, b]), { test: "Märgi vähemalt üks vastus õigeks.", at: { question: "q0000002" } });
  expect($('[data-question="1"]')!.hasAttribute("data-invalid")).toBe(true);
  await click($('[data-question="1"] [data-drag-tool="up"]'));
  expect(current.questions.map((q) => q.id)).toEqual(["q0000002", "q0000001"]);
  // the words moved with the question
  expect($('[data-question="0"]')!.hasAttribute("data-invalid")).toBe(true);
  expect($('[data-question="0"]')!.textContent).toContain("Märgi vähemalt üks vastus õigeks.");
  expect($('[data-question="1"]')!.hasAttribute("data-invalid")).toBe(false);
  expect($('[data-question="1"]')!.textContent).not.toContain("Märgi vähemalt üks vastus õigeks.");
});

test("„· avaldamata“ after „Teadmiste test“ while the questions wait for „Avalda muudatused“", async () => {
  await render(draft([choice("q0000001", "Esimene", [["A", true], ["B", false]])]), {}, { questions: true });
  const group = $("[data-test-editor]")!;
  const tag = group.querySelector<HTMLElement>("h3 [data-unpublished-tag]")!;
  expect(tag.textContent).toBe("· avaldamata");
  expect(group.getAttribute("aria-describedby")!.split(" ")).toContain(tag.id);
  await render(draft([]));
  expect($("h3 [data-unpublished-tag]")).toBeNull();
});

test("the undo's focus goes to the question that came back, by its id, also when the list changed meanwhile (review M-7)", async () => {
  const a: TestQuestion = { id: "q0000001", kind: "open", text: "Esimene" };
  const b: TestQuestion = { id: "q0000002", kind: "open", text: "Teine" };
  const c: TestQuestion = { id: "q0000003", kind: "open", text: "Kolmas" };
  await render(draft([a, b, c]));
  await click($('[data-question="2"] [data-question-remove]'));
  // the page reads the questions again meanwhile: one fewer (the place 3 is no longer there)
  await act(async () => fromOutside((v) => ({ ...v, questions: [a] })));
  const undo = bar()!.querySelector<HTMLElement>("button")!;
  undo.focus();
  await click(undo);
  expect(current.questions.map((q) => q.id)).toEqual(["q0000001", "q0000003"]);
  expect(document.activeElement).toBe($('[data-question="1"] [data-question-text]'));
});

// the admin polish sweep (Task 6; Task 1 left it): a question's text box grows with its text, as the list rows' boxes do (GrowingText), so a long
// question is read whole and not in a scrolling box; it has no grip, which the next measure would undo
test("a question's text box grows with its text: its height is the text's, measured again as it is typed; no grip", async () => {
  // no layout in happy-dom: a text box's content is 46 px for a short text, 130 px for a long one
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return this.value.length > 40 ? 130 : 46;
    },
  });
  try {
    await render(draft([{ id: "q0000001", kind: "open", text: "Lühike küsimus" }]));
    const box = $<HTMLTextAreaElement>('[data-question="0"] [data-question-text]')!;
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.style.height).toBe("48px");
    await type(box, "Kirjelda, kuidas valid kliendi näo kuju ja kulmude kasvusuuna järgi sobiva vormi ning värvi, ja mida ütled talle järelhoolduse kohta.");
    expect($<HTMLTextAreaElement>('[data-question="0"] [data-question-text]')!.style.height).toBe("132px");
    expect(current.questions[0]).toMatchObject({ text: expect.stringContaining("järelhoolduse") });
  } finally {
    delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
  }
  const css = (await import("node:fs")).readFileSync(`${process.cwd()}/src/components/admin/TestEditor.module.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css.replace(/\s+/g, " ")).toContain(".body [data-question-text] { resize: none; }");
});

// the admin polish sweep (Task 6): an option's „Õige“ is one word on a 44 px label with no padding over it, so its box and word stand in its middle,
// level with the option's field and × (editor .check tops them for a label of several lines; they were 11 px above the field's middle)
test("an option's „Õige“ box and word are in the middle of its label, level with the field and ×", async () => {
  const css = (await import("node:fs")).readFileSync(`${process.cwd()}/src/components/admin/TestEditor.module.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(/\.correct \{([^}]*)\}/.exec(css.replace(/\s+/g, " "))?.[1].trim()).toBe("align-items: center; padding: 0 4px; white-space: nowrap;");
  await render(draft([choice("q0000001", "Esimene", [["A", true], ["B", false]])]));
  const label = $('[data-option="0"] [data-option-correct]')!.closest("label")!;
  expect(label.className).toMatch(/correct/);
  expect(label.className).toMatch(/check/);
});
