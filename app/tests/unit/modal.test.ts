import { afterEach, describe, expect, test, vi } from "vitest";
import { FOCUSABLE, lockPageScroll, trapTab } from "@/lib/modal";

// Plain stand-ins for the DOM (the unit tests run in Node): a container with focusable items and a document that knows
// which one has the focus.
function setup(n: number, activeAt: number | "outside") {
  const doc = { activeElement: null as unknown };
  const items = Array.from({ length: n }, (_, i) => ({ name: `item${i}`, focus: vi.fn(() => (doc.activeElement = items[i])) }));
  doc.activeElement = activeAt === "outside" ? { name: "outside" } : items[activeAt];
  const container = { ownerDocument: doc, querySelectorAll: vi.fn(() => items) } as unknown as HTMLElement;
  return { items, container, doc };
}
const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, preventDefault: vi.fn() });

describe("trapTab: Tab stays inside a modal", () => {
  test("Tab moves on and wraps from the last item to the first", () => {
    const { items, container, doc } = setup(3, 1);
    const e = key("Tab");
    trapTab(e, container);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(items[2]);
    trapTab(key("Tab"), container);
    expect(doc.activeElement).toBe(items[0]);
    expect(container.querySelectorAll).toHaveBeenCalledWith(FOCUSABLE);
  });

  test("Shift+Tab moves back and wraps from the first item to the last", () => {
    const { items, container, doc } = setup(3, 0);
    trapTab(key("Tab", true), container);
    expect(doc.activeElement).toBe(items[2]);
    trapTab(key("Tab", true), container);
    expect(doc.activeElement).toBe(items[1]);
  });

  test("with the focus on the dialog itself: Tab to the first item, Shift+Tab to the last", () => {
    const a = setup(3, "outside");
    trapTab(key("Tab"), a.container);
    expect(a.doc.activeElement).toBe(a.items[0]);
    const b = setup(3, "outside");
    trapTab(key("Tab", true), b.container);
    expect(b.doc.activeElement).toBe(b.items[2]);
  });

  test("other keys, no container or nothing focusable: left to the browser", () => {
    const { items, container } = setup(2, 0);
    const other = key("Enter");
    trapTab(other, container);
    expect(other.preventDefault).not.toHaveBeenCalled();
    expect(items[1].focus).not.toHaveBeenCalled();
    const none = key("Tab");
    trapTab(none, null);
    expect(none.preventDefault).not.toHaveBeenCalled();
    const empty = setup(0, "outside");
    const e = key("Tab");
    trapTab(e, empty.container);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  test("FOCUSABLE: buttons and inputs unless disabled, links, and tabindex except -1; never a hidden input, nor one out of the tab order (the honeypot)", () => {
    expect(FOCUSABLE).toBe('button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])');
  });
});

describe("lockPageScroll", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("hides the page's overflow and puts back what was there; nested locks unwind in order", () => {
    const root = { style: { overflow: "clip" } };
    vi.stubGlobal("document", { documentElement: root });
    const outer = lockPageScroll();
    expect(root.style.overflow).toBe("hidden");
    const inner = lockPageScroll();
    inner();
    expect(root.style.overflow).toBe("hidden");
    outer();
    expect(root.style.overflow).toBe("clip");
  });
});
