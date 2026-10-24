// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminLesson } from "@/server/admin-lessons";
import type { EditResult } from "@/server/edit-check";
import { stubFetch } from "../fakes";

// The lesson drawer (admin UX pass piece 3a, Task 10; README B2 lesson drawer, §1.5, §1.7; piece3-texts S3-P3-c, S3-P3-e, P-2): the header „Moodul {nn} ·
// Õppetund {n.n}“, the name and SaveStatus left of ✕; „Õppetunni nimi“ and „Lühike tekst“ autosave on their own route (api/admin/oppetund/<id> from
// the lesson's „t:“ version, R-b2: no „Salvesta“, no whole-outline write); „Õppetunni liik“ instant, Video → Tekst with a video asks in a ConfirmPanel;
// „Failid“: a drop zone and the list, „Eemalda“ at once with the UndoBar „Fail eemaldatud.“ (in the open dialog), whose „Võta tagasi“ brings it back;
// the switch „Õpilastele nähtav“ with the existing hint, off with the UndoBar „Õppetund peidetud.“, on with none; „Kustuta õppetund“ only without
// progress, in a ConfirmPanel; ✕ asks only through the leave guard (an upload running: reason `upload`); no ET | RU switch (Dim 22.10).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({
  setLessonKind: vi.fn(),
  setLessonHidden: vi.fn(),
  deleteLesson: vi.fn(),
  removeLessonFile: vi.fn(),
  undoRemoveLessonFile: vi.fn(),
  createLessonVideo: vi.fn(),
  checkLessonVideo: vi.fn(),
}));
vi.mock("@/server/actions/admin-lessons", () => actions);
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
const uploads = vi.hoisted(() => [] as { options: Record<string, unknown>; abort: ReturnType<typeof vi.fn> }[]);
vi.mock("tus-js-client", () => ({
  Upload: class FakeUpload {
    start = vi.fn();
    abort = vi.fn(async () => {});
    constructor(_file: File, options: Record<string, unknown>) {
      uploads.push({ options, abort: this.abort });
    }
  },
}));

import { Drawer } from "@/components/admin/Drawer";
import { LeaveGuardProvider } from "@/components/admin/LeaveGuard";
import { LessonDrawer } from "@/components/admin/LessonDrawer";
import { UndoProvider } from "@/components/admin/UndoBar";

const FILE = { id: 31, name: "Juhend.pdf", size: 220_000, contentType: "application/pdf" };
const TICKET = { videoId: "v", libraryId: "424242", expires: 99, signature: "sig", endpoint: "https://tus.example/tusupload", title: "K · L" };
const lessonOf = (over: Partial<AdminLesson> = {}): AdminLesson => ({
  id: 23,
  moduleId: 2,
  title: { et: "Tund" },
  body: null,
  version: "t:l23",
  kind: "video",
  hidden: false,
  unpublished: false,
  changed: false,
  videoStatus: "none",
  videoProgress: null,
  durationSec: null,
  replacing: false,
  inUse: false,
  files: [],
  ...over,
});

type DrawerProps = Parameters<typeof LessonDrawer>[0];
let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
/** The lesson route's answers: each save of the version it holds is stored and moves it; a held answer waits for `release`. */
let version = "t:l23";
let hold: Promise<void> | null = null;
const lessonRoute = async (url: string, init: RequestInit | undefined): Promise<Response> => {
  if (url === "/api/admin/lesson-file") {
    if (hold) await hold;
    return Response.json({ ok: true, file: FILE }, { status: 201 });
  }
  if (!/^\/api\/admin\/oppetund\/23$/.test(url)) return Response.json({ ok: false }, { status: 404 });
  if (hold) await hold;
  const body = JSON.parse(String(init?.body)) as { version: string };
  if (body.version !== version) return Response.json({ ok: false, error: "conflict", version, value: null }, { status: 409 });
  version = `${version}+`;
  return Response.json({ ok: true, version, savedAt: "2026-10-24T11:03:00.000Z" });
};

/** The page round the drawer as the (panel) layout has it: the guard, the UndoBar, the row's „›“ the focus goes back to. */
const page = (over: Partial<DrawerProps> = {}, open = true) =>
  createElement(
    LeaveGuardProvider,
    null,
    createElement(
      UndoProvider,
      null,
      createElement("a", { id: "edit-lesson-23", href: "/admin/koolitused/7?oppetund=23" }, "›"),
      open &&
        createElement(
          Drawer,
          { label: "Õppetund: Tund", closeHref: "/admin/koolitused/7", closeLabel: "Sulge", returnFocus: "edit-lesson-23" } as Parameters<typeof Drawer>[0],
          createElement(LessonDrawer, { courseId: 7, published: false, lesson: lessonOf(), place: { module: 2, lesson: 3 }, bunnyReady: true, ...over }),
        ),
    ),
  );
const show = (over: Partial<DrawerProps> = {}, open = true) => act(async () => root.render(page(over, open)));

const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-drawer]")!;
const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const buttonNamed = (name: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((b) => text(b) === name || b.getAttribute("aria-label") === name) ?? null;
const bar = () => $("[data-undo-bar]");
/** Types into a text field as a person does (React listens to the input event). */
const type = async (el: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
  expect(el, "the field to type in").not.toBeNull();
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const leave = (el: Element | null) => act(async () => void el!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const nameField = () => $<HTMLInputElement>("[data-i18n='lesson-title']");
const bodyField = () => $<HTMLTextAreaElement>("[data-i18n='lesson-body']");
const radio = (kind: "video" | "text") => $<HTMLInputElement>(`[data-lesson-kind] input[value='${kind}']`)!;
const visible = () => $<HTMLInputElement>("[data-lesson-visibility] input[role='switch']")!;
const formOf = (call: unknown[]) => Object.fromEntries((call[1] as FormData).entries());
const OK = (id = 23): EditResult => ({ ok: true, id });

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
  actions.setLessonKind.mockResolvedValue(OK());
  actions.setLessonHidden.mockResolvedValue(OK());
  actions.deleteLesson.mockResolvedValue(OK());
  actions.removeLessonFile.mockResolvedValue(OK(31));
  actions.undoRemoveLessonFile.mockResolvedValue(OK(31));
  actions.checkLessonVideo.mockResolvedValue({ ok: false, error: "server" });
  uploads.length = 0;
  version = "t:l23";
  hold = null;
  localStorage.clear();
  history.replaceState({ __NA: true }, "", "/admin/koolitused/7?oppetund=23");
  fetched = stubFetch(lessonRoute);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  fetched.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the header (README B2)", () => {
  it("reads „Moodul 02 · Õppetund 2.3“, the lesson's name and its SaveStatus, left of ✕ „Sulge“; no „Salvesta“ and no ET | RU switch", async () => {
    await show();
    const head = $("[data-lesson-head]")!;
    expect(text(head.querySelector("[data-lesson-place]"))).toBe("Moodul 02 · Õppetund 2.3");
    expect(text(head.querySelector("h2"))).toBe("Tund");
    expect(head.querySelector("[data-save-status]")).not.toBeNull();
    expect(buttonNamed("Sulge", dialog())).not.toBeNull();
    expect(buttonNamed("Salvesta", dialog())).toBeNull();
    expect(dialog().querySelector("[data-lang-switch], [data-edit-lang]")).toBeNull();
  });

  it("a module past 9 keeps two digits: „Moodul 12 · Õppetund 12.1“", async () => {
    await show({ place: { module: 12, lesson: 1 } });
    expect(text($("[data-lesson-place]"))).toBe("Moodul 12 · Õppetund 12.1");
  });
});

describe("„Õppetunni nimi“ and „Lühike tekst“ autosave (R-b2)", () => {
  it("a short text saves on its route from the lesson's „t:“ version when the field is left; the page is read again; the chip says it", async () => {
    await show();
    await type(bodyField(), "Loe ja vaata.");
    expect($("[data-save-status]")?.getAttribute("data-save-kind")).toBe("dirty");
    await leave(bodyField());
    await settle();
    expect(fetched.calls.map((c) => [c.method, c.url, c.body])).toEqual([["POST", "/api/admin/oppetund/23", { version: "t:l23", patch: { body: { et: "Loe ja vaata." } } }]]);
    expect($("[data-save-status]")?.getAttribute("data-save-kind")).toBe("saved");
    expect(text($("[data-save-status] [data-save-text]"))).toBe("✓ Salvestatud 14:03");
    // the row behind the drawer (its name) and, on a published course, the PublishBar's labels are the page's: it is read again
    expect(router.refresh).toHaveBeenCalledOnce();
    // nothing else writes: no outline part, no form
    expect(fetched.calls.some((c) => c.url.includes("/osa/"))).toBe(false);
  });

  it("on a published course the chip is the draft's: „Mustand salvestatud {HH:MM}“", async () => {
    await show({ published: true });
    await type(nameField(), "Tere tulemast");
    await leave(nameField());
    await settle();
    expect(fetched.calls[0].body).toEqual({ version: "t:l23", patch: { title: { et: "Tere tulemast" } } });
    expect(text($("[data-save-status] [data-save-text]"))).toBe("✓ Mustand salvestatud 14:03");
  });

  it("the header's name follows the field as it is typed (a blank field keeps the stored name)", async () => {
    await show();
    await type(nameField(), "Tere tulemast");
    expect(text($("[data-lesson-head] h2"))).toBe("Tere tulemast");
    await type(nameField(), "  ");
    expect(text($("[data-lesson-head] h2"))).toBe("Tund");
  });

  it("a blank name is held back with „Kirjuta nimi.“ and nothing is sent; a text of 5001 characters with „Liiga pikk.“", async () => {
    await show();
    await type(nameField(), "");
    await leave(nameField());
    await settle();
    expect(fetched.calls).toEqual([]);
    expect($("[data-save-status]")?.getAttribute("data-save-kind")).toBe("invalid");
    expect(nameField()?.getAttribute("aria-invalid")).toBe("true");
    expect(dialog().textContent).toContain("Kirjuta nimi.");
    await type(nameField(), "Tund");
    await type(bodyField(), "x".repeat(5001));
    await leave(bodyField());
    await settle();
    expect(fetched.calls).toEqual([]);
    expect(bodyField()?.getAttribute("aria-invalid")).toBe("true");
    expect(dialog().textContent).toContain("Liiga pikk.");
  });

  it("✕ with a text not saved yet: the guard saves it first and the drawer closes (no question of the drawer's own)", async () => {
    let release = () => {};
    hold = new Promise<void>((resolve) => (release = resolve));
    await show();
    await type(bodyField(), "Veel üks lõik.");
    await click(buttonNamed("Sulge", dialog()));
    expect(dialog().open).toBe(true); // waiting for the save (at most 3 s)
    expect(fetched.calls).toHaveLength(1);
    release();
    await settle();
    expect(dialog().open).toBe(false);
    expect(router.replace).toHaveBeenCalledWith("/admin/koolitused/7", { scroll: false });
    expect($("[data-leave-notice]")).toBeNull();
  });
});

describe("„Õppetunni liik“ (README B2): instant; Video → Tekst with a video asks first", () => {
  it("the ConfirmPanel says „Kas vahetan liigi?“ · „Video kustutatakse.“ with „Jah, vaheta“ / „Katkesta“; „Katkesta“ keeps Video", async () => {
    await show({ lesson: lessonOf({ videoStatus: "ready", durationSec: 754 }) });
    await click(radio("text"));
    const panel = $("[data-lesson-kind] [data-confirm-panel]")!;
    expect(panel).not.toBeNull();
    expect(text(panel.querySelector("p"))).toBe("Kas vahetan liigi?");
    expect(Array.from(panel.querySelectorAll("li")).map(text)).toEqual(["Video kustutatakse."]);
    expect(Array.from(panel.querySelectorAll("button")).map(text)).toEqual(["Jah, vaheta", "Katkesta"]);
    expect(document.activeElement).toBe(panel);
    expect(actions.setLessonKind).not.toHaveBeenCalled();
    await click(buttonNamed("Katkesta", panel));
    expect($("[data-lesson-kind] [data-confirm-panel]")).toBeNull();
    expect(radio("video").checked).toBe(true);
    expect(document.activeElement).toBe(radio("video"));
    expect(actions.setLessonKind).not.toHaveBeenCalled();
    await click(radio("text"));
    await click(buttonNamed("Jah, vaheta"));
    await settle();
    expect(actions.setLessonKind).toHaveBeenCalledOnce();
    expect(formOf(actions.setLessonKind.mock.calls[0])).toEqual({ id: "23", kind: "text" });
    expect($("[data-lesson-kind] [data-confirm-panel]")).toBeNull();
    expect(document.activeElement).toBe(radio("text"));
  });

  it("without a video Tekst is saved at once, with no question; a refusal puts the stored kind back and says why", async () => {
    await show();
    await click(radio("text"));
    await settle();
    expect($("[data-confirm-panel]")).toBeNull();
    expect(formOf(actions.setLessonKind.mock.calls[0])).toEqual({ id: "23", kind: "text" });
    actions.setLessonKind.mockResolvedValue({ ok: false, error: "notFound" });
    await show({ lesson: lessonOf({ kind: "text" }) });
    await click(radio("video"));
    await settle();
    expect(radio("text").checked).toBe(true);
    expect(text($("[data-kind-error]"))).toBe("Seda ei leitud. Laadi leht uuesti.");
  });
});

describe("„Failid“ (README B2, S3-P3-c): a drop zone and the list; „Eemalda“ at once with the UndoBar", () => {
  it("„Eemalda“ takes the row away at once and puts up „Fail eemaldatud.“ inside the open dialog; „Võta tagasi“ brings the file back", async () => {
    await show({ lesson: lessonOf({ files: [FILE] }) });
    const row = $("[data-lesson-file='31']")!;
    expect(text(row)).toContain("Juhend.pdf · 220 kB");
    await click(buttonNamed("Eemalda fail: Juhend.pdf"));
    expect($("[data-lesson-file='31']")).toBeNull();
    await settle();
    expect(actions.removeLessonFile).toHaveBeenCalledExactlyOnceWith(31);
    expect(text(bar()?.querySelector("p") ?? null)).toBe("Fail eemaldatud.");
    // the bar is inside the modal dialog, where it can be pressed (the page behind it is inert)
    expect(bar()?.closest("dialog[data-drawer]")).toBe(dialog());
    // the page's read after the removal: the file is not in it
    await show({ lesson: lessonOf({ files: [] }) });
    expect($("[data-lesson-file='31']")).toBeNull();
    // (a press of a button focuses it in Chrome and Firefox: the focus is in the bar, which goes with the undo)
    await act(async () => buttonNamed("Võta tagasi")!.focus());
    await click(buttonNamed("Võta tagasi"));
    await settle();
    expect(actions.undoRemoveLessonFile).toHaveBeenCalledExactlyOnceWith(31);
    expect(bar()).toBeNull();
    // the read after the undo has it again, and the focus (which went with the bar) is on its „Eemalda“
    await show({ lesson: lessonOf({ files: [FILE] }) });
    await settle();
    expect($("[data-lesson-file='31']")).not.toBeNull();
    expect(document.activeElement).toBe(buttonNamed("Eemalda fail: Juhend.pdf"));
  });

  it("an undo the server refuses (the file was purged meanwhile) says the bar's „Salvestamine ei õnnestunud. Proovi uuesti.“ (ADM:162)", async () => {
    actions.undoRemoveLessonFile.mockResolvedValue({ ok: false, error: "notFound" });
    await show({ lesson: lessonOf({ files: [FILE] }) });
    await click(buttonNamed("Eemalda fail: Juhend.pdf"));
    await settle();
    await click(buttonNamed("Võta tagasi"));
    await settle();
    expect(text(bar()?.querySelector("p") ?? null)).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
  });

  it("a removal the server refuses brings the row back with the reason, and no bar", async () => {
    actions.removeLessonFile.mockResolvedValue({ ok: false, error: "server" });
    await show({ lesson: lessonOf({ files: [FILE] }) });
    await click(buttonNamed("Eemalda fail: Juhend.pdf"));
    await settle();
    expect($("[data-lesson-file='31']")).not.toBeNull();
    expect(bar()).toBeNull();
    expect(text($("[data-lesson-files] [role='alert']"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
  });

  it("the bar's undo is the server's (a marked row): it stays when the drawer closes, and still brings the file back", async () => {
    await show({ lesson: lessonOf({ files: [FILE] }) });
    await click(buttonNamed("Eemalda fail: Juhend.pdf"));
    await settle();
    await show({}, false);
    expect(text(bar()?.querySelector("p") ?? null)).toBe("Fail eemaldatud.");
    await click(buttonNamed("Võta tagasi"));
    await settle();
    expect(actions.undoRemoveLessonFile).toHaveBeenCalledExactlyOnceWith(31);
  });

  it("the drop zone: „Lohista fail siia või vali fail · PDF, Word, pilt, kuni 4 MB“, the phone's „Vali fail“; a dropped file is uploaded", async () => {
    await show();
    const zone = $("[data-file-drop]")!;
    expect(text(zone.querySelector("[data-drop-wide]"))).toBe("Lohista fail siia või vali fail · PDF, Word, pilt, kuni 4 MB");
    expect(text(zone.querySelector("[data-drop-phone]"))).toBe("Vali fail");
    // the zone is the file input's label: a tap anywhere on it opens the picker
    const input = $<HTMLInputElement>("[data-lesson-files] input[type='file']")!;
    expect(Array.from(input.labels ?? [])).toContain(zone);
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "Juhend.pdf", { type: "application/pdf" });
    await act(async () => {
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: { files: [file], types: ["Files"] } });
      zone.dispatchEvent(drop);
    });
    await settle();
    expect(fetched.calls.map((c) => [c.method, c.url])).toEqual([["POST", "/api/admin/lesson-file"]]);
    expect((fetched.calls[0].body as FormData).get("lessonId")).toBe("23");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a file dropped beside the drop zone (the head, a field, ✕, the backdrop) does nothing: never the browser's own drop, which opens it in the tab (final review P10-2)", async () => {
    await show();
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "Juhend.pdf", { type: "application/pdf" });
    /** A drag event at `el` carrying `types`; true when something on the page took it (the browser's own action prevented). */
    const drag = (kind: "dragover" | "drop", el: Element, types: string[] = ["Files"]) => {
      const e = new Event(kind, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: { files: types.includes("Files") ? [file] : [], types } });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const beside = [$("[data-lesson-head]")!, nameField()!, $("[data-lesson-visibility]")!, buttonNamed("Sulge", dialog())!, dialog()];
    await act(async () => {
      for (const el of beside) {
        expect(drag("dragover", el), el.tagName).toBe(true);
        expect(drag("drop", el), el.tagName).toBe(true);
      }
    });
    await settle();
    // nothing is uploaded, and the drawer stays
    expect(fetched.calls).toEqual([]);
    expect(dialog().open).toBe(true);
    // a text dragged inside a field is the browser's (it moves the text): left alone
    expect(drag("dragover", nameField()!, ["text/plain"])).toBe(false);
    expect(drag("drop", bodyField()!, ["text/plain"])).toBe(false);
    // and the zone's own drop still uploads
    await act(async () => void drag("drop", $("[data-file-drop]")!));
    await settle();
    expect(fetched.calls.map((c) => [c.method, c.url])).toEqual([["POST", "/api/admin/lesson-file"]]);
  });

  it("✕ while a file uploads asks through the guard: „Muudatust „Failid“ ei saanud veel salvestada.“ · „Üleslaadimine käib.“", async () => {
    let release = () => {};
    hold = new Promise<void>((resolve) => (release = resolve));
    await show();
    const input = $<HTMLInputElement>("[data-lesson-files] input[type='file']")!;
    Object.defineProperty(input, "files", { value: [new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf", { type: "application/pdf" })], configurable: true });
    await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
    await click(buttonNamed("Sulge", dialog()));
    await settle();
    expect(dialog().open).toBe(true);
    expect(text($("[data-leave-notice='drawer'] [data-leave-title]"))).toBe("Muudatust „Failid“ ei saanud veel salvestada.");
    expect(text($("[data-leave-notice='drawer'] [data-leave-reason]"))).toBe("Üleslaadimine käib.");
    release();
    await settle();
  });
});

describe("„Õpilastele nähtav“ (README B2, S3-P3-c; the shared Switch)", () => {
  it("off: „Õppetund peidetud.“ with „Võta tagasi“ (which shows it again); on: no bar", async () => {
    await show();
    expect(visible().checked).toBe(true);
    expect(visible().getAttribute("role")).toBe("switch");
    expect(visible().labels?.[0]?.textContent).toContain("Õpilastele nähtav");
    await click(visible());
    await settle();
    expect(formOf(actions.setLessonHidden.mock.calls[0])).toEqual({ id: "23", hidden: "1" });
    expect(text(bar()?.querySelector("p") ?? null)).toBe("Õppetund peidetud.");
    expect(bar()?.closest("dialog[data-drawer]")).toBe(dialog());
    await show({ lesson: lessonOf({ hidden: true }) });
    expect(visible().checked).toBe(false);
    await click(buttonNamed("Võta tagasi"));
    await settle();
    expect(formOf(actions.setLessonHidden.mock.calls[1])).toEqual({ id: "23", hidden: "0" });
    expect(bar()).toBeNull();
    // switched on by hand: no bar (it is its own reverse), and a hide's bar still up goes with it
    await show({ lesson: lessonOf({ hidden: false }) });
    await click(visible());
    await settle();
    expect(text(bar()?.querySelector("p") ?? null)).toBe("Õppetund peidetud.");
    await show({ lesson: lessonOf({ hidden: true }) });
    await click(visible());
    await settle();
    expect(formOf(actions.setLessonHidden.mock.calls[3])).toEqual({ id: "23", hidden: "0" });
    expect(bar()).toBeNull();
  });

  it("a lesson with progress: the existing hint under the switch, linked to it; no „Kustuta õppetund“", async () => {
    await show({ lesson: lessonOf({ inUse: true }) });
    const hint = Array.from(document.querySelectorAll("[data-lesson-visibility] [id]")).find((el) => text(el) === "Õppetunnil on õpilaste edenemist: seda saab ainult peita.");
    expect(hint).toBeDefined();
    expect((visible().getAttribute("aria-describedby") ?? "").split(" ")).toContain(hint!.id);
    expect(buttonNamed("Kustuta õppetund")).toBeNull();
  });

  it("a refused switch keeps the stored state and says why under it", async () => {
    actions.setLessonHidden.mockResolvedValue({ ok: false, error: "server" });
    await show();
    await click(visible());
    await settle();
    expect(visible().checked).toBe(true);
    expect(bar()).toBeNull();
    const alert = $("[data-lesson-visibility] [role='alert']")!;
    expect(text(alert)).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect((visible().getAttribute("aria-describedby") ?? "").split(" ")).toContain(alert.id);
  });
});

describe("„Kustuta õppetund“ (README B2): only without progress, after a ConfirmPanel", () => {
  it("today's question with „Jah, kustuta“ / „Katkesta“; „Katkesta“ gives the button back with the focus; yes deletes", async () => {
    await show();
    await click(buttonNamed("Kustuta õppetund"));
    const panel = $("[data-delete-lesson] [data-confirm-panel]")!;
    expect(text(panel.querySelector("p"))).toBe("Kas kustutan õppetunni „Tund“ koos video ja failidega?");
    expect(Array.from(panel.querySelectorAll("button")).map(text)).toEqual(["Jah, kustuta", "Katkesta"]);
    await click(buttonNamed("Katkesta", panel));
    expect(document.activeElement).toBe(buttonNamed("Kustuta õppetund"));
    await click(buttonNamed("Kustuta õppetund"));
    await click(buttonNamed("Jah, kustuta"));
    await settle();
    expect(formOf(actions.deleteLesson.mock.calls[0])).toEqual({ id: "23", courseId: "7" });
  });

  it("a refusal (progress came meanwhile) keeps the panel and says „Õppetunnil on õpilaste edenemist: seda saab ainult peita.“", async () => {
    actions.deleteLesson.mockResolvedValue({ ok: false, error: "inUse" });
    await show();
    await click(buttonNamed("Kustuta õppetund"));
    await click(buttonNamed("Jah, kustuta"));
    await settle();
    expect($("[data-delete-lesson] [data-confirm-panel]")).not.toBeNull();
    expect(text($("[data-delete-lesson] [role='alert']"))).toBe("Õppetunnil on õpilaste edenemist: seda saab ainult peita.");
  });
});

describe("the video while it uploads (README B2 focus and announcements)", () => {
  it("✕ asks through the leave guard (reason upload): „Muudatust „Video“ …“ · „Üleslaadimine käib.“; „Jää siia“ goes to the progress line", async () => {
    actions.createLessonVideo.mockResolvedValue({ ok: true, ticket: TICKET });
    await show();
    const input = $<HTMLInputElement>("[data-lesson-video] input[type='file']")!;
    await act(async () => input.focus());
    Object.defineProperty(input, "files", { value: [new File([new Uint8Array(10)], "tund.mp4", { type: "video/mp4" })], configurable: true });
    await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
    expect(uploads).toHaveLength(1);
    // the input went with the pick: the focus is on the progress line, not lost to the page
    expect(document.activeElement).toBe($("[data-lesson-video] [data-video-status]"));
    await click(buttonNamed("Sulge", dialog()));
    await settle();
    expect(dialog().open).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();
    expect(text($("[data-leave-notice='drawer'] [data-leave-title]"))).toBe("Muudatust „Video“ ei saanud veel salvestada.");
    expect(text($("[data-leave-notice='drawer'] [data-leave-reason]"))).toBe("Üleslaadimine käib.");
    await click(buttonNamed("Jää siia"));
    expect(document.activeElement).toBe($("[data-lesson-video] [data-video-status]"));
    expect(uploads[0].abort).not.toHaveBeenCalled();
  });
});
