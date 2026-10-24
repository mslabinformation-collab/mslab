// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProtocolStagesEditor } from "@/components/admin/ProtocolStagesEditor";
import { UndoProvider } from "@/components/admin/UndoBar";

// "Protokolli punktid" in the course editor (phase protocols, spec §3): one plain field per heading, in order, with ↑ / ↓ / ×, "Lisa punkt",
// at most 30 (the button says so then), each field at most 120 characters. And the same editor for the e-course certificate's lines (phase
// 3d, spec §6: kind "skills"): its own title, labels, limit (16) and data hooks, so an e-course's editor tells its two lists apart.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Opts = { kind?: "stages" | "skills"; hint?: string; empty?: string; outcomes?: { et: string }[]; unpublished?: boolean };

let container: HTMLDivElement;
let root: Root;
let current: string[] = [];
/** The row changes asked for through `onUpdate` (add, move, remove, undo): each one a save of the card. */
const updates = vi.fn();
function Harness({ initial, kind, hint, empty, outcomes, unpublished }: { initial: string[] } & Opts) {
  const [items, setItems] = useState(initial);
  useEffect(() => {
    current = items; // (not during the render: react-hooks/globals; act() flushes the effect)
  }, [items]);
  const onUpdate = (fn: (list: string[]) => string[]) => {
    updates();
    setItems((list) => fn(list));
  };
  return createElement(ProtocolStagesEditor, { items, onChange: setItems, onUpdate, kind, hint, empty, outcomes, unpublished });
}
// a new key for each list: a new editor, as the course editor's reload gives one
const render = async (initial: string[], opts: Opts = {}) =>
  act(async () =>
    root.render(createElement(UndoProvider, null, createElement(Harness, { key: `${opts.kind ?? "stages"}:${initial.join("|")}:${opts.unpublished ?? ""}`, initial, ...opts }))),
  );
const fields = (hook = "data-protocol-stage") => [...container.querySelectorAll<HTMLInputElement>(`[${hook}]`)];
const click = async (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

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

test("add, type, move and remove; the new field takes the focus; each field is labelled and takes at most 120 characters", async () => {
  await render(["Ettevalmistus"]);
  await click(container.querySelector("[data-add-stage]"));
  expect(fields()).toHaveLength(2);
  expect(document.activeElement).toBe(fields()[1]);
  await type(fields()[1], "Värvimine");
  expect(current).toEqual(["Ettevalmistus", "Värvimine"]);
  expect(fields()[1].maxLength).toBe(120);
  expect(container.querySelector(`label[for="${fields()[1].id}"]`)?.textContent).toBe("Punkt 2");
  await click(container.querySelector('[aria-label="Liiguta rida 2 üles"]'));
  expect(current).toEqual(["Värvimine", "Ettevalmistus"]);
  await click(container.querySelector('[aria-label="Eemalda rida 1"]'));
  expect(current).toEqual(["Ettevalmistus"]);
});

test("none yet says what the protocol has then; at 30 'Lisa punkt' adds nothing and says so", async () => {
  await render([]);
  expect(container.textContent).toContain("Punkte veel pole");
  await render(Array.from({ length: 30 }, (_, i) => `Punkt ${i + 1}`));
  const add = container.querySelector("[data-add-stage]")!;
  expect(add.getAttribute("aria-disabled")).toBe("true");
  await click(add);
  expect(current).toHaveLength(30);
  expect(container.textContent).toContain("Rohkem kui 30 punkti ei saa lisada.");
});

test("the certificate's lines (kind 'skills') own their default hint and empty line: no protocol wording shows where the caller gives none", async () => {
  await render([], { kind: "skills" });
  expect(container.textContent).toContain("Tühjana kasutatakse „Õpiväljundid“ ridu");
  expect(container.textContent).toContain("Ridu pole: tunnistusel on kaardi „Õpiväljundid“ read.");
  expect(container.textContent).not.toMatch(/protokoll|Punkte veel pole/i);
  expect(container.textContent).not.toContain("Mida õpid"); // one name for the list: the card Maria fills is „Õpiväljundid“ (M-7)
  await render([], { kind: "stages" }); // and the stages' own defaults are as they were
  expect(container.textContent).toContain("Punkte veel pole");
  expect(container.textContent).not.toContain("Õpiväljundid");
});

test("the certificate's lines (kind 'skills'): their own title, labels and hooks, the hint and the empty line given; at 16 'Lisa rida' adds nothing and says so", async () => {
  await render([], { kind: "skills", hint: "Tühjana kasutatakse „Õpiväljundid“ ridu", empty: "Ridu pole: tunnistusel on kaardi „Õpiväljundid“ read." });
  expect(container.querySelector("[data-protocol-stages]")).toBeNull();
  expect(container.querySelector("[data-add-stage]")).toBeNull();
  expect(container.querySelector("[data-certificate-skills] h3")!.textContent).toBe("Oskused tunnistusel");
  expect(container.textContent).toContain("Tühjana kasutatakse „Õpiväljundid“ ridu");
  expect(container.textContent).toContain("Ridu pole: tunnistusel on kaardi „Õpiväljundid“ read.");
  const add = container.querySelector("[data-add-skill]")!;
  expect(add.textContent).toBe("+ Lisa rida");
  await click(add);
  const [first] = fields("data-certificate-skill");
  expect(first.getAttribute("data-certificate-skill")).toBe("0");
  expect(document.activeElement).toBe(first);
  expect(first.maxLength).toBe(120);
  expect(container.querySelector(`label[for="${first.id}"]`)?.textContent).toBe("Rida 1");
  await type(first, "Kulmude kuju");
  expect(current).toEqual(["Kulmude kuju"]);

  await render(Array.from({ length: 16 }, (_, i) => `Oskus ${i + 1}`), { kind: "skills" });
  const full = container.querySelector("[data-add-skill]")!;
  expect(full.getAttribute("aria-disabled")).toBe("true");
  await click(full);
  expect(current).toHaveLength(16);
  expect(container.textContent).toContain("Rohkem kui 16 rida ei saa lisada.");
});

test("M-4: no line of its own, so the certificate prints the course's outcomes, and one of them is over 120 characters: a warning says to add shorter lines here; nothing is cut", async () => {
  const WARNING = "Tunnistusele lähevad õpiväljundid. Mõni neist on üle 120 tähemärgi ega mahu tunnistusele: lisa siia lühemad read.";
  const long = { et: "Kulmude kuju " + "x".repeat(108) }; // 121 characters
  const warning = () => container.querySelector<HTMLElement>("[data-certificate-long]");
  await render([], { kind: "skills", outcomes: [{ et: "Kulmude kuju" }, long] });
  expect(warning()!.textContent).toBe(WARNING);
  const group = container.querySelector("[data-certificate-skills]")!;
  expect(group.getAttribute("aria-describedby")!.split(" ")).toContain(warning()!.id); // read with the list
  // a blank line is dropped on save, so the outcomes are still what is printed
  await render(["  "], { kind: "skills", outcomes: [long] });
  expect(warning()).not.toBeNull();
  // a line of her own: the outcomes are not printed; typed into the list, the warning goes
  await render(["Kulmude kuju"], { kind: "skills", outcomes: [long] });
  expect(warning()).toBeNull();
  await render([], { kind: "skills", outcomes: [long] });
  await click(container.querySelector("[data-add-skill]"));
  await type(fields("data-certificate-skill")[0], "Kulmude kuju");
  expect(warning()).toBeNull();
  // every outcome fits (120 characters, white space counted as the PDF writes it), or the long one is past the 16 printed: none
  await render([], { kind: "skills", outcomes: [{ et: "x".repeat(120) }, { et: `  ${"y".repeat(60)}\n\n${"y".repeat(59)} ` }] });
  expect(warning()).toBeNull();
  await render([], { kind: "skills", outcomes: [...Array.from({ length: 16 }, (_, i) => ({ et: `Oskus ${i + 1}` })), long] });
  expect(warning()).toBeNull();
  // the protocol's list never warns about it
  await render([], { outcomes: [long] });
  expect(warning()).toBeNull();
});

// Task 8 (admin UX pass piece 3a; README B2, S3-P3-d, S3-P3-m): drag and ↑ / ↓ (DragList), × at once with the UndoBar „Rida eemaldatud.“, keys per row

const keys = () => [...container.querySelectorAll<HTMLElement>("[data-drag-row]")].map((li) => li.getAttribute("data-drag-row"));
const bar = () => document.querySelector<HTMLElement>("[data-undo-bar]");

test("each heading has its handle „Lohista rida {n}“ and ↑ / ↓; a move is one update and every row keeps its key", async () => {
  await render(["Ettevalmistus", "Analüüs", "Värvimine"]);
  expect(container.querySelector('[data-row="2"] [data-drag-tool="handle"]')!.getAttribute("aria-label")).toBe("Lohista rida 3");
  const before = keys();
  await click(container.querySelector('[data-row="2"] [data-drag-tool="up"]'));
  expect(updates).toHaveBeenCalledTimes(1);
  expect(current).toEqual(["Ettevalmistus", "Värvimine", "Analüüs"]);
  expect(keys()).toEqual([before[0], before[2], before[1]]);
});

test("removing a heading shows „Rida eemaldatud.“; „Võta tagasi“ puts it back at its place with its key, and the list saves again", async () => {
  await render(["Ettevalmistus", "Analüüs", "Värvimine"]);
  const before = keys();
  await click(container.querySelector('[aria-label="Eemalda rida 2"]'));
  expect(current).toEqual(["Ettevalmistus", "Värvimine"]);
  expect(bar()!.querySelector("p")!.textContent).toBe("Rida eemaldatud.");
  expect(document.activeElement).toBe(fields()[1]);
  await click(bar()!.querySelector("button"));
  expect(current).toEqual(["Ettevalmistus", "Analüüs", "Värvimine"]);
  expect(keys()).toEqual(before);
  expect(updates).toHaveBeenCalledTimes(2);
});

test("a certificate line (kind 'skills') removed: the same bar and undo", async () => {
  await render(["Kulmude kuju", "Värvi valik"], { kind: "skills" });
  await click(container.querySelector('[aria-label="Eemalda rida 1"]'));
  expect(current).toEqual(["Värvi valik"]);
  expect(bar()!.querySelector("p")!.textContent).toBe("Rida eemaldatud.");
  await click(bar()!.querySelector("button"));
  expect(current).toEqual(["Kulmude kuju", "Värvi valik"]);
});

test("„· avaldamata“ after the list's title while its part waits for „Avalda muudatused“ (README §1.8)", async () => {
  await render(["Ettevalmistus"], { unpublished: true });
  const group = container.querySelector("[data-protocol-stages]")!;
  const tag = group.querySelector<HTMLElement>("h3 [data-unpublished-tag]")!;
  expect(tag.textContent).toBe("· avaldamata");
  expect(group.getAttribute("aria-describedby")!.split(" ")).toContain(tag.id);
  await render(["Ettevalmistus"], { kind: "skills", unpublished: true });
  expect(container.querySelector("[data-certificate-skills] h3 [data-unpublished-tag]")).not.toBeNull();
  await render(["Ettevalmistus"]);
  expect(container.querySelector("[data-unpublished-tag]")).toBeNull();
});
