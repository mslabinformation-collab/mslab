// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UndoProvider, useUndo } from "@/components/admin/UndoBar";
import { PURGE_AFTER_MS, UNDO_LASTS_MS } from "@/domain/undo";
import { adminEt } from "@/i18n/dict/admin";

// UndoBar (admin UX pass, README §1.7, screens §2.5): "{Mis juhtus}." + „Võta tagasi“ for 8 s after a reversible one-tap action. One bar at a
// time (a new show replaces the old), role="status", never takes the focus, Esc dismisses it while it is up (and only then). When the undo
// answers false the bar says why instead. Fake timers: the 8 s are real code, not a test setting.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof useUndo>;

/** The page under the provider: one field the visitor is typing in (the bar must not take its focus). It hands `useUndo()` to the test. */
function Page() {
  const undo = useUndo();
  useEffect(() => {
    api = undo;
  }, [undo]);
  return createElement("input", { id: "field", type: "text" });
}
const mount = () => act(async () => root.render(createElement(UndoProvider, null, createElement(Page))));
const show = (text: string, undo: () => Promise<boolean | string> = async () => true) => act(async () => void api.show({ text, undo }));
/** `show`, keeping what it gives back: the way to take that bar away again. */
const offer = async (text: string) => {
  let withdraw!: () => void;
  await act(async () => void (withdraw = api.show({ text, undo: async () => true })));
  return withdraw;
};
const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

const bar = () => document.querySelector<HTMLElement>("[data-undo-bar]");
const bars = () => document.querySelectorAll("[data-undo-bar]");
const button = () => bar()?.querySelector("button") ?? null;
const text = () => bar()?.querySelector("p")?.textContent ?? null;
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());
const key = (target: EventTarget, k: string) => {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => void target.dispatchEvent(event));
  return event;
};

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the bar's time and the purges' minimum (domain/undo.ts, piece 4c review M-2)", () => {
  it("8 s on offer; a soft delete is purged 10 s after the tap at the earliest, so never while its bar can still be pressed", () => {
    expect(UNDO_LASTS_MS).toBe(8000);
    expect(PURGE_AFTER_MS).toBe(10_000);
    expect(PURGE_AFTER_MS).toBeGreaterThan(UNDO_LASTS_MS);
  });
});

describe("UndoBar", () => {
  it("shows „{text}“ + „Võta tagasi“; gone after 8 s", async () => {
    await mount();
    expect(bar()).toBeNull();
    await show("Pilt eemaldatud.");
    expect(bars()).toHaveLength(1);
    expect(text()).toBe("Pilt eemaldatud.");
    expect(button()?.textContent).toBe("Võta tagasi");
    expect(adminEt.common.undo).toBe("Võta tagasi");
    await advance(7999);
    expect(bar()).not.toBeNull();
    await advance(1);
    expect(bar()).toBeNull();
  });

  it("the bar is a status region, in the page at once (an empty one is announced when it fills), and the button is a plain button", async () => {
    await mount();
    const region = document.querySelector('[data-undo-region][role="status"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");
    await show("Fail eemaldatud.");
    expect(document.querySelector('[data-undo-region][role="status"]')).toBe(region); // the same element, now with the bar in it
    expect(region?.contains(bar())).toBe(true);
    expect(button()?.type).toBe("button");
  });

  it("Esc dismisses it", async () => {
    await mount();
    await show("Pilt eemaldatud.");
    const event = key(document.body, "Escape");
    expect(bar()).toBeNull();
    expect(event.defaultPrevented).toBe(true);
  });

  it("Esc is not swallowed when no bar is up (a drawer's Esc still works), nor after the bar has gone", async () => {
    await mount();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    const first = key(document.body, "Escape");
    expect(first.defaultPrevented).toBe(false);
    expect(outer).toHaveBeenCalledTimes(1);
    await show("Pilt eemaldatud.");
    await advance(8000);
    const after = key(document.body, "Escape");
    document.removeEventListener("keydown", outer);
    expect(after.defaultPrevented).toBe(false);
    expect(outer).toHaveBeenCalledTimes(2);
  });

  it("while a bar is up, Esc dismisses it first and goes no further (a drawer under it stays open); the next Esc reaches the drawer", async () => {
    await mount();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    const inside = document.createElement("button");
    dialog.append(inside);
    document.body.append(dialog);
    const reached = vi.fn();
    dialog.addEventListener("keydown", reached);
    await show("Fail eemaldatud.");
    const one = key(inside, "Escape");
    expect(bar()).toBeNull();
    expect(one.defaultPrevented).toBe(true);
    expect(reached).not.toHaveBeenCalled();
    const two = key(inside, "Escape");
    expect(two.defaultPrevented).toBe(false);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it("other keys do nothing", async () => {
    await mount();
    await show("Pilt eemaldatud.");
    key(document.body, "Enter");
    key(document.body, "a");
    expect(bar()).not.toBeNull();
  });

  it("a second show replaces the first, and the 8 s run from the second", async () => {
    await mount();
    await show("Pilt eemaldatud.");
    await advance(5000);
    await show("Rida eemaldatud.");
    expect(bars()).toHaveLength(1);
    expect(text()).toBe("Rida eemaldatud.");
    await advance(5000); // 10 s after the first, 5 s after the second
    expect(text()).toBe("Rida eemaldatud.");
    await advance(2999);
    expect(bar()).not.toBeNull();
    await advance(1);
    expect(bar()).toBeNull();
  });

  it("„Võta tagasi“ calls undo once and closes the bar", async () => {
    await mount();
    const undo = vi.fn(async () => true);
    await show("Pilt eemaldatud.", undo);
    await click(button());
    expect(undo).toHaveBeenCalledTimes(1);
    expect(bar()).toBeNull();
    await advance(10_000);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("while the undo is on its way the button is aria-disabled and a second tap does nothing; the 8 s do not close the bar under it", async () => {
    await mount();
    let answer: (ok: boolean) => void = () => {};
    const undo = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    await show("Pilt eemaldatud.", undo);
    await click(button());
    expect(button()?.getAttribute("aria-disabled")).toBe("true");
    await click(button());
    expect(undo).toHaveBeenCalledTimes(1);
    await advance(20_000);
    expect(bar()).not.toBeNull();
    await act(async () => answer(true));
    expect(bar()).toBeNull();
  });

  it("when the undo answers false the bar says „Salvestamine ei õnnestunud. Proovi uuesti.“, and closes 8 s later", async () => {
    await mount();
    await show("Pilt eemaldatud.", async () => false);
    await click(button());
    expect(text()).toBe(adminEt.common.saveError);
    expect(text()).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(bars()).toHaveLength(1);
    await advance(7999);
    expect(bar()).not.toBeNull();
    await advance(1);
    expect(bar()).toBeNull();
  });

  it("when the undo answers a sentence the bar says that sentence instead of the generic error, closes 8 s later, and the button stays", async () => {
    await mount();
    const undo = vi.fn<() => Promise<boolean | string>>().mockResolvedValueOnce("Päringut muudeti vahepeal. Vaata see üle.").mockResolvedValueOnce(true);
    await show("Märgitud tehtuks.", undo);
    await click(button());
    expect(text()).toBe("Päringut muudeti vahepeal. Vaata see üle.");
    expect(button()?.getAttribute("aria-disabled")).toBeNull();
    await advance(7999);
    expect(bar()).not.toBeNull();
    await advance(1);
    expect(bar()).toBeNull();
  });

  it("a sentence is only that failure's: pressed again after it, a success closes the bar", async () => {
    await mount();
    const undo = vi.fn<() => Promise<boolean | string>>().mockResolvedValueOnce("Päringut muudeti vahepeal. Vaata see üle.").mockResolvedValueOnce(true);
    await show("Märgitud tehtuks.", undo);
    await click(button());
    expect(text()).toBe("Päringut muudeti vahepeal. Vaata see üle.");
    await click(button());
    expect(undo).toHaveBeenCalledTimes(2);
    expect(bar()).toBeNull();
  });

  it("an undo that throws counts as false; the button stays, so she can try again", async () => {
    await mount();
    const undo = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(true);
    await show("Pilt eemaldatud.", undo);
    await click(button());
    expect(text()).toBe(adminEt.common.saveError);
    expect(button()?.getAttribute("aria-disabled")).toBeNull();
    await click(button());
    expect(undo).toHaveBeenCalledTimes(2);
    expect(bar()).toBeNull();
  });

  it("an answer that comes after a newer bar has replaced it is dropped (it does not close or change the newer bar)", async () => {
    await mount();
    let answer: (ok: boolean) => void = () => {};
    await show("Pilt eemaldatud.", () => new Promise<boolean>((resolve) => (answer = resolve)));
    await click(button());
    await show("Rida eemaldatud.");
    await act(async () => answer(false)); // the first bar's undo fails, late
    expect(text()).toBe("Rida eemaldatud.");
    expect(bars()).toHaveLength(1);
  });

  it("does not take focus", async () => {
    await mount();
    const field = document.getElementById("field") as HTMLInputElement;
    field.focus();
    expect(document.activeElement).toBe(field);
    await show("Pilt eemaldatud.");
    expect(document.activeElement).toBe(field);
    await show("Rida eemaldatud.");
    expect(document.activeElement).toBe(field);
    await advance(8000);
    expect(document.activeElement).toBe(field);
  });

  it("inside an open modal dialog (a drawer) the bar is in the dialog, where the page behind is not inert; it comes back to the page when the dialog closes", async () => {
    await mount();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    await show("Fail eemaldatud.");
    await act(async () => void vi.advanceTimersByTime(0));
    expect(dialog.contains(bar())).toBe(true);
    expect(bars()).toHaveLength(1);
    // a drawer closes (its dialog loses `open`): the bar is back in the page's own region, still counting its 8 s
    dialog.removeAttribute("open");
    await act(async () => void vi.advanceTimersByTime(0));
    expect(dialog.contains(bar())).toBe(false);
    expect(container.ownerDocument.body.contains(bar())).toBe(true);
    expect(bars()).toHaveLength(1);
    await advance(8000);
    expect(bar()).toBeNull();
  });

  it("a drawer that opens while the bar is up takes the bar in", async () => {
    await mount();
    await show("Pilt eemaldatud.");
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.setAttribute("open", "");
    await act(async () => void vi.advanceTimersByTime(0));
    expect(dialog.contains(bar())).toBe(true);
    expect(bars()).toHaveLength(1);
  });

  it("without a provider, show does nothing and does not throw (a component under test needs no wrapper)", async () => {
    function Alone() {
      const undo = useUndo();
      useEffect(() => {
        api = undo;
      }, [undo]);
      return null;
    }
    await act(async () => root.render(createElement(Alone)));
    expect(() => api.show({ text: "Pilt eemaldatud.", undo: async () => true })).not.toThrow();
    expect(bar()).toBeNull();
  });

  it("leaving with a bar up stops its timer", async () => {
    await mount();
    await show("Pilt eemaldatud.");
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});

describe("UndoBar: an offer taken back (review M-6: an editor that goes takes its bar with it)", () => {
  it("`show` gives back a way to take that bar away; it takes away only its own bar, never a newer one", async () => {
    await mount();
    const first = await offer("Rida eemaldatud.");
    await act(async () => first());
    expect(bar()).toBeNull();
    const second = await offer("Rida eemaldatud.");
    await show("Pilt eemaldatud.");
    await act(async () => second());
    expect(text()).toBe("Pilt eemaldatud.");
  });
});
