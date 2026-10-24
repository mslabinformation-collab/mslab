// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fields, type SendPatch } from "@/components/admin/autosave/engine";
import { useAutosave } from "@/components/admin/autosave/useAutosave";
import { Drawer } from "@/components/admin/Drawer";
import { LeaveGuardProvider } from "@/components/admin/LeaveGuard";
import { adminEt } from "@/i18n/dict/admin";

// Drawer.tsx and the leave guard (admin UX pass, README §1.5, screens §2.4): ✕ („Sulge“ on every drawer), Esc and the backdrop close at once
// when everything is saved, the address back to closeHref and the focus to the row; only the drawer's own sources are asked about (the page's
// text stays on the page); a close the browser forces past a held Esc opens the drawer again. The lesson drawer's own question (confirmClose,
// deprecated since piece 1) is gone with piece 3a Task 10: the lesson drawer autosaves, and every drawer asks only through the guard.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

type Answer = Awaited<ReturnType<SendPatch>>;
function server() {
  const calls: { answer: (a: Answer) => void }[] = [];
  const send: SendPatch = () => new Promise<Answer>((resolve) => calls.push({ answer: resolve }));
  return { calls, send, last: () => calls[calls.length - 1] };
}

let s = server();
const editors: Record<string, ReturnType<typeof useAutosave>> = {};
function Editor({ owner, field }: { owner: string; field: string }) {
  const a = useAutosave({ owner, key: "1", version: "v1", fields: { [field]: "" } as Fields, save: s.send, label: () => "Kohti" });
  useEffect(() => {
    editors[owner] = a;
  });
  return createElement("input", { name: field, value: String(a.fields[field] ?? ""), onChange: (e: { target: { value: string } }) => a.setField(field, e.target.value) });
}

let container: HTMLDivElement;
let root: Root;
const render = (el: React.ReactElement) => act(async () => root.render(el));
const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-drawer]")!;
const x = () => dialog().querySelector<HTMLButtonElement>("button[aria-label]")!;
const click = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const esc = () =>
  act(async () => {
    const e = new Event("cancel", { cancelable: true });
    dialog().dispatchEvent(e);
    if (!e.defaultPrevented) dialog().close();
  });
const answer = (a: Answer) =>
  act(async () => {
    s.last().answer(a);
    await vi.advanceTimersByTimeAsync(0);
  });
type DrawerProps = Parameters<typeof Drawer>[0];
const drawer = (children: React.ReactNode, extra: Partial<DrawerProps> = {}) =>
  createElement(Drawer, { label: "Toimumine", closeHref: "/admin/kalender", closeLabel: adminEt.common.close, returnFocus: "row", ...extra } as DrawerProps, children);
const page = (...children: React.ReactNode[]) => createElement(LeaveGuardProvider, null, createElement("a", { id: "row", href: "/admin/kalender?id=1" }, "Rida"), ...children);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  s = server();
  router.replace.mockReset();
  history.replaceState({ __NA: true }, "", "/admin/kalender?id=1");
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

describe("Drawer", () => {
  it.each([
    ["✕", () => click(x())],
    ["Esc", esc],
    ["the backdrop", () => click(dialog())],
  ])("everything saved: %s closes at once; the address goes back to closeHref and the focus to the row", async (_how, close) => {
    await render(page(drawer(createElement(Editor, { owner: "session", field: "seats" }))));
    expect(dialog().open).toBe(true);
    await close();
    expect(dialog().open).toBe(false);
    expect(router.replace).toHaveBeenCalledWith("/admin/kalender", { scroll: false });
    expect(document.activeElement).toBe(document.getElementById("row"));
    expect(document.querySelector("[data-leave-notice]")).toBeNull();
  });

  it("without the guard's provider (a drawer rendered alone) it closes as before", async () => {
    await render(drawer(createElement("p", null, "Sisu")));
    await click(x());
    expect(dialog().open).toBe(false);
    expect(router.replace).toHaveBeenCalledWith("/admin/kalender", { scroll: false });
  });

  it("the page's unsaved text is not the drawer's: the drawer closes at once, and leaving the page still asks", async () => {
    await render(page(createElement(Editor, { owner: "course", field: "title" }), drawer(createElement("p", null, "Sisu"))));
    await act(async () => editors.course.setField("title", "Uus"));
    await click(x());
    expect(dialog().open).toBe(false);
    expect(s.calls).toHaveLength(0);
    expect(editors.course.unconfirmed()).not.toBeNull();
  });

  it("a close the browser forces past a held Esc (a second Esc at once) opens the drawer again and asks the guard", async () => {
    await render(page(drawer(createElement(Editor, { owner: "session", field: "seats" }))));
    await act(async () => editors.session.setField("seats", "12"));
    await act(async () => dialog().close()); // the browser's own close, no cancel event before it
    expect(dialog().open).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();
    await answer(null);
    expect(dialog().querySelector("[data-leave-notice]")?.textContent).toContain("Muudatust „Kohti“ ei saanud veel salvestada.");
  });

  it("a file picker dismissed inside the drawer (its bubbling cancel) does not close it nor ask; the drawer's own Esc still closes it", async () => {
    await render(page(drawer(createElement("input", { type: "file", id: "pick" }))));
    // the browser's cancel of a dismissed picker: at the input, bubbling (Chrome 113+, Firefox 91+, Safari 16.4+); never cancelable
    const e = new Event("cancel", { bubbles: true, cancelable: false });
    await act(async () => void document.getElementById("pick")!.dispatchEvent(e));
    expect(dialog().open).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();
    expect(document.querySelector("[data-leave-notice]")).toBeNull();
    await esc();
    expect(router.replace).toHaveBeenCalledWith("/admin/kalender", { scroll: false });
  });

  it("a file picker dismissed while the drawer's text is not saved: the drawer stays open and nothing is asked or sent", async () => {
    await render(page(drawer([createElement("input", { key: "pick", type: "file", id: "pick" }), createElement(Editor, { key: "e", owner: "lesson", field: "seats" })])));
    await act(async () => editors.lesson.setField("seats", "12"));
    await act(async () => void document.getElementById("pick")!.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: false })));
    expect(dialog().open).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();
    expect(document.querySelector("[data-leave-notice]")).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  it("a close event of something inside the drawer (a dialog in it) is not the drawer's close", async () => {
    await render(page(drawer(createElement("dialog", { id: "inner" }, "Sees"))));
    const inner = document.getElementById("inner") as HTMLDialogElement;
    // as React hands it on: a close that bubbles from the inner element up to the drawer's dialog
    await act(async () => void inner.dispatchEvent(new Event("close", { bubbles: true })));
    expect(dialog().open).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("the deprecated close question is gone (Task 10): no confirmClose, CloseQuestion or useUnsavedInDrawer in the app, no lesson close words", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(p)) files.push(p);
      }
    };
    walk(join(process.cwd(), "src"));
    walk(join(process.cwd(), "tests"));
    const self = join("tests", "unit", "drawer-dom.test.ts");
    for (const f of files) {
      if (f.endsWith(self)) continue;
      expect(readFileSync(f, "utf8"), f).not.toMatch(/confirmClose|CloseQuestion|useUnsavedInDrawer|data-drawer-confirm/);
    }
    for (const key of ["closeQuestion", "closeYes", "closeNo"]) expect(Object.keys(adminEt.lessons.drawer)).not.toContain(key);
  });

  it("every admin drawer names its ✕ „Sulge“ (adminEt.common.close); the pages' own close words are gone", () => {
    const root = join(process.cwd(), "src", "app", "admin");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".tsx")) files.push(p);
      }
    };
    walk(root);
    let drawers = 0;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const opened = text.match(/<Drawer\b/g)?.length ?? 0;
      drawers += opened;
      expect(text.match(/closeLabel=\{adminEt\.common\.close\}/g)?.length ?? 0, f).toBe(opened);
      expect(text.match(/closeLabel=/g)?.length ?? 0, f).toBe(opened);
    }
    expect(drawers).toBeGreaterThanOrEqual(6);
    expect(adminEt.common.close).toBe("Sulge");
    for (const group of [adminEt.registrations.drawer, adminEt.clients.drawer, adminEt.calendar.drawer, adminEt.lessons.drawer, adminEt.feedback.drawer])
      expect(Object.keys(group)).not.toContain("close");
  });
});
