// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ExtendAccess } from "@/components/admin/ExtendAccess";
import { UndoProvider } from "@/components/admin/UndoBar";
import { adminEt } from "@/i18n/dict/admin";

// „Pikenda ▾“ on an e-course access (B12, README A5): a pill menu — +1 kuu / +3 kuud / +6 kuud / „Kuupäev…“ — that applies at once and says so in the
// UndoBar („Ligipääs pikendatud kuni {date}.“) with „Võta tagasi“. „Kuupäev…“ opens a field („Ligipääs kuni“, „Pikenda“, „Katkesta“). The server action is
// answered here; its own rules are tests/db/admin-clients.test.ts.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { ok: true; previous: string; until: string } | { ok: false; error: string };
const action = vi.hoisted(() => vi.fn<(input: Record<string, unknown>) => Promise<Answer>>());
vi.mock("@/server/actions/admin-clients", () => ({
  addStudent: vi.fn(),
  grantCourseAccess: vi.fn(),
  revokeCourseAccess: vi.fn(),
  unlockNextLesson: vi.fn(),
  extendAccessAction: action,
}));

const END = "2027-03-17T21:59:59.999Z"; // 17.03.2027 in Tallinn
const PLUS_ONE = "2027-04-17T20:59:59.999Z";

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const draw = async (over: Partial<Parameters<typeof ExtendAccess>[0]> = {}) => {
  await act(async () =>
    root.render(
      createElement(UndoProvider, null, createElement(ExtendAccess, { accessId: 41, course: "Kulmumeistri e-koolitus", expiresAt: END, expired: false, min: "2027-03-17", max: "2036-10-04", ...over })),
    ),
  );
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const trigger = () => $<HTMLButtonElement>("[data-more-menu] > button")!;
const items = () => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
const item = (name: string) => items().find((i) => i.textContent === name) ?? null;
const bar = () => $("[data-undo-bar]");
const barText = () => bar()?.querySelector("p")?.textContent ?? null;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

beforeEach(() => {
  action.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the „Pikenda ▾“ menu", () => {
  test("an outlined pill named by the course; it opens +1 kuu, +3 kuud, +6 kuud, Kuupäev… under the end it counts from", async () => {
    await draw();
    expect(text(trigger())).toBe("Pikenda ▾");
    expect(trigger().getAttribute("data-variant")).toBe("pill");
    expect(trigger().getAttribute("aria-label")).toBe("Pikenda: Kulmumeistri e-koolitus");
    await click(trigger());
    expect(text($("[role=menu]")!.firstElementChild)).toBe("Pikenda ligipääsu (praegu kuni 17.03.2027)");
    expect(items().map((i) => i.textContent)).toEqual(["+1 kuu", "+3 kuud", "+6 kuud", "Kuupäev…"]);
  });

  test("an access that ran out says so in the title (S3-h)", async () => {
    await draw({ expired: true, expiresAt: "2026-08-01T20:59:59.999Z" });
    await click(trigger());
    expect(text($("[role=menu]")!.firstElementChild)).toBe("Pikenda ligipääsu (lõppes 01.08.2026)");
  });
});

describe("a pick applies at once", () => {
  test("+1 kuu sends the end the screen showed; the UndoBar says until when; „Võta tagasi“ sends the end it replaced, asking for the end it set", async () => {
    action.mockResolvedValueOnce({ ok: true, previous: END, until: PLUS_ONE });
    await draw();
    await click(trigger());
    await click(item("+1 kuu"));
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenLastCalledWith({ accessId: 41, expected: END, months: 1 });
    expect(barText()).toBe("Ligipääs pikendatud kuni 17.04.2027.");
    expect(adminEt.clients.extend.done).toBe("Ligipääs pikendatud kuni {date}.");

    action.mockResolvedValueOnce({ ok: true, previous: PLUS_ONE, until: END });
    await click(bar()!.querySelector("button"));
    expect(action).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenLastCalledWith({ accessId: 41, expected: PLUS_ONE, restore: END });
    expect(bar()).toBeNull(); // taken back: the bar goes
  });

  test("+3 kuud and +6 kuud send their months", async () => {
    action.mockResolvedValue({ ok: true, previous: END, until: PLUS_ONE });
    await draw();
    await click(trigger());
    await click(item("+3 kuud"));
    expect(action).toHaveBeenLastCalledWith({ accessId: 41, expected: END, months: 3 });
    await click(trigger());
    await click(item("+6 kuud"));
    expect(action).toHaveBeenLastCalledWith({ accessId: 41, expected: END, months: 6 });
  });

  test("an undo the server refuses (the end moved meanwhile) shows the bar's own error and sends nothing more by itself", async () => {
    action.mockResolvedValueOnce({ ok: true, previous: END, until: PLUS_ONE });
    await draw();
    await click(trigger());
    await click(item("+1 kuu"));
    action.mockResolvedValueOnce({ ok: false, error: "stale" });
    await click(bar()!.querySelector("button"));
    expect(barText()).toBe(adminEt.common.saveError);
    expect(action).toHaveBeenCalledTimes(2);
  });

  test("a pick the server refuses says so by the button and puts no bar up", async () => {
    action.mockResolvedValueOnce({ ok: false, error: "stale" });
    await draw();
    await click(trigger());
    await click(item("+1 kuu"));
    expect($("[role=alert]")!.textContent).toBe(adminEt.common.saveError);
    expect(bar()).toBeNull();
    // the next pick takes the line away
    action.mockResolvedValueOnce({ ok: true, previous: END, until: PLUS_ONE });
    await click(trigger());
    await click(item("+1 kuu"));
    expect($("[role=alert]")).toBeNull();
    expect(bar()).not.toBeNull();
  });
});

describe("„Kuupäev…“", () => {
  const open = async () => {
    await click(trigger());
    await click(item("Kuupäev…"));
  };
  const field = () => $<HTMLInputElement>("[data-extend-form] input[type=date]")!;
  const typeDate = async (value: string) => {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(field(), value);
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => $<HTMLFormElement>("[data-extend-form]")!.requestSubmit());
    await settle();
  };

  test("opens a field „Ligipääs kuni“ (from the end's day to the 10 years) with „Pikenda“ and „Katkesta“; the focus is in the field", async () => {
    await draw();
    expect($("[data-extend-form]")).toBeNull();
    await open();
    const form = $("[data-extend-form]")!;
    expect(form).not.toBeNull();
    expect(text(form.querySelector("label"))).toBe("Ligipääs kuni");
    expect(field().min).toBe("2027-03-17");
    expect(field().max).toBe("2036-10-04");
    expect([...form.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Pikenda", "Katkesta"]);
    expect(document.activeElement).toBe(field());
  });

  test("„Pikenda“ sends the day; it goes through: the field closes and the bar says until when", async () => {
    action.mockResolvedValueOnce({ ok: true, previous: END, until: "2027-06-30T20:59:59.999Z" });
    await draw();
    await open();
    await typeDate("2027-06-30");
    await submit();
    expect(action).toHaveBeenLastCalledWith({ accessId: 41, expected: END, date: "2027-06-30" });
    expect($("[data-extend-form]")).toBeNull();
    expect(barText()).toBe("Ligipääs pikendatud kuni 30.06.2027.");
    expect(document.activeElement).toBe(trigger());
  });

  test("a day that is not later than the end: the field says so (S3-i) and is marked; typing again takes the line away", async () => {
    action.mockResolvedValueOnce({ ok: false, error: "date" });
    await draw();
    await open();
    await typeDate("2027-03-10");
    await submit();
    expect($("[data-extend-form] [role=status]")!.textContent).toBe("Vali kuupäev, mis on hilisem kui praegune lõpp.");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect($("[data-extend-form]")).not.toBeNull();
    expect(bar()).toBeNull();
    await typeDate("2027-03-12");
    expect($("[data-extend-form] [role=status]")!.textContent).toBe("");
  });

  test("an empty field is the same answer, without asking the server", async () => {
    await draw();
    await open();
    await submit();
    expect(action).not.toHaveBeenCalled();
    expect($("[data-extend-form] [role=status]")!.textContent).toBe("Vali kuupäev, mis on hilisem kui praegune lõpp.");
  });

  test("„Katkesta“ and Esc close it and put the focus back on „Pikenda ▾“; Esc goes no further (the drawer stays)", async () => {
    await draw();
    await open();
    await click([...document.querySelectorAll("[data-extend-form] button")].find((b) => b.textContent === "Katkesta")!);
    expect($("[data-extend-form]")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(action).not.toHaveBeenCalled();

    await open();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    await act(async () => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    document.removeEventListener("keydown", outer);
    expect($("[data-extend-form]")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  test("a server failure (not a date refusal) shows the save error, not the date line", async () => {
    action.mockResolvedValueOnce({ ok: false, error: "server" });
    await draw();
    await open();
    await typeDate("2027-06-30");
    await submit();
    expect($("[data-extend-form] [role=alert]")!.textContent).toBe(adminEt.common.saveError);
    expect($("[data-extend-form] [role=status]")!.textContent).toBe("");
  });
});
