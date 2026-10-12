// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { localKey } from "@/components/admin/protocol-autosave";
import { ProtocolScreen, type ScreenStudentView, type ScreenView } from "@/components/admin/ProtocolScreen";
import type { SendOutcome } from "@/server/protocols";

// The sends on the course day's screen (spec §4, §8, D4): "Saada" saves first and sends the version the server confirmed, the boxes read-only
// meanwhile; a sent protocol is read-only with "Muuda"; the first edit after it makes it "Muudetud" with "Saada uuesti"; "Lukusta ja saada
// kõik" asks once, naming who gets one and who is skipped, then sends; one student's failure never stops the others; every refusal says why.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ sendProtocolAction: vi.fn(), sendProtocolsAction: vi.fn() }));
vi.mock("@/server/actions/admin-protocols", () => actions);

const TITLES = ["Ettevalmistus", "Värvimine"];
const SENT_AT = "2026-10-12T15:00:00.000Z";
const student = (registrationId: number, name: string, over: Partial<ScreenStudentView> = {}): ScreenStudentView => ({
  registrationId,
  name,
  awaiting: false,
  version: 1,
  titles: TITLES,
  notes: ["Valmis", ""],
  generalNote: "",
  sentVersion: null,
  sentAt: null,
  savedAt: "2026-10-12T08:00:00.000Z",
  ...over,
});
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
// a new key for each list of students: a new screen (and engine), as a new page load gives one
const render = async (view: ScreenView) =>
  act(async () => root.render(createElement(ProtocolScreen, { view, key: view.students.map((s) => s.registrationId).join("-") })));
const click = async (selector: string) => act(async () => ($(selector) as HTMLElement).click());
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const type = async (selector: string, value: string) =>
  act(async () => {
    const el = $(selector) as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  actions.sendProtocolAction.mockReset();
  actions.sendProtocolsAction.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => json(200, { ok: true, version: 2, savedAt: "2026-10-12T15:05:00.000Z" }));
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

test("'Saada' sends the confirmed version; sent, it is read-only with 'Muuda'; an edit after it makes it 'Muudetud' and 'Saada uuesti' sends again", async () => {
  actions.sendProtocolAction.mockResolvedValue({ kind: "sent", again: false, version: 1, sentAt: SENT_AT });
  await render({ single: true, students: [student(1, "Kati")] });
  expect($("[data-send='first']")!.textContent).toBe("Saada");
  expect($("[data-send='first']")!.className).not.toContain("smallBtn"); // one student's screen: its primary button
  await click("[data-send='first']");
  expect(actions.sendProtocolAction).toHaveBeenCalledWith({ registrationId: 1, version: 1 });
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true);
  expect($("[data-locked]")!.textContent).toBe("Saadetud 12.10.2026 18:00. Õpilane näeb seda versiooni.");
  await click("[data-edit]");
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
  expect($("[data-editing]")).not.toBeNull();
  await type("[data-note='0']", "Valmis. Lisaks värv.");
  await wait(1500);
  await wait(0);
  expect($("[data-send='again']")!.textContent).toBe("Saada uuesti");
  actions.sendProtocolAction.mockResolvedValue({ kind: "sent", again: true, version: 2, sentAt: "2026-10-12T15:06:00.000Z" });
  await click("[data-send='again']");
  expect(actions.sendProtocolAction).toHaveBeenLastCalledWith({ registrationId: 1, version: 2 });
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true);
});

test("an empty protocol is refused at once, nothing sent; Review Focus 3: each refusal says why", async () => {
  await render({ single: true, students: [student(1, "Kati", { version: 0, notes: ["", ""], savedAt: null })] });
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe("Protokoll on tühi. Kirjuta midagi enne saatmist.");
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
  await render({ single: true, students: [student(2, "Mari")] });
  for (const [answer, line] of [
    [{ kind: "cancelled" }, "Registreering on tühistatud: protokolli ei saadeta."],
    [{ kind: "stale", version: 4 }, "Protokolli muudeti vahepeal mujal. Laadi leht uuesti ja vaata see üle."],
    [{ kind: "failed" }, "Saatmine ei õnnestunud. Proovi uuesti."],
  ] as const) {
    actions.sendProtocolAction.mockResolvedValueOnce(answer);
    await click("[data-send='first']");
    expect($("[data-send-error]")!.textContent).toBe(line);
  }
  actions.sendProtocolAction.mockRejectedValueOnce(new Error("offline"));
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe("Saatmine ei õnnestunud. Proovi uuesti.");
});

test("while 'Saada' is on its way the boxes are read-only: Maria's typing cannot make the send stale", async () => {
  let answer!: (r: SendOutcome) => void;
  actions.sendProtocolAction.mockImplementation(() => new Promise<SendOutcome>((resolve) => (answer = resolve)));
  await render({ single: true, students: [student(1, "Kati")] });
  await click("[data-send='first']");
  expect(actions.sendProtocolAction).toHaveBeenCalledWith({ registrationId: 1, version: 1 });
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true);
  await type("[data-note='0']", "Valmis, ja veel üks lause."); // (a box that is read-only takes nothing)
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Valmis");
  await act(async () => answer({ kind: "failed" }));
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
  expect($("[data-send-error]")!.textContent).toBe("Saatmine ei õnnestunud. Proovi uuesti.");
});

test("a text that cannot be saved is not sent: the screen says so", async () => {
  fetchMock.mockImplementation(async () => {
    throw new TypeError("Failed to fetch");
  });
  await render({ single: true, students: [student(1, "Kati")] });
  await type("[data-note='0']", "Valmis!");
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe("Kõik pole veel salvestatud. Saada uuesti, kui ühendus on tagasi.");
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
});

test("'Lukusta ja saada kõik': one confirmation names who gets one, who is skipped as empty and who has it already; one more tap sends; a failure is named", async () => {
  const view: ScreenView = {
    single: false,
    students: [student(1, "Anu"), student(2, "Berit", { version: 0, notes: ["", ""], savedAt: null }), student(3, "Carmen", { sentVersion: 1, sentAt: SENT_AT })],
  };
  await render(view);
  expect($("[data-send-all-open]")!.textContent).toBe("Lukusta ja saada kõik");
  expect($("[data-send='first']")!.className).toContain("smallBtn"); // a student's own "Saada" is secondary here
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Anu");
  expect($("[data-confirm-skipped]")!.textContent).toBe("Jäävad vahele, sest protokoll on tühi: Berit");
  expect($("[data-confirm-already]")!.textContent).toBe("Juba saadetud, uut pole: Carmen");
  expect(actions.sendProtocolsAction).not.toHaveBeenCalled();
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 1, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-confirm-send]");
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([{ registrationId: 1, version: 1 }]);
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Anu.");
  expect($("[data-student='1']")!.getAttribute("data-status")).toBe("sent");
  expect($("[data-send-confirm]")).toBeNull();

  await render({ single: false, students: [student(4, "Dora"), student(5, "Eve")] });
  actions.sendProtocolsAction.mockResolvedValue([
    { registrationId: 4, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } },
    { registrationId: 5, result: { kind: "failed" } },
  ]);
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Dora.");
  expect($("[data-summary-failed]")!.textContent).toBe("Ei saadetud: Eve. Saatmine ei õnnestunud. Proovi uuesti.");
});

test("'Lukusta ja saada kõik' when one student's text cannot be saved: the others are sent, she is named with why; one line per reason", async () => {
  // Eve's newer text waits in this browser (typed offline before a reload), and her save does not get through
  localStorage.setItem(localKey(5), JSON.stringify({ version: 1, titles: TITLES, content: { notes: ["Valmis", "lisa"], generalNote: "" }, sent: [] }));
  fetchMock.mockImplementation(async (_url, init) => {
    if ((JSON.parse(String(init?.body)) as { registrationId: number }).registrationId === 5) throw new TypeError("Failed to fetch");
    return json(200, { ok: true, version: 2, savedAt: "2026-10-12T15:05:00.000Z" });
  });
  await render({ single: false, students: [student(4, "Dora"), student(5, "Eve"), student(6, "Fia")] });
  actions.sendProtocolsAction.mockResolvedValue([
    { registrationId: 4, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } },
    { registrationId: 6, result: { kind: "cancelled" } },
  ]);
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Dora, Eve, Fia");
  await click("[data-confirm-send]");
  await wait(0);
  await wait(0);
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([
    { registrationId: 4, version: 1 },
    { registrationId: 6, version: 1 },
  ]);
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Dora.");
  expect($$("[data-summary-failed]").map((p) => p.textContent)).toEqual([
    "Ei saadetud: Eve. Kõik pole veel salvestatud. Saada uuesti, kui ühendus on tagasi.",
    "Ei saadetud: Fia. Registreering on tühistatud: protokolli ei saadeta.",
  ]);
  expect($("[data-student='4']")!.getAttribute("data-status")).toBe("sent");
  expect($("[data-student='5']")!.getAttribute("data-status")).toBe("draft");
});

test("with nothing new to send the confirmation says so and offers no 'Saada'", async () => {
  await render({ single: false, students: [student(1, "Anu", { sentVersion: 1, sentAt: SENT_AT }), student(2, "Berit", { version: 0, notes: ["", ""], savedAt: null })] });
  await click("[data-send-all-open]");
  expect($("[data-send-confirm]")!.textContent).toContain("Pole midagi uut saata.");
  expect($("[data-confirm-send]")).toBeNull();
});

// ---------- beyond the plan's tests: the cases its buttons must also hold ----------

test("a send that is on its way stays on its way when Maria goes to another student and back: no second send, the boxes stay read-only", async () => {
  let answer!: (r: SendOutcome) => void;
  actions.sendProtocolAction.mockImplementation(() => new Promise<SendOutcome>((resolve) => (answer = resolve)));
  await render({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await click("[data-send='first']");
  expect(actions.sendProtocolAction).toHaveBeenCalledTimes(1);
  await click("[data-student='2']");
  await click("[data-student='1']");
  expect($("[data-send='first']")!.textContent).toBe("Saadan…");
  expect($("[data-send='first']")!.getAttribute("aria-disabled")).toBe("true");
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true);
  await click("[data-send='first']"); // (a second tap while the first is on its way)
  expect(actions.sendProtocolAction).toHaveBeenCalledTimes(1);
  await act(async () => answer({ kind: "sent", again: false, version: 1, sentAt: SENT_AT }));
  expect($("[data-edit]")).not.toBeNull();
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true);
});

test("'Lukusta ja saada kõik': the boxes are read-only while it is on its way, and a student it did not send is writable again", async () => {
  let answer!: (r: { registrationId: number; result: SendOutcome }[]) => void;
  actions.sendProtocolsAction.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
  await render({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true);
  await type("[data-note='0']", "Valmis, ja veel üks lause.");
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Valmis");
  expect($("[data-send='first']")!.getAttribute("aria-disabled")).toBe("true"); // her own "Saada" waits for it
  await click("[data-confirm-cancel]"); // "Tagasi" does not close it meanwhile
  expect($("[data-send-confirm]")).not.toBeNull();
  await click("[data-send-all-open]"); // nor does it start a second one
  expect($("[data-send-confirm]")).not.toBeNull();
  await act(async () =>
    answer([
      { registrationId: 1, result: { kind: "failed" } },
      { registrationId: 2, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } },
    ]),
  );
  expect(actions.sendProtocolsAction).toHaveBeenCalledTimes(1);
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
  expect($("[data-student='2']")!.getAttribute("data-status")).toBe("sent");
});

test("'Lukusta ja saada kõik' leaves no student unexplained: one the answer does not list, and an answer that never came, are 'Saatmine ei õnnestunud'", async () => {
  const students = [student(1, "Anu"), student(2, "Berit")];
  await render({ single: false, students });
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 1, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Anu.");
  expect($$("[data-summary-failed]").map((p) => p.textContent)).toEqual(["Ei saadetud: Berit. Saatmine ei õnnestunud. Proovi uuesti."]);

  await render({ single: false, students: [student(3, "Carmen"), student(4, "Dora")] });
  actions.sendProtocolsAction.mockRejectedValue(new Error("offline"));
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect($("[data-summary-sent]")).toBeNull();
  expect($$("[data-summary-failed]").map((p) => p.textContent)).toEqual(["Ei saadetud: Carmen, Dora. Saatmine ei õnnestunud. Proovi uuesti."]);
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
});

test("'Lukusta ja saada kõik': a sent protocol edited with 'Muuda' is sent again, at the version its save made; 'Tagasi' sends nothing", async () => {
  await render({ single: false, students: [student(1, "Anu", { sentVersion: 1, sentAt: SENT_AT }), student(2, "Berit", { sentVersion: 1, sentAt: SENT_AT })] });
  await click("[data-send-all-open]");
  expect($("[data-confirm-already]")!.textContent).toBe("Juba saadetud, uut pole: Anu, Berit");
  expect($("[data-confirm-will]")).toBeNull();
  await click("[data-confirm-cancel]");
  expect($("[data-send-confirm]")).toBeNull();
  await click("[data-edit]");
  await type("[data-note='0']", "Valmis. Lisaks värv."); // (typed, and the autosave has not run yet)
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Anu");
  expect($("[data-confirm-already]")!.textContent).toBe("Juba saadetud, uut pole: Berit");
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 1, result: { kind: "sent", again: true, version: 2, sentAt: "2026-10-12T15:06:00.000Z" } }]);
  await click("[data-confirm-send]");
  expect(fetchMock).toHaveBeenCalledTimes(1); // its save came first
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([{ registrationId: 1, version: 2 }]);
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Anu.");
  expect($("[data-student='1']")!.getAttribute("data-status")).toBe("sent");
  expect($("[data-edit]")).not.toBeNull(); // locked again: "Muuda" is back
});

test("'Lukusta ja saada kõik' with two students refused for one reason says it once; 'already' counts as sent", async () => {
  await render({ single: false, students: [student(1, "Anu"), student(2, "Berit"), student(3, "Carmen"), student(4, "Dora")] });
  actions.sendProtocolsAction.mockResolvedValue([
    { registrationId: 1, result: { kind: "already", version: 1, sentAt: SENT_AT } },
    { registrationId: 2, result: { kind: "cancelled" } },
    { registrationId: 3, result: { kind: "stale", version: 3 } },
    { registrationId: 4, result: { kind: "cancelled" } },
  ]);
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Anu.");
  expect($$("[data-summary-failed]").map((p) => p.textContent)).toEqual([
    "Ei saadetud: Berit, Dora. Registreering on tühistatud: protokolli ei saadeta.",
    "Ei saadetud: Carmen. Protokolli muudeti vahepeal mujal. Laadi leht uuesti ja vaata see üle.",
  ]);
});
