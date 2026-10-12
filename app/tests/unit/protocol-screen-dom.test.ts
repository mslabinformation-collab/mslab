// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { localKey } from "@/components/admin/protocol-autosave";
import { ProtocolScreen, type ScreenStudentView, type ScreenView } from "@/components/admin/ProtocolScreen";

// The course day's screen (spec §4): the students with their marks, the selected one's boxes under her headings, the autosave's status,
// switching without waiting, the too-long box, a sent protocol read-only, the conflict's notice, and a text kept in the browser coming back.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TITLES = ["Ettevalmistus", "Värvimine"];
const student = (registrationId: number, name: string, over: Partial<ScreenStudentView> = {}): ScreenStudentView => ({
  registrationId,
  name,
  awaiting: false,
  version: 0,
  titles: TITLES,
  notes: ["", ""],
  generalNote: "",
  sentVersion: null,
  sentAt: null,
  savedAt: null,
  ...over,
});
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const saved = () => json(200, { ok: true, version: 1, savedAt: "2026-10-12T08:00:00.000Z" });
let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const render = async (view: ScreenView) => act(async () => root.render(createElement(ProtocolScreen, { view })));
const type = async (selector: string, value: string) =>
  act(async () => {
    const el = $(selector) as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = async (selector: string) => act(async () => ($(selector) as HTMLElement).click());
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { registrationId: number; version: number; notes: string[] });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => saved());
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("the students with their marks; the first is open; a note saves 1.5 s after typing stops and says when", async () => {
  await render({ single: false, students: [student(1, "Anu Aas", { awaiting: true }), student(2, "Mari", { version: 2, notes: ["x", ""] })] });
  expect($$("[data-student]").map((b) => [b.getAttribute("data-student"), b.getAttribute("aria-pressed"), b.getAttribute("data-status")])).toEqual([["1", "true", "none"], ["2", "false", "draft"]]);
  expect($("[data-student='1']")!.textContent).toContain("ootab ettemaksu");
  expect($("[data-student='2'] [data-mark]")!.textContent).toBe("Mustand");
  expect($$("[data-editor='1'] label").map((l) => l.textContent)).toEqual(["Ettevalmistus", "Värvimine", "Üldised märkused"]);
  await type("[data-note='0']", "Kulmud ühtlased");
  await wait(1499);
  expect(fetchMock).not.toHaveBeenCalled();
  await wait(1);
  expect(bodies()).toEqual([{ registrationId: 1, version: 0, titles: TITLES, notes: ["Kulmud ühtlased", ""], generalNote: "" }]);
  await wait(0);
  expect($("[data-save-status]")!.textContent).toBe("Salvestatud 11:00");
});

test("switching student is one tap: the one left saves at once, the next is shown without waiting for it", async () => {
  fetchMock.mockImplementation(() => new Promise<Response>(() => {})); // a save that hangs
  await render({ single: false, students: [student(1, "Anu"), student(2, "Mari")] });
  await type("[data-note='0']", "Anu märkus");
  await click("[data-student='2']");
  expect(bodies().map((b) => b.registrationId)).toEqual([1]);
  expect($("[data-editor='2']")).not.toBeNull();
  expect($("[data-student='1'] [data-unsaved]")!.textContent).toBe("Salvestamata");
  await click("[data-student='1']");
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Anu märkus");
});

test("looking creates nothing: switching through three students and in and out of their boxes, typing nothing, sends no request", async () => {
  // a first save creates the protocol (a "Mustand"): a student whose boxes Maria never typed in must get none
  await render({ single: false, students: [student(1, "Anu"), student(2, "Mari"), student(3, "Kati"), student(4, "Tiina", { version: 2, notes: ["x", ""] })] });
  const inAndOut = (selector: string) =>
    act(async () => {
      const box = $(selector) as HTMLTextAreaElement;
      box.focus();
      box.blur();
    });
  for (const id of [2, 3, 4, 1]) {
    await click(`[data-student='${id}']`);
    await inAndOut("[data-note='0']");
    await inAndOut("[data-general]");
  }
  await wait(10_000);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
  expect($$("[data-student]").map((b) => b.getAttribute("data-status"))).toEqual(["none", "none", "none", "draft"]);
  await act(async () => root.unmount()); // leaving the screen sends nothing either
  root = createRoot(container);
  expect(fetchMock).not.toHaveBeenCalled();
  // the boxes are wired all the same: typed in, a blur saves at once
  await render({ single: false, students: [student(1, "Anu"), student(2, "Mari")] });
  await type("[data-note='0']", "Anu");
  await inAndOut("[data-note='0']");
  expect(bodies().map((b) => [b.registrationId, b.notes[0]])).toEqual([[1, "Anu"]]);
});

test("Review Focus 4: a paste over 10 000 characters is kept whole, the box says by how much, nothing is sent", async () => {
  await render({ single: true, students: [student(1, "Anu")] });
  await type("[data-note='1']", "ü".repeat(10_001));
  await wait(3000);
  expect(fetchMock).not.toHaveBeenCalled();
  expect($("[data-note-long]")!.textContent).toBe("Liiga pikk: 10001 / 10000 märki. Lühenda, siis salvestan.");
  expect($("[data-note='1']")!.getAttribute("aria-invalid")).toBe("true");
  expect($("[data-save-status]")!.textContent).toBe("Salvestamata — üks tekst on liiga pikk");
  expect(($("[data-note='1']") as HTMLTextAreaElement).value).toHaveLength(10_001);
});

test("a sent protocol is shown read-only, with when it was sent; one student has no list", async () => {
  await render({ single: true, students: [student(3, "Kati", { version: 2, sentVersion: 2, sentAt: "2026-10-12T15:00:00.000Z", notes: ["Valmis", ""] })] });
  expect($("[data-students]")).toBeNull();
  expect($$("textarea").every((t) => (t as HTMLTextAreaElement).readOnly)).toBe(true);
  expect($("[data-locked]")!.textContent).toBe("Saadetud 12.10.2026 18:00. Õpilane näeb seda versiooni.");
});

test("another device saved first: the stored text is shown and this screen's words are in the notice; 'Selge' closes it", async () => {
  fetchMock.mockImplementation(async () =>
    json(409, { ok: false, error: "conflict", protocol: { version: 3, stages: TITLES.map((title, i) => ({ title, note: i === 0 ? "teine seade" : "" })), generalNote: "", sentVersion: null, sentAt: null, updatedAt: "2026-10-12T08:01:00.000Z" } }),
  );
  await render({ single: true, students: [student(1, "Anu", { version: 2, notes: ["vana", ""] })] });
  await type("[data-note='0']", "minu tekst");
  await wait(1500);
  await wait(0);
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("teine seade");
  expect($("[data-conflict]")!.textContent).toContain("minu tekst");
  await click("[data-conflict-dismiss]");
  expect($("[data-conflict]")).toBeNull();
});

test("a browser that cannot keep the text (storage full): 'Salvestamata' and a short notice until the server has it", async () => {
  // on the instance: happy-dom binds a Storage's methods to it at their first use, so a spy on Storage.prototype misses once a test before
  // this one has used localStorage
  const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  fetchMock.mockImplementation(() => new Promise<Response>(() => {})); // the save hangs
  await render({ single: false, students: [student(1, "Anu"), student(2, "Mari")] });
  await type("[data-note='0']", "Anu märkus");
  expect($("[data-not-kept]")!.textContent).toBe("Seda teksti ei saa selles seadmes hoida (brauseri mälu on täis või suletud). Ära sulge lehte enne, kui see on salvestatud.");
  expect($("[data-student='1'] [data-unsaved]")!.textContent).toBe("Salvestamata");
  setItem.mockRestore();
});

test("a text kept in this browser comes back after a reload and is saved at once", async () => {
  localStorage.setItem(localKey(1), JSON.stringify({ version: 0, titles: TITLES, content: { notes: ["jäi alles", ""], generalNote: "" }, sent: [] }));
  await render({ single: true, students: [student(1, "Anu")] });
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("jäi alles");
  await wait(0);
  expect(bodies().map((b) => b.notes[0])).toEqual(["jäi alles"]);
});
