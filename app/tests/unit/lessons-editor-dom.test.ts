// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LessonsEditor } from "@/components/admin/LessonsEditor";
import { DEBOUNCE_MS } from "@/components/admin/autosave/constants";
import { LESSON_LIMITS } from "@/domain/lesson-limits";
import type { AdminLesson, AdminModule } from "@/server/admin-lessons";
import { stubFetch } from "../fakes";

// „Moodulid ja õppetunnid“ / „Programm“ (admin UX pass piece 3a, Task 9; README B2, B18; piece3-texts P-3, P-4, S3-P3-e, S3-P3-m): the module rows
// have the handle ⋮⋮ and ↑ / ↓ (DragList: one `moveModuleTo` per move), the module's name edits in its row and autosaves on its own route
// (POST /api/admin/moodul/<id>, its „t:“ version, R-b2; no „Salvesta“), the lesson rows show the video tags „Valmis“ / „Töötlemisel {n}%“ (or
// „Töötlemisel“) / „Video puudub“ / „Tekst“, a changed or new row says „avaldamata“, and a delete asks in a ConfirmPanel: „Kas kustutan punkti
// „{title}“?“ for a contact course's programme point, today's question for a module.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({
  addLesson: vi.fn(),
  addModule: vi.fn(),
  deleteModule: vi.fn(),
  moveLessonInList: vi.fn(),
  moveModuleTo: vi.fn(),
}));
vi.mock("@/server/actions/admin-lessons", () => actions);

const ROW = 100; // a module row's height in the faked layout

let container: HTMLDivElement;
let root: Root;
let restoreRect: () => void;
let fetched: ReturnType<typeof stubFetch>;

const lesson = (id: number, moduleId: number, over: Partial<AdminLesson> = {}): AdminLesson => ({
  id,
  moduleId,
  title: { et: `Tund ${id}` },
  body: null,
  version: `t:l${id}`,
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
const moduleOf = (id: number, title: string, lessons: AdminLesson[] = [], over: Partial<AdminModule> = {}): AdminModule => ({
  id,
  title: { et: title },
  version: `t:m${id}`,
  unpublished: false,
  changed: false,
  deletable: lessons.length === 0,
  lessons,
  ...over,
});

type Props = Parameters<typeof LessonsEditor>[0];
const show = (over: Partial<Props> = {}) =>
  act(async () => root.render(createElement(LessonsEditor, { courseId: 7, online: true, modules: [moduleOf(1, "Alustame"), moduleOf(2, "Kujud")], ...over })));

const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => Array.from(container.querySelectorAll<E>(selector));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const buttonNamed = (name: string, scope: ParentNode = container) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((b) => text(b) === name || b.getAttribute("aria-label") === name) ?? null;
const titleField = (id: number) => $<HTMLInputElement>(`[data-i18n="module-${id}"]`);
/** Types into an input as a person does (React listens to the input event). */
const type = async (el: HTMLInputElement | null, value: string) => {
  expect(el, "the field to type in").not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const leave = (el: Element | null) => act(async () => void el!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

type Pointer = { pointerId?: number; pointerType?: string; clientY?: number };
const pointer = (el: Element, kind: "pointerdown" | "pointermove" | "pointerup", init: Pointer = {}) =>
  act(async () => void el.dispatchEvent(new PointerEvent(kind, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", button: 0, isPrimary: true, ...init })));
const moduleRows = () => $$("[data-drag-row]");
const handleOf = (id: number) => $<HTMLButtonElement>(`[data-drag-row="${id}"] [data-drag-tool="handle"]`)!;

/** The module route's answers: a save of the version the row holds is stored („t:<n>“), another version is a conflict. */
const stored = new Map<number, { version: string; title: unknown }>();
/** The versions the route answered, in order. */
const answered: string[] = [];
const moduleRoute = (url: string, init: RequestInit | undefined): Response => {
  const m = url.match(/^\/api\/admin\/moodul\/(\d+)$/);
  if (!m) return Response.json({ ok: false }, { status: 404 });
  const id = Number(m[1]);
  const body = JSON.parse(String(init?.body)) as { version: string; patch: { title?: unknown } };
  const now = stored.get(id) ?? { version: `t:m${id}`, title: null };
  if (body.version !== now.version) return Response.json({ ok: false, error: "conflict", version: now.version, value: { title: now.title } }, { status: 409 });
  const next = { version: `t:m${id}-${Math.random().toString(36).slice(2, 6)}`, title: body.patch.title };
  stored.set(id, next);
  answered.push(next.version);
  return Response.json({ ok: true, version: next.version, savedAt: "2026-10-24T09:41:00.000Z" });
};

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.moveModuleTo.mockResolvedValue({ ok: true, id: 2 });
  actions.deleteModule.mockResolvedValue({ ok: true, id: 1, deleted: true });
  stored.clear();
  answered.length = 0;
  localStorage.clear();
  fetched = stubFetch(moduleRoute);
  // no layout in happy-dom: a module row is 100 px tall and sits at its place among its siblings
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (!this.hasAttribute("data-drag-row")) return original.call(this);
    const top = Array.prototype.indexOf.call(this.parentElement!.children, this) * ROW;
    return { top, bottom: top + ROW, left: 0, right: 600, width: 600, height: ROW, x: 0, y: top, toJSON: () => ({}) };
  };
  restoreRect = () => void (HTMLElement.prototype.getBoundingClientRect = original);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreRect();
  fetched.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the lesson rows' video tags (README B2, P-4, S3-P3-e)", () => {
  it("a processing lesson with progress 40 says „Töötlemisel 40%“; without a number, and at 0, „Töötlemisel“", async () => {
    await show({
      modules: [
        moduleOf(1, "Alustame", [
          lesson(11, 1, { videoStatus: "processing", videoProgress: 40 }),
          lesson(12, 1, { videoStatus: "processing", videoProgress: null }),
          lesson(13, 1, { videoStatus: "processing", videoProgress: 0 }),
        ]),
      ],
    });
    expect(text($('[data-lesson="11"] [data-lesson-video]'))).toBe("Töötlemisel 40%");
    expect(text($('[data-lesson="12"] [data-lesson-video]'))).toBe("Töötlemisel");
    expect(text($('[data-lesson="13"] [data-lesson-video]'))).toBe("Töötlemisel");
  });

  it("„Valmis“, „Video puudub“, „Tekst“, and the two states the mock does not draw keep their words", async () => {
    await show({
      modules: [
        moduleOf(1, "Alustame", [
          lesson(11, 1, { videoStatus: "ready", durationSec: 754 }),
          lesson(12, 1, { videoStatus: "none" }),
          lesson(13, 1, { kind: "text" }),
          lesson(14, 1, { videoStatus: "uploading" }),
          lesson(15, 1, { videoStatus: "failed" }),
        ]),
      ],
    });
    expect(text($('[data-lesson="11"] [data-lesson-video]'))).toBe("Valmis");
    expect(text($('[data-lesson="12"] [data-lesson-video]'))).toBe("Video puudub");
    expect(text($('[data-lesson="13"] [data-lesson-kind="text"]'))).toBe("Tekst");
    expect($('[data-lesson="13"] [data-lesson-video]')).toBeNull();
    expect(text($('[data-lesson="14"] [data-lesson-video]'))).toBe("Video üleslaadimisel");
    expect(text($('[data-lesson="15"] [data-lesson-video]'))).toBe("Video viga");
  });

  it("a lesson row's name is read-only here and opens the drawer by its ›, named „Muuda õppetundi: {nimi}“", async () => {
    await show({ modules: [moduleOf(1, "Alustame", [lesson(11, 1, { title: { et: "Tere tulemast" } })])] });
    const row = $('[data-lesson="11"]')!;
    expect(row.querySelector("input, textarea")).toBeNull();
    expect(text(row.querySelector("[data-lesson-title]"))).toBe("Tere tulemast");
    const open = row.querySelector<HTMLAnchorElement>("a[data-edit-lesson]")!;
    expect(open.id).toBe("edit-lesson-11");
    expect(open.getAttribute("href")).toBe("/admin/koolitused/7?oppetund=11");
    expect(open.getAttribute("aria-label")).toBe("Muuda õppetundi: Tere tulemast");
    expect(text(open)).toBe("›");
  });
});

describe("the module rows: drag and ↑ / ↓ (README B2, S3-P3-m)", () => {
  it("dragging module 2 above module 1 calls the move once, and the list shows the new order at once", async () => {
    let answer: (v: unknown) => void = () => {};
    actions.moveModuleTo.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await show();
    expect(handleOf(2).getAttribute("aria-label")).toBe("Lohista: Kujud");
    expect(handleOf(2).getAttribute("aria-roledescription")).toBe("lohistatav");
    await pointer(handleOf(2), "pointerdown", { clientY: 150 });
    await pointer(handleOf(2), "pointermove", { clientY: 10 });
    await pointer(handleOf(2), "pointerup", { clientY: 10 });
    expect(actions.moveModuleTo).toHaveBeenCalledTimes(1);
    expect(actions.moveModuleTo).toHaveBeenCalledWith({ id: 2, index: 0 });
    expect(moduleRows().map((r) => r.dataset.dragRow)).toEqual(["2", "1"]);
    expect(text($("[data-drag-list] ~ [role=status]"))).toBe("„Kujud“ on nüüd 1. kohal.");
    await act(async () => answer({ ok: true, id: 2 }));
  });

  it("↑ on module 2 is the same move, named „Liiguta üles: {nimi}“; a refused move snaps back and says the list's words (P-1) under the row until the next read", async () => {
    actions.moveModuleTo.mockResolvedValue({ ok: false, error: "server" });
    const modules = [moduleOf(1, "Alustame"), moduleOf(2, "Kujud")];
    await show({ modules });
    const up = $<HTMLButtonElement>('[data-drag-row="2"] [data-drag-tool="up"]')!;
    expect(up.getAttribute("aria-label")).toBe("Liiguta üles: Kujud");
    await click(up);
    await settle();
    expect(actions.moveModuleTo).toHaveBeenCalledExactlyOnceWith({ id: 2, index: 0 });
    expect(moduleRows().map((r) => r.dataset.dragRow)).toEqual(["1", "2"]);
    expect(text($('[data-module="2"] [data-module-error]'))).toBe("Järjekorra muutmine ei õnnestunud. Proovi uuesti.");
    // the same read again changes nothing; the page's next read (another change came) takes the line away (review M-9)
    await show({ modules });
    expect(text($('[data-module="2"] [data-module-error]'))).toBe("Järjekorra muutmine ei õnnestunud. Proovi uuesti.");
    await show({ modules: [...modules] });
    expect($('[data-module="2"] [data-module-error]')).toBeNull();
  });

  it("a name typed in its field names the row at once: the handle, the arrows, the move's announcement and the delete question (review M-5)", async () => {
    await show();
    await type(titleField(2), "Kujud ja vormid");
    expect(handleOf(2).getAttribute("aria-label")).toBe("Lohista: Kujud ja vormid");
    expect($('[data-drag-row="2"] [data-drag-tool="up"]')!.getAttribute("aria-label")).toBe("Liiguta üles: Kujud ja vormid");
    await click($('[data-drag-row="2"] [data-drag-tool="up"]'));
    expect(text($("[data-drag-list] ~ [role=status]"))).toBe("„Kujud ja vormid“ on nüüd 1. kohal.");
    await settle();
    await click($('[data-module="2"] [data-delete-module]'));
    expect(text($('[data-module="2"] [data-confirm-panel] p'))).toBe("Kas kustutan mooduli „Kujud ja vormid“?");
    // a name typed away is no name: the stored one stays
    await type(titleField(1), "  ");
    expect(handleOf(1).getAttribute("aria-label")).toBe("Lohista: Alustame");
  });
});

describe("the module's name edits in its row (README B2: autosave, no „Salvesta“; R-b2)", () => {
  it("an inline title edit autosaves on the module's own route with its t: version; nothing to press", async () => {
    await show();
    expect(buttonNamed("Salvesta")).toBeNull();
    expect(titleField(1)!.value).toBe("Alustame");
    await type(titleField(1), "Alustame uuesti");
    expect(buttonNamed("Salvesta")).toBeNull();
    await leave(titleField(1));
    await settle();
    const saves = fetched.calls.filter((c) => c.url.startsWith("/api/admin/moodul/"));
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ url: "/api/admin/moodul/1", method: "POST", body: { version: "t:m1", patch: { title: { et: "Alustame uuesti" } } } });
    expect(actions.moveModuleTo).not.toHaveBeenCalled();
  });

  it("it saves 1.5 s after the last keystroke as well, and a second edit goes on from the version the first one got", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await show();
    await type(titleField(2), "Kujud ja");
    await act(async () => void (await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)));
    await settle();
    await type(titleField(2), "Kujud ja vormid");
    await act(async () => void (await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10)));
    await settle();
    const saves = fetched.calls.filter((c) => c.url === "/api/admin/moodul/2").map((c) => c.body as { version: string; patch: unknown });
    expect(saves).toHaveLength(2);
    expect(saves[0]).toEqual({ version: "t:m2", patch: { title: { et: "Kujud ja" } } });
    expect(saves[1].version).toBe(answered[0]); // the first answer's version
    expect(saves[1].patch).toEqual({ title: { et: "Kujud ja vormid" } });
  });

  it("a name typed away is held back with „Kirjuta nimi.“ and nothing is sent", async () => {
    await show();
    await type(titleField(1), "  ");
    await leave(titleField(1));
    await settle();
    expect(fetched.calls.filter((c) => c.url.startsWith("/api/admin/moodul/"))).toEqual([]);
    expect(text($('[data-module="1"]'))).toContain("Kirjuta nimi.");
    expect(titleField(1)!.getAttribute("aria-invalid")).toBe("true");
  });

  it("the name's limit is the server's, on the trimmed text (domain/lesson-limits.ts; final review M-2): spaces round it never hold a name back", async () => {
    await show();
    // LESSON_LIMITS.title characters with a space on each side: the server takes it (it trims), so it is sent
    const padded = ` ${"a".repeat(LESSON_LIMITS.title)} `;
    await type(titleField(1), padded);
    await leave(titleField(1));
    await settle();
    expect(fetched.calls.filter((c) => c.url === "/api/admin/moodul/1").map((c) => c.body)).toEqual([{ version: "t:m1", patch: { title: { et: padded } } }]);
    expect(titleField(1)!.getAttribute("aria-invalid")).toBeNull();
    // one character more, trimmed: held back with „Liiga pikk.“, as the server would refuse it
    await type(titleField(2), "b".repeat(LESSON_LIMITS.title + 1));
    await leave(titleField(2));
    await settle();
    expect(fetched.calls.filter((c) => c.url === "/api/admin/moodul/2")).toEqual([]);
    expect(text($('[data-module="2"]'))).toContain("Liiga pikk.");
  });

  it("another tab saved the name meanwhile: „Taasta minu tekst“ saves this row's name over it", async () => {
    stored.set(1, { version: "t:other", title: { et: "Teise akna nimi" } });
    await show();
    await type(titleField(1), "Minu nimi");
    await leave(titleField(1));
    await settle();
    const restore = $<HTMLButtonElement>('[data-module="1"] [data-module-restore]');
    expect(text(restore)).toBe("Taasta minu tekst");
    await click(restore);
    await settle();
    const saves = fetched.calls.filter((c) => c.url === "/api/admin/moodul/1").map((c) => c.body);
    expect(saves).toEqual([
      { version: "t:m1", patch: { title: { et: "Minu nimi" } } },
      { version: "t:other", patch: { title: { et: "Minu nimi" } } },
    ]);
    expect($('[data-module="1"] [data-module-restore]')).toBeNull();
  });
});

describe("deleting (README B2, §1.6)", () => {
  it("a contact course's programme point: „Kustuta punkt“ (Dim 24.10 D-5) asks „Kas kustutan punkti „{title}“?“ / „Jah, kustuta“ / „Katkesta“ in place of its button", async () => {
    await show({ online: false });
    const trigger = $<HTMLButtonElement>('[data-module="1"] [data-delete-module]')!;
    expect(text(trigger)).toBe("Kustuta punkt");
    await click(trigger);
    const panel = $('[data-module="1"] [data-confirm-panel]')!;
    expect(text(panel.querySelector("p"))).toBe("Kas kustutan punkti „Alustame“?");
    expect(Array.from(panel.querySelectorAll("button")).map(text)).toEqual(["Jah, kustuta", "Katkesta"]);
    expect(document.activeElement).toBe(panel);
    expect($('[data-module="1"] [data-delete-module]')).toBeNull();
    // „Katkesta“: the button again, with the focus
    await click(buttonNamed("Katkesta", panel));
    await settle();
    expect($('[data-module="1"] [data-confirm-panel]')).toBeNull();
    expect(document.activeElement).toBe($('[data-module="1"] [data-delete-module]'));
    // „Jah, kustuta“: the module's delete
    await click($('[data-module="1"] [data-delete-module]'));
    await click(buttonNamed("Jah, kustuta", $('[data-module="1"] [data-confirm-panel]')!));
    await settle();
    expect(actions.deleteModule).toHaveBeenCalledTimes(1);
    expect((actions.deleteModule.mock.calls[0][1] as FormData).get("id")).toBe("1");
  });

  it("an e-course's module: „Kustuta moodul“ asks today's question „Kas kustutan mooduli „{title}“?“", async () => {
    await show();
    expect(text($('[data-module="2"] [data-delete-module]'))).toBe("Kustuta moodul");
    await click($('[data-module="2"] [data-delete-module]'));
    expect(text($('[data-module="2"] [data-confirm-panel] p'))).toBe("Kas kustutan mooduli „Kujud“?");
  });

  it("„Kustuta moodul“ only where the module can go (AdminModule.deletable); else, in its place, why not (Dim 24.10 D-7) — also for one the draft only looks empty in", async () => {
    await show({ modules: [moduleOf(1, "Alustame", [lesson(11, 1)]), moduleOf(2, "Tühi", [], { deletable: false }), moduleOf(3, "Kustutatav")] });
    for (const id of [1, 2]) {
      expect($(`[data-module="${id}"] [data-delete-module]`)).toBeNull();
      expect(text($(`[data-module="${id}"] [data-delete-blocked]`))).toBe("Moodulit saab kustutada, kui selles pole õppetunde.");
    }
    expect(text($('[data-module="3"] [data-delete-module]'))).toBe("Kustuta moodul");
    expect($('[data-module="3"] [data-delete-blocked]')).toBeNull();
  });
});

describe("the card's summary and the „avaldamata“ tags (P-4, P-8, P-3; README §1.8)", () => {
  it("„{n} moodulit · {m} õppetundi“, „1 moodul · 1 õppetund“, a programme's „{n} punkti“ / „1 punkt“, and none: „Mooduleid veel pole.“ in its place", async () => {
    await show({ modules: [moduleOf(1, "A", [lesson(11, 1), lesson(12, 1)]), moduleOf(2, "B", [lesson(21, 2)])] });
    expect(text($("[data-modules-summary]"))).toBe("2 moodulit · 3 õppetundi");
    await show({ modules: [moduleOf(1, "A", [lesson(11, 1)])] });
    expect(text($("[data-modules-summary]"))).toBe("1 moodul · 1 õppetund");
    await show({ modules: [moduleOf(1, "A"), moduleOf(2, "B")] });
    expect(text($("[data-modules-summary]"))).toBe("2 moodulit · 0 õppetundi");
    await show({ modules: [] });
    expect(text($("[data-modules-summary]"))).toBe("Mooduleid veel pole.");
    // a contact course's programme counts its points (Dim 24.10 D-6)
    await show({ online: false, modules: [moduleOf(1, "A")] });
    expect(text($("[data-modules-summary]"))).toBe("1 punkt");
    await show({ online: false, modules: [moduleOf(1, "A"), moduleOf(2, "B"), moduleOf(3, "C")] });
    expect(text($("[data-modules-summary]"))).toBe("3 punkti");
    await show({ online: false, modules: [] });
    expect(text($("[data-modules-summary]"))).toBe("Mooduleid veel pole.");
  });

  it("a module or lesson that waits for „Avalda muudatused“ (new, or changed in the draft) says „avaldamata“ in its row", async () => {
    await show({
      modules: [
        moduleOf(1, "Alustame", [lesson(11, 1), lesson(12, 1, { changed: true, unpublished: true })], { changed: true }),
        moduleOf(2, "Kujud", [lesson(21, 2)]),
      ],
    });
    expect(text($('[data-module="1"] [data-module-tag]'))).toBe("avaldamata");
    expect($('[data-module="2"] [data-module-tag]')).toBeNull();
    expect(text($('[data-lesson="12"] [data-lesson-tag]'))).toBe("avaldamata");
    expect($('[data-lesson="11"] [data-lesson-tag]')).toBeNull();
    // the tag describes the row's name field
    const described = titleField(1)!.getAttribute("aria-describedby") ?? "";
    expect(described.split(" ")).toContain($('[data-module="1"] [data-module-tag]')!.id);
  });
});

describe("the course's type (README B2: the card follows the drafted „Õppevorm“)", () => {
  it("an e-course: lessons and „Lisa õppetund“; a contact course's programme: names only, „Lisa punkt“", async () => {
    await show({ modules: [moduleOf(1, "Alustame", [lesson(11, 1)])] });
    expect($("[data-lessons]")).not.toBeNull();
    expect($('[data-add-lesson="1"]')).not.toBeNull();
    expect(text($("[data-add-module] button"))).toBe("+ Lisa moodul");
    await show({ online: false, modules: [moduleOf(1, "Alustame", [lesson(11, 1)])] });
    expect($("[data-lessons]")).toBeNull();
    expect($("[data-add-lesson]")).toBeNull();
    expect(text($("[data-add-module] button"))).toBe("+ Lisa punkt");
  });
});
