// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ProtocolStagesEditor } from "@/components/admin/ProtocolStagesEditor";

// "Protokolli punktid" in the course editor (phase protocols, spec §3): one plain field per heading, in order, with ↑ / ↓ / ×, "Lisa punkt",
// at most 30 (the button says so then), each field at most 120 characters. And the same editor for the e-course certificate's lines (phase
// 3d, spec §6: kind "skills"): its own title, labels, limit (16) and data hooks, so an e-course's editor tells its two lists apart.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Opts = { kind?: "stages" | "skills"; hint?: string; empty?: string };

let container: HTMLDivElement;
let root: Root;
let current: string[] = [];
function Harness({ initial, kind, hint, empty }: { initial: string[] } & Opts) {
  const [items, setItems] = useState(initial);
  useEffect(() => {
    current = items; // (not during the render: react-hooks/globals; act() flushes the effect)
  }, [items]);
  return createElement(ProtocolStagesEditor, { items, onChange: setItems, kind, hint, empty });
}
// a new key for each list: a new editor, as the course editor's reload gives one
const render = async (initial: string[], opts: Opts = {}) =>
  act(async () => root.render(createElement(Harness, { key: `${opts.kind ?? "stages"}:${initial.join("|")}`, initial, ...opts })));
const fields = (hook = "data-protocol-stage") => [...container.querySelectorAll<HTMLInputElement>(`[${hook}]`)];
const click = async (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeEach(() => {
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

test("the certificate's lines (kind 'skills'): their own title, labels and hooks, the hint and the empty line given; at 16 'Lisa rida' adds nothing and says so", async () => {
  await render([], { kind: "skills", hint: "Tühjana kasutatakse „Mida õpid“ ridu", empty: "Ridu pole: tunnistusel on kaardi „Õpiväljundid“ read." });
  expect(container.querySelector("[data-protocol-stages]")).toBeNull();
  expect(container.querySelector("[data-add-stage]")).toBeNull();
  expect(container.querySelector("[data-certificate-skills] h3")!.textContent).toBe("Oskused tunnistusel");
  expect(container.textContent).toContain("Tühjana kasutatakse „Mida õpid“ ridu");
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
