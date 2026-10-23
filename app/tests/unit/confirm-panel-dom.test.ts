// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmPanel } from "@/components/admin/ConfirmPanel";
import { adminEt } from "@/i18n/dict/admin";

// ConfirmPanel (admin UX pass, README §1.6, screens §2.5): the one confirmation pattern. It takes the place of its trigger, takes the focus,
// asks the question, lists the consequences, and has two buttons: "Jah, …" (danger outline or the ink pill) and always „Katkesta“. Esc is „Katkesta“.
// The colours are in the CSS module; here the class names tell the tone.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

type Props = Parameters<typeof ConfirmPanel>[0];
const QUESTION = "Kas tühistan Kati Kase registreerimise?";
const LINES = ["Koht 05.12 Pärnu koolitusel vabaneb kohe avalikus kalendris.", "Laekunud 175 € ja arve MSL2026-004 jäävad alles.", "Õpilasele kirja ei saadeta."];
const props = (over: Partial<Props> = {}): Props => ({
  question: QUESTION,
  lines: LINES,
  yesLabel: "Jah, tühista",
  tone: "danger",
  onYes: () => {},
  onCancel: () => {},
  ...over,
});
const show = (over?: Partial<Props>) => act(async () => root.render(createElement(ConfirmPanel, props(over))));

const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const panel = () => $("[data-confirm-panel]")!;
const buttons = () => Array.from(container.querySelectorAll("button"));
const yes = () => buttons()[0];
const no = () => buttons()[1];
const click = (el: Element) => act(async () => void (el as HTMLElement).click());
const key = (el: Element, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("ConfirmPanel", () => {
  it("shows the question, every line and „Jah, …“; takes focus", async () => {
    await show();
    const group = panel();
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("tabindex")).toBe("-1");
    const label = document.getElementById(group.getAttribute("aria-labelledby")!);
    expect(label?.textContent).toBe(QUESTION);
    expect(Array.from(group.querySelectorAll("li")).map((li) => li.textContent)).toEqual(LINES);
    expect(yes().textContent).toBe("Jah, tühista");
    expect(document.activeElement).toBe(group);
  });

  it("the lines are optional: without them there is no list", async () => {
    await show({ lines: undefined });
    expect(container.querySelector("ul")).toBeNull();
    await show({ lines: [] });
    expect(container.querySelector("ul")).toBeNull();
    expect(label()).toBe(QUESTION);
  });

  it("„Katkesta“ is always the other button, and it calls onCancel", async () => {
    const onCancel = vi.fn();
    const onYes = vi.fn();
    await show({ onCancel, onYes });
    expect(adminEt.common.cancel).toBe("Katkesta");
    expect(no().textContent).toBe("Katkesta");
    await show({ onCancel, onYes, tone: "send", yesLabel: "Jah, saada 4 tellijale" });
    expect(no().textContent).toBe("Katkesta");
    await click(no());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onYes).not.toHaveBeenCalled();
  });

  it("Esc does the same as „Katkesta“, from the panel and from a button in it, and goes no further (a drawer round it stays open)", async () => {
    const onCancel = vi.fn();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    await show({ onCancel });
    await key(panel(), "Escape");
    await key(yes(), "Escape");
    await key(no(), "Escape");
    document.removeEventListener("keydown", outer);
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(outer).not.toHaveBeenCalled();
    // any other key does nothing
    await key(panel(), "Enter");
    await key(panel(), "a");
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("Esc cancels the browser's own handling of it (the dialog round the panel does not close)", async () => {
    await show();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => void panel().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  });

  it("yes calls onYes once", async () => {
    const onYes = vi.fn();
    const onCancel = vi.fn();
    await show({ onYes, onCancel });
    await click(yes());
    expect(onYes).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(yes().hasAttribute("aria-disabled")).toBe(false);
  });

  it("while busy, yes is aria-disabled and does nothing; so is „Katkesta“ (the action is running, there is nothing to step back from)", async () => {
    const onYes = vi.fn();
    const onCancel = vi.fn();
    await show({ onYes, onCancel, busy: true });
    expect(yes().getAttribute("aria-disabled")).toBe("true");
    expect(yes().disabled).toBe(false); // aria-disabled keeps the button focusable
    expect(no().getAttribute("aria-disabled")).toBe("true");
    expect(no().disabled).toBe(false);
    await click(yes());
    await click(yes());
    expect(onYes).not.toHaveBeenCalled();
    await click(no());
    await click(no());
    expect(onCancel).not.toHaveBeenCalled();
    // and when the action is over, both work again
    await show({ onYes, onCancel, busy: false });
    expect(no().hasAttribute("aria-disabled")).toBe(false);
    await click(no());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("while busy, Esc does not call onCancel either, but the panel still takes it: the drawer round it does not close under the running action", async () => {
    const onCancel = vi.fn();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    await show({ onCancel, busy: true });
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => void panel().dispatchEvent(event));
    await key(yes(), "Escape");
    await key(no(), "Escape");
    document.removeEventListener("keydown", outer);
    expect(onCancel).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("the buttons are type=button (the panel may sit inside a form)", async () => {
    await show();
    expect(buttons().map((b) => b.type)).toEqual(["button", "button"]);
  });

  it("danger tone: the red outline (#c9a3a3, bg #f5ebeb, text #8a3b3b); send tone: the ink pill", async () => {
    await show({ tone: "danger" });
    expect(yes().className).toMatch(/btn/);
    expect(yes().className).toMatch(/dangerYes/);
    expect(no().className).toMatch(/secondary/);
    expect(no().className).not.toMatch(/dangerYes/);
    await show({ tone: "send", yesLabel: "Jah, saada 4 tellijale" });
    expect(yes().className).toMatch(/btn/);
    expect(yes().className).not.toMatch(/dangerYes|secondary|danger/);
    expect(yes().textContent).toBe("Jah, saada 4 tellijale");
  });

  it("is styled as the admin's notice (ui.notice)", async () => {
    await show();
    expect(panel().className).toMatch(/notice/);
  });
});

function label(): string | null | undefined {
  return document.getElementById(panel().getAttribute("aria-labelledby")!)?.textContent;
}
