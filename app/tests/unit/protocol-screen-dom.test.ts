// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { localKey, type ScreenAnswer } from "@/components/admin/protocol-autosave";
import { protocolSaveStatus } from "@/components/admin/protocol-status";
import { ProtocolScreen, type ScreenStudentView, type ScreenView } from "@/components/admin/ProtocolScreen";

// The course day's screen (spec §4): the students with their marks, the selected one's boxes under her headings, the autosave's status (the
// SaveStatus chip since the admin UX pass, README A3), switching without waiting, the too-long box, a sent protocol read-only, the conflict's
// notice with „Taasta minu tekst“ (B13), and a text kept in the browser coming back.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/server/actions/admin-protocols", () => ({ sendProtocolAction: vi.fn(), sendProtocolsAction: vi.fn() })); // the screen's own tests never send

const TITLES = ["Ettevalmistus", "Värvimine"];
const student = (registrationId: number, name: string, over: Partial<ScreenStudentView> = {}): ScreenStudentView => ({
  registrationId,
  protocolId: null,
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
// The screen reads the server's text again when it is shown (GET /api/admin/protokoll: here `read`, answered by hand, each call waits for the test).
// `render` shows the screen and lets the server answer with the same text; `renderOnly` is the first half, a screen restored by the browser's Back
// before the server has answered; `answered` brings the server's answer to the newest read waiting.
type TestView = Omit<ScreenView, "source">;
const pending: ((answer: ScreenAnswer) => void)[] = [];
const read = vi.fn(() => new Promise<ScreenAnswer>((resolve) => pending.push(resolve)));
const answer = (students: ScreenStudentView[]): ScreenAnswer => ({ status: 200, body: { ok: true, students } });
const renderOnly = async (view: TestView) => act(async () => root.render(createElement(ProtocolScreen, { view: { ...view, source: { sessioon: 5 } }, read })));
const answered = async (reply: ScreenAnswer) =>
  act(async () => {
    pending.pop()!(reply);
    await Promise.resolve();
  });
const render = async (view: TestView) => {
  await renderOnly(view);
  await answered(answer(view.students));
};
const type = async (selector: string, value: string) =>
  act(async () => {
    const el = $(selector) as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = async (selector: string) => act(async () => ($(selector) as HTMLElement).click());
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { registrationId: number; version: number; notes: string[] });
/** The SaveStatus chip of the open protocol (or of `editor`'s): its state, and the words she sees (the ✓ of the saved state in front). */
const kind = (editor = "") => $(`${editor} [data-save-status]`.trim())!.getAttribute("data-save-kind");
const shownText = (editor = "") => $(`${editor} [data-save-text]`.trim())!.textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  fetchMock.mockReset();
  read.mockClear();
  pending.length = 0;
  fetchMock.mockImplementation(async () => saved());
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks(); // a storage spy of a failed test must not fill the next one's storage
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
  expect(bodies()).toEqual([{ registrationId: 1, protocolId: null, version: 0, titles: TITLES, notes: ["Kulmud ühtlased", ""], generalNote: "" }]);
  await wait(0);
  expect(shownText()).toBe("✓ Salvestatud 11:00");
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
  expect(kind()).toBe("invalid");
  expect(shownText()).toBe("Salvestamata — kontrolli märgitud välja");
  // „Näita“ takes her to the box that is too long
  await act(async () => ($("[data-save-status] button") as HTMLElement).click());
  expect(document.activeElement).toBe($("[data-note='1']"));
  expect(($("[data-note='1']") as HTMLTextAreaElement).value).toHaveLength(10_001);
});

test("a paste from Word: its line and page breaks are saved as line breaks, never words run together; other control characters go", async () => {
  await render({ single: true, students: [student(1, "Anu")] });
  await type("[data-note='0']", "Kulmud\u000bhästi\u0000\u000cJärgmine leht");
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Kulmud\nhästi\nJärgmine leht");
  await wait(1500);
  expect(bodies().map((b) => b.notes[0])).toEqual(["Kulmud\nhästi\nJärgmine leht"]);
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
  expect(kind()).toBe("conflict");
  expect(shownText()).toBe("Muudeti teises aknas — vaata üle");
  await click("[data-conflict-dismiss]");
  expect($("[data-conflict]")).toBeNull();
  expect(kind()).toBe("saved");
});

test("B13: „Taasta minu tekst“ puts this screen's words back into their box and saves them over the other device's text, at its version", async () => {
  const other = { version: 3, stages: TITLES.map((title, i) => ({ title, note: i === 0 ? "teine seade" : "" })), generalNote: "teise seadme üldine", sentVersion: null, sentAt: null, updatedAt: "2026-10-12T08:01:00.000Z" };
  fetchMock.mockImplementationOnce(async () => json(409, { ok: false, error: "conflict", protocol: other }));
  fetchMock.mockImplementationOnce(async () => json(200, { ok: true, version: 4, savedAt: "2026-10-12T08:02:00.000Z" }));
  await render({ single: true, students: [student(1, "Anu", { version: 2, notes: ["vana", ""] })] });
  await type("[data-note='0']", "minu tekst");
  await wait(1500);
  await wait(0);
  const restore = $("[data-conflict] [data-conflict-restore]") as HTMLButtonElement;
  expect(restore.textContent).toBe("Taasta minu tekst");
  expect(restore.type).toBe("button");
  await click("[data-conflict-restore]");
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("minu tekst");
  expect(($("[data-general]") as HTMLTextAreaElement).value).toBe("teise seadme üldine"); // (she wrote nothing there: it keeps what is there)
  expect($("[data-conflict]")).toBeNull();
  expect(document.activeElement).toBe($("[data-note='0']")); // the box her words went back into
  await wait(0);
  expect(bodies().map((b) => [b.version, b.notes])).toEqual([[2, ["minu tekst", ""]], [3, ["minu tekst", ""]]]);
  expect(kind()).toBe("saved");
  expect(shownText()).toBe("✓ Salvestatud 11:02");
  expect(localStorage.length).toBe(0); // the server has it: no copy, no notice left in this browser
});

test("B13: a sent protocol the notice is on is unlocked by „Taasta minu tekst“, so the words she wants back can go in (it becomes „Muudetud“)", async () => {
  // a copy kept in this browser of a text typed after „Muuda“, and the server moved on meanwhile (another device saved and sent it)
  localStorage.setItem(localKey(1), JSON.stringify({ version: 2, titles: TITLES, content: { notes: ["minu parandus", ""], generalNote: "" }, sent: [] }));
  fetchMock.mockImplementation(async () => json(200, { ok: true, version: 4, savedAt: "2026-10-12T08:02:00.000Z" }));
  await render({ single: true, students: [student(1, "Anu", { version: 3, notes: ["teise seadme", ""], sentVersion: 3, sentAt: "2026-10-12T07:00:00.000Z" })] });
  expect($("[data-locked]")).not.toBeNull();
  await click("[data-conflict-restore]");
  expect($("[data-locked]")).toBeNull();
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("minu parandus");
  await wait(0);
  expect(bodies().map((b) => [b.version, b.notes[0]])).toEqual([[3, "minu parandus"]]);
});

test("B13: words under a heading the protocol no longer has stay in the notice; „Taasta minu tekst“ is offered only while some words have a box", async () => {
  localStorage.setItem(localKey(1), JSON.stringify({ version: 1, titles: ["Vana punkt"], content: { notes: ["vana punkti tekst"], generalNote: "" }, sent: [] }));
  await render({ single: true, students: [student(1, "Anu", { version: 2, notes: ["serveri tekst", ""] })] });
  expect($("[data-conflict]")!.textContent).toContain("vana punkti tekst");
  expect($("[data-conflict-restore]")).toBeNull();
  expect($("[data-conflict-dismiss]")).not.toBeNull();
});

test("on a phone (below 900 px, the admin's phone layout) the saved chip is the short one: „✓ 11:00“; the screen reader still hears the whole sentence", async () => {
  const media = vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) => ({ matches: !query.includes("min-width: 900px"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList,
  );
  await render({ single: true, students: [student(1, "Anu", { version: 1, notes: ["Esimene.", ""], savedAt: "2026-10-12T08:00:00.000Z" })] });
  expect(shownText()).toBe("✓ 11:00");
  expect($("[data-save-status] [role='status']")!.textContent).toBe("Salvestatud 11:00");
  media.mockRestore();
});

test("protocolSaveStatus: every state of the protocol's own engine in SaveStatus' kinds; an open notice turns 'saved' into 'conflict', and only 'saved'", () => {
  const notice = { titles: TITLES, lost: { notes: ["minu", ""], generalNote: "" } };
  const at = Date.parse("2026-10-12T08:00:00.000Z");
  expect(protocolSaveStatus({ kind: "saved", at }, null)).toEqual({ kind: "saved", at: new Date(at) });
  expect(protocolSaveStatus({ kind: "saved", at: null }, null)).toEqual({ kind: "saved", at: null });
  expect(protocolSaveStatus({ kind: "pending" }, null)).toEqual({ kind: "dirty" });
  expect(protocolSaveStatus({ kind: "saving" }, null)).toEqual({ kind: "saving" });
  expect(protocolSaveStatus({ kind: "checking" }, null)).toEqual({ kind: "checking" });
  expect(protocolSaveStatus({ kind: "retrying" }, null)).toEqual({ kind: "retry" });
  expect(protocolSaveStatus({ kind: "tooLong", places: [1, "general"] }, null, TITLES)).toEqual({ kind: "invalid", fields: ["Värvimine", "Üldised märkused"] });
  expect(protocolSaveStatus({ kind: "signedOut" }, null)).toEqual({ kind: "signedOut" });
  expect(protocolSaveStatus({ kind: "gone" }, null)).toEqual({ kind: "gone" });
  // the notice is open: a settled protocol says so; a save on its way, a retry, and the states she must act on keep their own words
  expect(protocolSaveStatus({ kind: "saved", at }, notice)).toEqual({ kind: "conflict" });
  expect(protocolSaveStatus({ kind: "saved", at }, { titles: TITLES, lost: null })).toEqual({ kind: "conflict" });
  expect(protocolSaveStatus({ kind: "pending" }, notice)).toEqual({ kind: "dirty" });
  expect(protocolSaveStatus({ kind: "saving" }, notice)).toEqual({ kind: "saving" });
  expect(protocolSaveStatus({ kind: "checking" }, notice)).toEqual({ kind: "checking" });
  expect(protocolSaveStatus({ kind: "retrying" }, notice)).toEqual({ kind: "retry" });
  expect(protocolSaveStatus({ kind: "tooLong", places: [0] }, notice, TITLES)).toEqual({ kind: "invalid", fields: ["Ettevalmistus"] });
  expect(protocolSaveStatus({ kind: "signedOut" }, notice)).toEqual({ kind: "signedOut" });
  expect(protocolSaveStatus({ kind: "gone" }, notice)).toEqual({ kind: "gone" });
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

test("a full storage and a real conflict: the notice with this screen's words, and the short notice that the browser cannot keep them", async () => {
  const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  fetchMock.mockImplementation(async () =>
    json(409, { ok: false, error: "conflict", protocol: { version: 3, stages: TITLES.map((title, i) => ({ title, note: i === 0 ? "teine seade" : "" })), generalNote: "", sentVersion: null, sentAt: null, updatedAt: "2026-10-12T08:01:00.000Z" } }),
  );
  await render({ single: true, students: [student(1, "Anu", { version: 2, notes: ["vana", ""] })] });
  await type("[data-note='0']", "minu tekst");
  await wait(1500);
  await wait(0);
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("teine seade");
  expect($("[data-conflict]")!.textContent).toContain("minu tekst");
  expect($("[data-not-kept]")).not.toBeNull();
  await click("[data-conflict-dismiss]");
  expect($("[data-not-kept]")).toBeNull();
  setItem.mockRestore();
});

test("the chip says 'Salvestamata' while a save's answer is unknown, also when the text was typed back to the saved one", async () => {
  fetchMock.mockImplementation(() => new Promise<Response>(() => {})); // the save hangs
  await render({ single: false, students: [student(1, "Anu", { version: 1, notes: ["A", ""] }), student(2, "Mari")] });
  await type("[data-note='0']", "AB");
  await wait(1500);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await type("[data-note='0']", "A");
  expect($("[data-student='1'] [data-unsaved]")!.textContent).toBe("Salvestamata");
  expect(kind()).toBe("dirty");
  expect(shownText()).toBe("Salvestamata muudatused");
});

test("a text kept in this browser comes back after a reload and is saved at once", async () => {
  localStorage.setItem(localKey(1), JSON.stringify({ version: 0, titles: TITLES, content: { notes: ["jäi alles", ""], generalNote: "" }, sent: [] }));
  await render({ single: true, students: [student(1, "Anu")] });
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("jäi alles");
  await wait(0);
  expect(bodies().map((b) => b.notes[0])).toEqual(["jäi alles"]);
});

// ---------- a screen restored by the browser's Back (fix round 1 of Task 11) ----------

test("shown, the screen reads the server's text again and says so instead of 'Salvestatud'; when the server has answered it says when it saved it", async () => {
  const view: TestView = { single: true, students: [student(1, "Anu", { version: 1, notes: ["Esimene.", ""], savedAt: "2026-10-12T08:00:00.000Z" })] };
  await renderOnly(view);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith({ sessioon: 5 });
  expect(kind()).toBe("checking");
  expect(shownText()).toBe("Kontrollin salvestatud teksti…");
  await answered(answer(view.students));
  expect(kind()).toBe("saved");
  expect(shownText()).toBe("✓ Salvestatud 11:00");
});

test("the server's text newer: it is on the screen (and the student's mark), 'Salvestatud' with the server's time, nothing sent, no notice", async () => {
  await renderOnly({ single: false, students: [student(1, "Anu", { version: 1, notes: ["Esimene.", ""], savedAt: "2026-10-12T08:00:00.000Z" }), student(2, "Mari")] });
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Esimene.");
  await answered(
    answer([
      student(1, "Anu", { version: 3, notes: ["Kolmas versioon.", ""], generalNote: "Üldiselt hästi.", sentVersion: 2, sentAt: "2026-10-12T09:00:00.000Z", savedAt: "2026-10-12T08:05:00.000Z" }),
      student(2, "Mari"),
    ]),
  );
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Kolmas versioon.");
  expect(($("[data-general]") as HTMLTextAreaElement).value).toBe("Üldiselt hästi.");
  expect(shownText()).toBe("✓ Salvestatud 11:05");
  expect($("[data-student='1']")!.getAttribute("data-status")).toBe("changed"); // sent version 2 of 3
  expect($("[data-conflict]")).toBeNull();
  await wait(10_000);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("words typed on the restored screen before the server's text came: it is shown with a notice that keeps her words; nothing is saved over it", async () => {
  await renderOnly({ single: true, students: [student(1, "Anu", { version: 1, notes: ["Esimene.", ""], savedAt: "2026-10-12T08:00:00.000Z" })] });
  await type("[data-note='0']", "Esimene. Minu lisa.");
  await answered(answer([student(1, "Anu", { version: 2, notes: ["Teine.", ""], savedAt: "2026-10-12T08:05:00.000Z" })]));
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Teine.");
  expect($("[data-conflict]")).not.toBeNull();
  expect($("[data-conflict]")!.textContent).toContain("Esimene. Minu lisa.");
  await wait(10_000);
  expect(fetchMock).not.toHaveBeenCalled(); // the stale version was never sent
});

test("a student the server's answer adds appears, and the open student stays open; one it drops stays, saying she is gone, with her text", async () => {
  await renderOnly({ single: false, students: [student(1, "Anu"), student(2, "Mari")] });
  await click("[data-student='2']");
  await answered(answer([student(1, "Anu"), student(2, "Mari"), student(3, "Kati")]));
  expect($$("[data-student]").map((b) => b.getAttribute("data-student"))).toEqual(["1", "2", "3"]);
  expect($("[data-student='2']")!.getAttribute("aria-pressed")).toBe("true");
  // the screen reads again when the page comes back from the browser's cache; this time Mari is gone (cancelled meanwhile)
  await act(async () => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })));
  await answered(answer([student(1, "Anu"), student(3, "Kati")]));
  expect($$("[data-student]").map((b) => b.getAttribute("data-student"))).toEqual(["1", "3", "2"]); // (hers last: the answer's students first)
  expect($("[data-student='2']")!.getAttribute("aria-pressed")).toBe("true"); // and she is still the open one, not gone from under Maria's hands
  expect(kind("[data-editor='2']")).toBe("gone");
  expect(shownText("[data-editor='2']")).toBe("Seda registreeringut enam ei ole. Tekst on selles seadmes alles."); // (P-10: „registreeringut“)
  expect($("[data-editor='2'] [data-note='0']")).not.toBeNull(); // her editor is still there
  expect($("[data-student='1'] [data-unsaved]")).toBeNull();
});

test("the read answers 404 (no such session now): every student says she is gone, none is 'checking' for good", async () => {
  await renderOnly({ single: false, students: [student(1, "Anu"), student(2, "Mari")] });
  await answered({ status: 404, body: { ok: false, error: "notFound" } });
  expect($$("[data-student]")).toHaveLength(2);
  expect(kind("[data-editor='1']")).toBe("gone");
  await click("[data-student='2']");
  expect(kind("[data-editor='2']")).toBe("gone");
  await wait(120_000);
  expect(read).toHaveBeenCalledTimes(1);
});

test("the read is refused (401): the screen says she is signed out instead of 'checking', with her text; the read is not repeated", async () => {
  await renderOnly({ single: true, students: [student(1, "Anu", { version: 1, notes: ["Esimene.", ""] })] });
  await answered({ status: 401, body: { ok: false, error: "unauthorized" } });
  expect(kind()).toBe("signedOut");
  expect(shownText()).toBe("Salvestamata — logi uuesti sisse"); // (SaveStatus' words; the send's line keeps "Tekst on selles seadmes alles.")
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Esimene.");
  await wait(120_000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a read that fails is tried again after 2, 5 and 10 s, and at once when the network is back or the tab is shown; the page back from the browser's cache reads again; a read that cannot change is not repeated", async () => {
  const view: TestView = { single: true, students: [student(1, "Anu")] };
  await renderOnly(view);
  expect(read).toHaveBeenCalledTimes(1);
  await answered(null); // no connection
  expect(kind()).toBe("checking");
  await wait(1_999);
  expect(read).toHaveBeenCalledTimes(1);
  await wait(1);
  expect(read).toHaveBeenCalledTimes(2);
  await answered({ status: 500, body: { ok: false, error: "server" } });
  await wait(4_999);
  expect(read).toHaveBeenCalledTimes(2);
  await wait(1);
  expect(read).toHaveBeenCalledTimes(3);
  await answered(null);
  await act(async () => void window.dispatchEvent(new Event("online"))); // the network is back: at once, without the 10 s
  expect(read).toHaveBeenCalledTimes(4);
  await answered(answer(view.students));
  expect(kind()).toBe("saved");
  await act(async () => void window.dispatchEvent(new Event("online"))); // read: nothing to ask
  await wait(60_000);
  expect(read).toHaveBeenCalledTimes(4);
  await act(async () => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false })));
  expect(read).toHaveBeenCalledTimes(4);
  await act(async () => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }))); // from the browser's cache: unread again
  expect(kind()).toBe("checking");
  expect(read).toHaveBeenCalledTimes(5);
  await answered({ status: 401, body: { ok: false, error: "unauthorized" } }); // signed out: trying again changes nothing
  await wait(120_000);
  expect(read).toHaveBeenCalledTimes(5);
  expect(kind()).toBe("signedOut");
});

test("the screen being left: an answer that comes after is not applied, and nothing is asked again", async () => {
  await renderOnly({ single: true, students: [student(1, "Anu")] });
  await act(async () => root.unmount());
  root = createRoot(container);
  await answered(answer([student(1, "Anu", { version: 5, notes: ["Hilja.", ""] })]));
  await wait(120_000);
  expect(read).toHaveBeenCalledTimes(1);
  expect($("[data-protocol-screen]")).toBeNull();
});
