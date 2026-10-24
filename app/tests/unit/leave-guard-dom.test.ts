// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS, type Fields, type SendPatch } from "@/components/admin/autosave/engine";
import { useAutosave } from "@/components/admin/autosave/useAutosave";
import { Drawer } from "@/components/admin/Drawer";
import { LEAVE_WAIT_MS, LeaveGuardProvider, useGuardSource, type GuardReason } from "@/components/admin/LeaveGuard";
import { adminEt } from "@/i18n/dict/admin";

// The leave guard (admin UX pass, README §1.5, screens §2.4; Review Focus 4): a menu click, Back, and a drawer's ✕/Esc/backdrop while an
// autosave on the page is not confirmed. A save in flight is waited for (at most 3 s), then the move goes on; a save that cannot go through
// asks in place, „Muudatust „{välja nimi}“ ei saanud veel salvestada.“ + why, „Jää siia“ (back to the field) or „Sulge, tekst jääb
// seadmesse“ (go; the copy in this browser is resumed next time). `beforeunload` only while something is not confirmed. The server is
// answered by hand; fake timers: the 3 s and the 1.5 s are the real code's.

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
const ok = (version: string): Answer => ({ status: 200, body: { ok: true, version, savedAt: "2026-10-21T08:00:00.000Z" } });
const LABELS: Record<string, string> = { title: "Koolituse nimi", body: "Kirjeldus", seats: "Kohti" };

/** A server answered by hand: each save waits until the test answers it. */
function server() {
  const calls: { body: { version: string; patch: Fields }; answer: (a: Answer) => void }[] = [];
  const send: SendPatch = (body) => new Promise<Answer>((resolve) => calls.push({ body, answer: resolve }));
  return { calls, send, last: () => calls[calls.length - 1] };
}

let s = server();
type Hook = ReturnType<typeof useAutosave>;
const probe: { current: Hook | null } = { current: null };

/** One form part with its fields in the page (named as the hook's fields), and an autosave the test types into. */
function Editor({ owner = "course", fields = { title: "Pealkiri", body: "Tekst" } as Fields, validate }: { owner?: string; fields?: Fields; validate?: (f: Fields) => Record<string, string> }) {
  const a = useAutosave({ owner, key: "12", version: "v1", fields, save: s.send, validate, label: (f) => LABELS[f] ?? f });
  useEffect(() => {
    probe.current = a;
  });
  return createElement(
    "div",
    { "data-editor": "" },
    ...Object.keys(fields).map((name) => createElement("input", { key: name, name, value: String(a.fields[name] ?? ""), onChange: (e: { target: { value: string } }) => a.setField(name, e.target.value) })),
  );
}

/** A source of its own (an upload, say): never confirmed, its flush answers false at once. */
function Stubborn({ reason }: { reason: GuardReason }) {
  useGuardSource({ id: "stub", label: () => "Kohti", flush: async () => false, unconfirmed: () => ({ reason }), focus: () => document.querySelector<HTMLElement>("#seats")?.focus() });
  return createElement("input", { id: "seats" });
}

/** The page: the menu (its links), the editor, and Next's own Link handler standing in on the links (it would navigate). */
function Page({ children }: { children?: React.ReactNode }) {
  return createElement(
    LeaveGuardProvider,
    null,
    createElement("nav", null, createElement("a", { href: "/admin/kalender", "data-menu": "" }, "Kalender"), createElement("a", { href: "/admin/koolitused/12?vaade=ru", "data-same": "" }, "RU")),
    children ?? createElement(Editor),
  );
}

let container: HTMLDivElement;
let root: Root;
/** Next.js's Link (or the browser following the href): reached only when the guard lets the click through. */
const followed = vi.fn();
function link(e: MouseEvent) {
  const a = (e.target as Element).closest?.("a");
  if (!a) return;
  e.preventDefault();
  followed(a.getAttribute("href"));
}

const mount = (children?: React.ReactNode) => act(async () => root.render(createElement(Page, null, children)));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const answer = (a: Answer) =>
  act(async () => {
    s.last().answer(a);
    await vi.advanceTimersByTimeAsync(0);
  });
const type = (name: string, value: string) => act(async () => probe.current!.setField(name, value));
const click = (el: Element | null) =>
  act(async () => {
    const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    (el as HTMLElement).dispatchEvent(e);
    await vi.advanceTimersByTimeAsync(0);
    return e;
  });
const menu = () => document.querySelector("[data-menu]");
const notice = () => document.querySelector<HTMLElement>("[data-leave-notice]");
const button = (name: string) => [...(notice()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === name) ?? null;
const field = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
const storageKeys = () => [...Array(localStorage.length)].map((_, i) => localStorage.key(i)!);
const unload = () => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  s = server();
  probe.current = null;
  router.push.mockReset();
  router.replace.mockReset();
  followed.mockReset();
  history.replaceState({ __NA: true, at: "list" }, "", "/admin/koolitused");
  history.pushState({ __NA: true, at: "course" }, "", "/admin/koolitused/12");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // Next's Link (React's click handler at the root): a click the guard holds is stopped before it gets there
  document.addEventListener("click", link);
});
afterEach(async () => {
  document.removeEventListener("click", link);
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the leave guard: a menu link", () => {
  it("a menu link click with a save in flight waits for it (≤ 3 s), then navigates", async () => {
    await mount();
    // everything saved: the click is Next's, untouched
    const free = await click(menu());
    expect(followed).toHaveBeenCalledWith("/admin/kalender");
    expect(free.defaultPrevented).toBe(true); // by the Link, not by the guard
    expect(router.push).not.toHaveBeenCalled();
    followed.mockReset();

    // typed, its 1.5 s not over: the click sends it at once and holds the move until the answer
    await type("title", "Uus nimi");
    const held = await click(menu());
    expect(held.defaultPrevented).toBe(true);
    expect(followed).not.toHaveBeenCalled();
    expect(s.calls.map((c) => c.body)).toEqual([{ version: "v1", patch: { title: "Uus nimi" } }]);
    await advance(1000);
    expect(router.push).not.toHaveBeenCalled();
    expect(notice()).toBeNull(); // nothing is asked while it waits
    await answer(ok("v2"));
    expect(router.push).toHaveBeenCalledWith("/admin/kalender");
    expect(notice()).toBeNull();
  });

  it("a save still on its way after 3 s: the move goes on (the copy in this browser keeps the text)", async () => {
    await mount();
    await type("title", "Uus nimi");
    await click(menu());
    expect(s.calls).toHaveLength(1);
    expect(LEAVE_WAIT_MS).toBe(3000);
    await advance(LEAVE_WAIT_MS - 1);
    expect(router.push).not.toHaveBeenCalled();
    await advance(1);
    expect(router.push).toHaveBeenCalledWith("/admin/kalender");
    expect(notice()).toBeNull();
    expect(storageKeys().map((k) => localStorage.getItem(k)).join()).toContain("Uus nimi");
  });

  it("when the save can't go through: the notice „Muudatust „{välja nimi}“ ei saanud veel salvestada.“ + reason; „Jää siia“ focuses the field", async () => {
    await mount();
    await type("title", "Uus nimi");
    await click(menu());
    await answer(null); // no answer: offline
    expect(router.push).not.toHaveBeenCalled();
    const n = notice()!;
    expect(n).not.toBeNull();
    expect(n.querySelector("[data-leave-title]")?.textContent).toBe("Muudatust „Koolituse nimi“ ei saanud veel salvestada.");
    expect(n.querySelector("[data-leave-reason]")?.textContent).toBe("Ühendus puudub. Proovin uuesti, kuni jääd siia.");
    expect([...n.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Jää siia", "Sulge, tekst jääb seadmesse"]);
    // in place at the top of the page, and it has the focus
    expect(n.compareDocumentPosition(document.querySelector("[data-editor]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe(n);
    expect(n.getAttribute("role")).toBe("group");

    await click(button("Jää siia"));
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(field("title"));
    expect(router.push).not.toHaveBeenCalled();
    expect(followed).not.toHaveBeenCalled();
    expect(field("title")!.value).toBe("Uus nimi");
  });

  it("a field its check refuses names that field: „Üks väli vajab parandamist.“", async () => {
    await mount(createElement(Editor, { validate: (f: Fields): Record<string, string> => (f.title === "" ? { title: "required" } : {}) }));
    await type("body", "Uus kirjeldus");
    await type("title", "");
    await click(menu());
    await answer(ok("v2")); // the body is saved; the empty name is held back
    expect(router.push).not.toHaveBeenCalled();
    expect(notice()?.querySelector("[data-leave-title]")?.textContent).toBe("Muudatust „Koolituse nimi“ ei saanud veel salvestada.");
    expect(notice()?.querySelector("[data-leave-reason]")?.textContent).toBe("Üks väli vajab parandamist.");
  });

  it.each<[GuardReason, string]>([
    ["offline", "Ühendus puudub. Proovin uuesti, kuni jääd siia."],
    ["error", "Salvestamine ei õnnestunud."],
    ["invalid", "Üks väli vajab parandamist."],
    ["signedOut", "Logi uuesti sisse."],
    ["upload", "Üleslaadimine käib."],
  ])("reason %s: „%s“ (asked at once: nothing to wait for)", async (reason, text) => {
    expect(adminEt.leave.reasons[reason]).toBe(text);
    await mount(createElement(Stubborn, { reason }));
    await click(menu());
    expect(notice()?.querySelector("[data-leave-title]")?.textContent).toBe("Muudatust „Kohti“ ei saanud veel salvestada.");
    expect(notice()?.querySelector("[data-leave-reason]")?.textContent).toBe(text);
    await click(button("Jää siia"));
    expect(document.activeElement).toBe(document.querySelector("#seats"));
  });

  it("a record not created yet (S3-P3-g): the reason names the thing, „Koolitust pole veel lisatud.“", async () => {
    expect(adminEt.leave.reasons.notCreated).toBe("{thing} pole veel lisatud.");
    function NotCreated() {
      useGuardSource({ id: "new", label: () => "Koolituse nimi", flush: async () => false, unconfirmed: () => ({ reason: "notCreated", thing: "Koolitust" }), focus: () => {} });
      return null;
    }
    await mount(createElement(NotCreated));
    await click(menu());
    expect(router.push).not.toHaveBeenCalled();
    expect(notice()?.querySelector("[data-leave-title]")?.textContent).toBe("Muudatust „Koolituse nimi“ ei saanud veel salvestada.");
    expect(notice()?.querySelector("[data-leave-reason]")?.textContent).toBe("Koolitust pole veel lisatud.");
    expect(unload()).toBe(true); // closing the tab asks too
  });

  it("„Sulge, tekst jääb seadmesse“ leaves; the local copy stays for next time", async () => {
    await mount();
    await type("title", "Uus nimi");
    await click(menu());
    await answer(null);
    await click(button("Sulge, tekst jääb seadmesse"));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith("/admin/kalender");
    expect(notice()).toBeNull();
    // the page goes (the editor unmounts) and comes back later: the text is there again
    await act(async () => root.render(createElement(LeaveGuardProvider, null, null)));
    const copies = storageKeys().filter((k) => k.startsWith("mslab-draft:course:12:"));
    expect(copies).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(copies[0])!).fields.title).toBe("Uus nimi");
    s = server();
    await mount();
    expect(probe.current!.fields.title).toBe("Uus nimi");
    expect(field("title")!.value).toBe("Uus nimi");
  });

  it("only a plain click that leaves the page is held: a new tab, a modifier key, a download, another site, the same page's own link go untouched", async () => {
    await mount();
    await type("title", "Uus nimi");
    const nav = document.querySelector("nav")!;
    const extra = (attrs: Record<string, string>) => {
      const a = document.createElement("a");
      for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
      a.textContent = "x";
      nav.append(a);
      return a;
    };
    const cases: [string, () => Promise<MouseEvent>][] = [
      ["target", () => click(extra({ href: "/admin/kalender", target: "_blank" }))],
      ["download", () => click(extra({ href: "/admin/arved/1.pdf", download: "" }))],
      ["elsewhere", () => click(extra({ href: "https://example.test/admin" }))],
      ["api", () => click(extra({ href: "/api/admin/preview" }))],
      ["same page", () => click(document.querySelector("[data-same]"))],
      [
        "ctrl",
        () =>
          act(async () => {
            const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
            menu()!.dispatchEvent(e);
            return e;
          }),
      ],
    ];
    for (const [how, go] of cases) {
      followed.mockReset();
      await go();
      expect(followed, how).toHaveBeenCalledTimes(1);
    }
    expect(s.calls).toHaveLength(0);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a held link in the phone menu closes the menu, so the page's notice can be seen and pressed", async () => {
    await mount();
    const phone = document.createElement("dialog");
    phone.setAttribute("data-admin-drawer", "");
    const link = document.createElement("a");
    link.setAttribute("href", "/admin/kalender");
    phone.append(link);
    document.body.append(phone);
    phone.showModal();
    await type("title", "Uus nimi");
    await click(link);
    expect(phone.open).toBe(false);
    await answer(null);
    expect(notice()).not.toBeNull();
    expect(phone.contains(notice())).toBe(false);
  });
});

describe("the leave guard: Back", () => {
  it("Back (popstate) is held the same way", async () => {
    await mount();
    const nextPop = vi.fn();
    window.addEventListener("popstate", nextPop); // Next.js's own handler, registered after the guard's
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    /** The browser goes back a page: the address and the state are the list's, then popstate. */
    const goBack = () =>
      act(async () => {
        history.replaceState({ __NA: true, at: "list" }, "", "/admin/koolitused");
        window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        await vi.advanceTimersByTimeAsync(0);
      });

    // nothing unsaved: Back is Next's
    await goBack();
    expect(nextPop).toHaveBeenCalledTimes(1);
    nextPop.mockReset();
    history.pushState({ __NA: true, at: "course" }, "", "/admin/koolitused/12"); // and forward to the course again

    // typed: Back is held, the address put back, the save sent; confirmed: back for real
    await type("title", "Uus nimi");
    await goBack();
    expect(nextPop).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/admin/koolitused/12");
    expect(history.state).toEqual({ __NA: true, at: "course" });
    expect(s.calls).toHaveLength(1);
    expect(back).not.toHaveBeenCalled();
    await answer(ok("v2"));
    expect(back).toHaveBeenCalledTimes(1);
    // the browser's next popstate (that back) is let through to Next
    await act(async () => {
      history.replaceState({ __NA: true, at: "list" }, "", "/admin/koolitused");
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    expect(nextPop).toHaveBeenCalledTimes(1);
    window.removeEventListener("popstate", nextPop);
  });

  it("Back when the save can't go through: the notice; „Jää siia“ stays on the page, „Sulge, tekst jääb seadmesse“ goes back", async () => {
    await mount();
    const nextPop = vi.fn();
    window.addEventListener("popstate", nextPop);
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    await type("title", "Uus nimi");
    await act(async () => {
      history.replaceState({ __NA: true, at: "list" }, "", "/admin/koolitused");
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    await answer(null);
    expect(notice()?.querySelector("[data-leave-title]")?.textContent).toBe("Muudatust „Koolituse nimi“ ei saanud veel salvestada.");
    expect(window.location.pathname).toBe("/admin/koolitused/12");
    await click(button("Jää siia"));
    expect(back).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field("title"));
    expect(window.location.pathname).toBe("/admin/koolitused/12");

    await act(async () => {
      history.replaceState({ __NA: true, at: "list" }, "", "/admin/koolitused");
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    await answer(null);
    await click(button("Sulge, tekst jääb seadmesse"));
    expect(back).toHaveBeenCalledTimes(1);
    expect(nextPop).not.toHaveBeenCalled();
    window.removeEventListener("popstate", nextPop);
  });
});

describe("the leave guard: drawers", () => {
  function DrawerPage() {
    return createElement(
      LeaveGuardProvider,
      null,
      createElement("a", { id: "row", href: "/admin/kalender?id=12" }, "20.10.2026"),
      createElement(
        Drawer,
        { label: "Kulmumeistri baaskoolitus", closeHref: "/admin/kalender", closeLabel: adminEt.common.close, returnFocus: "row" } as Parameters<typeof Drawer>[0],
        createElement(Editor, { owner: "session", fields: { seats: "8" } }),
      ),
    );
  }

  it("Drawer ✕, Esc and the backdrop all go through requestLeave; the close label is „Sulge“", async () => {
    history.replaceState({ __NA: true }, "", "/admin/kalender?id=12");
    await act(async () => root.render(createElement(DrawerPage)));
    const dialog = document.querySelector<HTMLDialogElement>("dialog[data-drawer]")!;
    const x = dialog.querySelector<HTMLButtonElement>(`button[aria-label="${adminEt.common.close}"]`)!;
    expect(adminEt.common.close).toBe("Sulge");
    expect(x).not.toBeNull();

    const closers: [string, () => Promise<unknown>][] = [
      ["✕", () => click(x)],
      [
        "Esc",
        () =>
          act(async () => {
            const e = new Event("cancel", { cancelable: true });
            dialog.dispatchEvent(e);
            if (!e.defaultPrevented) dialog.close();
            await vi.advanceTimersByTimeAsync(0);
          }),
      ],
      ["the backdrop", () => click(dialog)],
    ];
    let n = 0;
    for (const [how, close] of closers) {
      await type("seats", String(10 + n++));
      await close();
      expect(dialog.open, how).toBe(true);
      expect(router.replace, how).not.toHaveBeenCalled();
      await answer(null);
      const asked = notice();
      expect(asked, how).not.toBeNull();
      expect(dialog.contains(asked), how).toBe(true); // at the top of the drawer, inside the dialog
      expect(asked!.querySelector("[data-leave-title]")?.textContent, how).toBe("Muudatust „Kohti“ ei saanud veel salvestada.");
      expect(document.activeElement, how).toBe(asked);
      await click(button("Jää siia"));
      expect(notice(), how).toBeNull();
      expect(dialog.open, how).toBe(true);
      expect(document.activeElement, how).toBe(field("seats"));
    }

    // a save in flight: the drawer waits for it, then closes; the address goes back and the focus to the row
    await type("seats", "20");
    await click(x);
    expect(dialog.open).toBe(true);
    await answer(ok("v2"));
    expect(dialog.open).toBe(false);
    expect(router.replace).toHaveBeenCalledWith("/admin/kalender", { scroll: false });
    expect(document.activeElement).toBe(document.getElementById("row"));
  });
});

describe("the leave guard: closing the tab", () => {
  it("beforeunload is set only while something is unconfirmed", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const unloads = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === "beforeunload").length;
    await mount();
    expect(unloads(add)).toBe(0);
    expect(unload()).toBe(false);
    await type("title", "Uus nimi");
    expect(unloads(add)).toBe(1);
    expect(unload()).toBe(true);
    await advance(DEBOUNCE_MS);
    expect(unload()).toBe(true); // on its way: not confirmed yet
    await answer(ok("v2"));
    expect(unloads(remove)).toBe(1);
    expect(unload()).toBe(false);
    expect(unloads(add)).toBe(1);
  });
});
