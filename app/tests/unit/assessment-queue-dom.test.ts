// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AssessmentQueue, QueueStatus } from "@/components/admin/AssessmentQueue";
import { ReopenTest } from "@/components/admin/ReopenTest";
import { adminEt } from "@/i18n/dict/admin";

// Hindamine's one list (admin UX pass, piece 2, Task 9; README A4, ledger L99) in a browser-like document (happy-dom), the server action answered
// here. A reopened test's row leaves the list when the page comes back (the action revalidates the admin), and with it the row's own line and the
// focus: so the page keeps one status line, a live region from the start, and the focus goes to the row that followed — the heading when there is
// none. The page's refresh is played by rendering the list again without the row.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ reopen: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: vi.fn(), reopenTestAction: actions.reopen }));

const reopenTexts = { ...adminEt.assessment.reopen, saving: adminEt.common.saving, error: adminEt.common.saveError };

type Row = { kind: "practical" | "test" | "triesUsed"; accessId: number; name: string };
const keyOf = (r: Row) => `${r.kind}-${r.accessId}`;
/** The page as the server draws it: the heading, the status line, and one row per item (the rows' contract: data-queue-row, the first control of a row). */
const page = (rows: Row[]): ReactNode =>
  createElement(
    AssessmentQueue,
    null,
    createElement("h1", { tabIndex: -1, "data-assessment-heading": "" }, "Hindamine"),
    createElement(QueueStatus),
    rows.length === 0
      ? createElement("p", { "data-queue-empty": "" }, adminEt.assessment.empty)
      : createElement(
          "ul",
          null,
          rows.map((r) =>
            createElement(
              "li",
              { key: keyOf(r), "data-queue-item": r.accessId, "data-queue-kind": r.kind, "data-queue-row": keyOf(r) },
              createElement("a", { href: `#${keyOf(r)}` }, r.kind === "practical" ? "Hinda" : r.kind === "test" ? "Vaata" : "Testi katsed"),
              r.kind === "triesUsed" && createElement(ReopenTest, { accessId: r.accessId, course: "Kulmumeistri e-koolitus", student: r.name, used: true, t: reopenTexts }),
            ),
          ),
        ),
  );

const A: Row = { kind: "triesUsed", accessId: 1, name: "Kati Kask" };
const B: Row = { kind: "practical", accessId: 2, name: "Mari Maasikas" };
const C: Row = { kind: "triesUsed", accessId: 3, name: "Liis Lill" };
const D: Row = { kind: "test", accessId: 4, name: "Tiina Tamm" };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = async (rows: Row[]) => {
  await act(async () => root.render(page(rows)));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const row = (r: Row) => $(`[data-queue-row="${keyOf(r)}"]`)!;
const status = () => $("[data-queue-status]")!;
const reopenOf = async (r: Row) => {
  await click(row(r).querySelector("[data-reopen]"));
  await click([...row(r).querySelectorAll("[data-confirm-panel] button")].find((b) => b.textContent === "Jah, ava") ?? null);
};

beforeEach(() => {
  actions.reopen.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the page's status line", () => {
  test("it is a status region from the start, empty and out of the way; the page's root is the Hindamine page", async () => {
    await show([A, B]);
    expect(status().getAttribute("role")).toBe("status");
    expect(status().textContent).toBe("");
    expect($("[data-assessment-page]")).not.toBeNull();
  });

  test("a reopened test is told on it, with her tries; the row has no line of its own (one live region, not two)", async () => {
    actions.reopen.mockResolvedValue({ kind: "reopened", triesLeft: 3 });
    await show([A, B, C]);
    await reopenOf(A);
    expect(actions.reopen).toHaveBeenCalledWith({ accessId: 1 });
    expect(status().textContent).toBe("Test uuesti avatud: Kati Kask, katseid jäänud 3.");
    expect($("[data-reopen-done]")).toBeNull();
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  test("'already open' is told the same way", async () => {
    actions.reopen.mockResolvedValue({ kind: "notNeeded" });
    await show([A, B]);
    await reopenOf(A);
    expect(status().textContent).toBe("Test on juba avatud.");
  });

  test("it stays when the next reopen starts and is replaced by that one's answer", async () => {
    actions.reopen.mockResolvedValueOnce({ kind: "reopened", triesLeft: 3 }).mockResolvedValueOnce({ kind: "reopened", triesLeft: 2 });
    await show([A, B, C]);
    await reopenOf(A);
    await show([B, C]);
    expect(status().textContent).toBe("Test uuesti avatud: Kati Kask, katseid jäänud 3.");
    await reopenOf(C);
    expect(status().textContent).toBe("Test uuesti avatud: Liis Lill, katseid jäänud 2.");
  });
});

describe("the focus after the row has left (ledger L99)", () => {
  test("it goes to the first control of the row that followed", async () => {
    actions.reopen.mockResolvedValue({ kind: "reopened", triesLeft: 3 });
    await show([A, B, C]);
    await reopenOf(A);
    await show([B, C]); // the page comes back without her row
    expect(document.activeElement).toBe(row(B).querySelector("a"));
    expect(document.activeElement!.textContent).toBe("Hinda");
  });

  test("a row in the middle: the one after it, not the one before", async () => {
    actions.reopen.mockResolvedValue({ kind: "reopened", triesLeft: 3 });
    await show([B, C, D]);
    await reopenOf(C);
    await show([B, D]);
    expect(document.activeElement).toBe(row(D).querySelector("a"));
    expect(document.activeElement!.textContent).toBe("Vaata");
  });

  test("the last row has none after it: the heading takes the focus", async () => {
    actions.reopen.mockResolvedValue({ kind: "reopened", triesLeft: 3 });
    await show([B, C]);
    await reopenOf(C);
    await show([B]);
    expect(document.activeElement).toBe($("[data-assessment-heading]"));
  });

  test("the only row: the list is empty and says so, the heading has the focus and the status line has what was done", async () => {
    actions.reopen.mockResolvedValue({ kind: "reopened", triesLeft: 3 });
    await show([A]);
    await reopenOf(A);
    await show([]);
    expect($("[data-queue-empty]")!.textContent).toBe("Hindamist ootavaid töid pole.");
    expect(document.activeElement).toBe($("[data-assessment-heading]"));
    expect(status().textContent).toBe("Test uuesti avatud: Kati Kask, katseid jäänud 3.");
  });

  test("the page may come back before the answer does: the focus still goes to the row that followed", async () => {
    let finish: (r: unknown) => void = () => {};
    actions.reopen.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await show([A, B]);
    await reopenOf(A);
    await show([B]); // (the revalidated page arrives first)
    await act(async () => finish({ kind: "reopened", triesLeft: 3 }));
    await settle();
    expect(status().textContent).toBe("Test uuesti avatud: Kati Kask, katseid jäänud 3.");
    expect(document.activeElement).toBe(row(B).querySelector("a"));
  });

  test("the row stays in the DOM until the page comes back: the focus does not move before it has left", async () => {
    actions.reopen.mockResolvedValue({ kind: "reopened", triesLeft: 3 });
    await show([A, B]);
    await reopenOf(A);
    expect(row(A)).not.toBeNull();
    expect(document.activeElement).not.toBe(row(B).querySelector("a"));
    expect(status().textContent).toBe("Test uuesti avatud: Kati Kask, katseid jäänud 3.");
    await show([B]);
    expect(document.activeElement).toBe(row(B).querySelector("a"));
  });

  test("the focus moves once: a later render does not take it back from where Maria has gone", async () => {
    actions.reopen.mockResolvedValue({ kind: "reopened", triesLeft: 3 });
    await show([A, B, C]);
    await reopenOf(A);
    await show([B, C]);
    const elsewhere = row(C).querySelector("a") as HTMLElement;
    elsewhere.focus();
    await show([B, C]);
    expect(document.activeElement).toBe(elsewhere);
  });

  test("a failed reopen changes nothing: the question stays open with its alert, no status line, the focus is not taken", async () => {
    actions.reopen.mockResolvedValue({ kind: "failed" });
    await show([A, B]);
    await reopenOf(A);
    expect(status().textContent).toBe("");
    expect(row(A).querySelector('[role="alert"]')!.textContent).toBe(adminEt.common.saveError);
    expect(row(A).querySelector("[data-confirm-panel]")).not.toBeNull();
  });
});
