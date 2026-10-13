// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { localKey, type ScreenAnswer } from "@/components/admin/protocol-autosave";
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
  protocolId: null,
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
// The screen reads the server's text again when it is shown (GET /api/admin/protokoll: here `read`, answered by hand, each call waits for the test).
// `render` shows the screen and lets the server answer with the same text; `renderOnly` is the first half, a screen restored by the browser's Back
// before the server has answered; `answered` brings the server's answer to the newest read waiting.
type TestView = Omit<ScreenView, "source">;
const pending: ((answer: ScreenAnswer) => void)[] = [];
const read = vi.fn(() => new Promise<ScreenAnswer>((resolve) => pending.push(resolve)));
const answer = (students: ScreenStudentView[]): ScreenAnswer => ({ status: 200, body: { ok: true, students } });
// a new key for each list of students: a new screen (and engine), as a new page load gives one
const keyOf = (view: TestView) => view.students.map((s) => s.registrationId).join("-");
const renderOnly = async (view: TestView) => act(async () => root.render(createElement(ProtocolScreen, { view: { ...view, source: { sessioon: 5 } }, read, key: keyOf(view) })));
const answered = async (reply: ScreenAnswer) =>
  act(async () => {
    pending.pop()!(reply);
    await Promise.resolve();
  });
const render = async (view: TestView) => {
  await renderOnly(view);
  await answered(answer(view.students));
};
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
  read.mockClear();
  pending.length = 0;
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

test("an empty protocol is refused at once, nothing sent; each refusal says why", async () => {
  await render({ single: true, students: [student(1, "Kati", { version: 0, notes: ["", ""], savedAt: null })] });
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe("Protokoll on tühi. Kirjuta midagi enne saatmist.");
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
  await render({ single: true, students: [student(2, "Mari")] });
  for (const [answer, line] of [
    [{ kind: "cancelled" }, "Registreering on tühistatud: protokolli ei saadeta."],
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
  const view: TestView = {
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

// ---------- more cases the buttons must hold ----------

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
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Anu, Berit"); // (the confirmation still shows who it is sending to)
  expect($("[data-confirm-send]")!.textContent).toBe("Saadan…");
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

// ---------- why a save did not go through: the line says what the engine knows ----------

const conflictBody = (note: string) => ({
  ok: false,
  error: "conflict",
  protocol: { version: 3, stages: [{ title: TITLES[0], note }, { title: TITLES[1], note: "" }], generalNote: "", sentVersion: null, sentAt: null, updatedAt: "2026-10-12T15:00:00.000Z" },
});
const UNSAVED = "Kõik pole veel salvestatud. Saada uuesti, kui ühendus on tagasi.";
const REVIEW = "Vaata enne saatmist üle teises seadmes tehtud muudatus ja vajuta „Selge“.";
const reviewAll = (names: string) => `Vaata enne üle ja vajuta „Selge“: ${names}`;

test("a save that another device's text refused is not sent, and the line says to look at that text and press 'Selge', not that it is unsaved", async () => {
  fetchMock.mockImplementation(async () => json(409, conflictBody("Teisest seadmest")));
  await render({ single: true, students: [student(1, "Kati")] });
  await type("[data-note='0']", "Valmis!");
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe(REVIEW);
  expect($("[data-conflict]")).not.toBeNull(); // (the notice with her words is on the screen too)
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Teisest seadmest");
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
});

test("a save that is gone, signed out or too long says so in the words the status already has; offline stays 'not saved yet'", async () => {
  const cases: [() => Promise<Response>, string, string][] = [
    [async () => json(404, { ok: false, error: "notFound" }), "Seda registreeringut ei leitud.", "gone"],
    [async () => json(401, { ok: false, error: "auth" }), "Salvestamata — logi uuesti sisse. Tekst on selles seadmes alles.", "signed out"],
    [async () => json(200, { ok: true, version: 2, savedAt: "2026-10-12T15:05:00.000Z" }), "Salvestamata — üks tekst on liiga pikk", "too long"],
    [async () => json(500, { ok: false, error: "server" }), UNSAVED, "a server error"],
  ];
  let id = 10;
  for (const [answer, line, label] of cases) {
    fetchMock.mockReset();
    fetchMock.mockImplementation(answer);
    await render({ single: true, students: [student(++id, "Kati")] });
    await type("[data-note='0']", label === "too long" ? "x".repeat(10_001) : "Valmis!");
    await click("[data-send='first']");
    expect($("[data-send-error]")!.textContent, label).toBe(line);
  }
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
});

test("'Lukusta ja saada kõik': the students whose save did not go through are named under the reason of each; the others are sent", async () => {
  const copy = (note: string) => JSON.stringify({ version: 1, titles: TITLES, content: { notes: ["Valmis", note], generalNote: "" }, sent: [] });
  for (const id of [5, 6, 7, 8]) localStorage.setItem(localKey(id), copy("lisa"));
  fetchMock.mockImplementation(async (_url, init) => {
    const id = (JSON.parse(String(init?.body)) as { registrationId: number }).registrationId;
    if (id === 5 || id === 8) throw new TypeError("Failed to fetch");
    if (id === 6) return json(409, conflictBody("Teisest seadmest"));
    if (id === 7) return json(404, { ok: false, error: "notFound" });
    return json(200, { ok: true, version: 2, savedAt: "2026-10-12T15:05:00.000Z" });
  });
  await render({ single: false, students: [student(4, "Dora"), student(5, "Eve"), student(6, "Fia"), student(7, "Gert"), student(8, "Hugo")] });
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 4, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  await wait(0);
  await wait(0);
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([{ registrationId: 4, version: 1 }]);
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Dora.");
  expect($$("[data-summary-failed]").map((p) => p.textContent)).toEqual([
    `Ei saadetud: Eve, Hugo. ${UNSAVED}`,
    reviewAll("Fia"),
    "Ei saadetud: Gert. Seda registreeringut ei leitud.",
  ]);
});

// ---------- the note under a send's button belongs to the student ----------

test("a failed send's line stays with the student when Maria goes to another one and back, and goes with her next edit", async () => {
  actions.sendProtocolAction.mockResolvedValue({ kind: "failed" });
  await render({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe("Saatmine ei õnnestunud. Proovi uuesti.");
  await click("[data-student='2']");
  expect($("[data-send-error]")).toBeNull(); // (Berit's own screen)
  await click("[data-student='1']");
  expect($("[data-send-error]")!.textContent).toBe("Saatmine ei õnnestunud. Proovi uuesti.");
  await type("[data-note='0']", "Valmis, uus lause.");
  expect($("[data-send-error]")).toBeNull();
  actions.sendProtocolAction.mockResolvedValue({ kind: "cancelled" });
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe("Registreering on tühistatud: protokolli ei saadeta.");
  actions.sendProtocolAction.mockResolvedValue({ kind: "sent", again: false, version: 2, sentAt: SENT_AT });
  await click("[data-send='first']"); // the next send clears it
  expect($("[data-send-error]")).toBeNull();
});

// ---------- one send at a time for one protocol ----------

test("a single 'Saada' on its way keeps its protocol out of 'Lukusta ja saada kõik', which names it; her boxes stay read-only until her own answer", async () => {
  let answer!: (r: SendOutcome) => void;
  actions.sendProtocolAction.mockImplementation(() => new Promise<SendOutcome>((resolve) => (answer = resolve)));
  await render({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await click("[data-send='first']"); // Anu's, on its way
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Berit");
  expect($("[data-confirm-sending]")!.textContent).toBe("Saatmine juba käib: Anu");
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 2, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-confirm-send]");
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([{ registrationId: 2, version: 1 }]);
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Berit.");
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true); // (the bulk's end does not open what Anu's own send still needs shut)
  await act(async () => answer({ kind: "sent", again: false, version: 1, sentAt: SENT_AT }));
  expect($("[data-student='1']")!.getAttribute("data-status")).toBe("sent");
});

test("a confirmation with only a send on its way says there is nothing new, and names that one", async () => {
  actions.sendProtocolAction.mockImplementation(() => new Promise<SendOutcome>(() => {}));
  await render({ single: false, students: [student(1, "Anu")] });
  await click("[data-send='first']");
  await click("[data-send-all-open]");
  expect($("[data-send-confirm]")!.textContent).toContain("Pole midagi uut saata.");
  expect($("[data-confirm-sending]")!.textContent).toBe("Saatmine juba käib: Anu");
  expect($("[data-confirm-send]")).toBeNull();
});

// ---------- focus ----------

const focused = () => document.activeElement;

test("closing the confirmation, by 'Tagasi' or by the send, gives the focus back to 'Lukusta ja saada kõik'", async () => {
  await render({ single: false, students: [student(1, "Anu")] });
  await click("[data-send-all-open]");
  await act(async () => ($("[data-confirm-cancel]") as HTMLElement).focus());
  await click("[data-confirm-cancel]");
  expect($("[data-send-confirm]")).toBeNull();
  expect(focused()).toBe($("[data-send-all-open]"));

  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 1, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-send-all-open]");
  await act(async () => ($("[data-confirm-send]") as HTMLElement).focus());
  await click("[data-confirm-send]");
  expect($("[data-send-confirm]")).toBeNull();
  expect(focused()).toBe($("[data-send-all-open]"));
});

test("a send that ends while Maria has gone elsewhere does not take the focus from her", async () => {
  let answer!: (r: { registrationId: number; result: SendOutcome }[]) => void;
  actions.sendProtocolsAction.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
  await render({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  await act(async () => ($("[data-student='2']") as HTMLElement).focus());
  await act(async () =>
    answer([
      { registrationId: 1, result: { kind: "failed" } },
      { registrationId: 2, result: { kind: "failed" } },
    ]),
  );
  expect($("[data-send-confirm]")).toBeNull();
  expect(focused()).toBe($("[data-student='2']"));
});

test("'Muuda' moves the focus to the first box, or to the general notes when the course has no headings; going back to an open one takes none", async () => {
  await render({ single: false, students: [student(1, "Anu", { sentVersion: 1, sentAt: SENT_AT }), student(2, "Berit", { sentVersion: 1, sentAt: SENT_AT })] });
  await act(async () => ($("[data-edit]") as HTMLElement).focus());
  await click("[data-edit]");
  expect(focused()).toBe($("[data-note='0']"));
  await act(async () => (focused() as HTMLElement).blur());
  await click("[data-student='2']");
  await click("[data-student='1']"); // (Anu is still open: nothing takes the focus from where it is)
  expect(focused()).not.toBe($("[data-note='0']"));

  await render({ single: true, students: [student(3, "Carmen", { titles: [], notes: [], generalNote: "Üldine", sentVersion: 1, sentAt: SENT_AT })] });
  await act(async () => ($("[data-edit]") as HTMLElement).focus());
  await click("[data-edit]");
  expect(focused()).toBe($("[data-general]"));
});

// ---------- the live region and the one primary button ----------

test("the summary's place is there from the start, as a status for screen readers, and holds nothing until a send is summed up", async () => {
  await render({ single: false, students: [student(1, "Anu")] });
  const place = $("[data-send-summary]")!;
  expect(place.getAttribute("role")).toBe("status");
  expect(place.children.length).toBe(0);
  await click("[data-send-all-open]");
  await click("[data-confirm-cancel]");
  expect($("[data-send-summary]")).toBe(place); // (the same element: a live region that is replaced is not announced)
  expect(place.children.length).toBe(0);
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 1, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect($("[data-send-summary]")).toBe(place);
  expect([...place.children].map((p) => p.textContent)).toEqual(["Saadetud: Anu."]);
  await click("[data-send-all-open]"); // asking again clears the old summary
  expect(place.children.length).toBe(0);
});

test("while the confirmation is open its 'Saada' is the one primary button: 'Lukusta ja saada kõik' is secondary", async () => {
  await render({ single: false, students: [student(1, "Anu")] });
  expect($("[data-send-all-open]")!.className).not.toContain("secondary");
  await click("[data-send-all-open]");
  expect($("[data-send-all-open]")!.className).toContain("secondary");
  expect($("[data-confirm-send]")!.className).not.toContain("secondary");
  await click("[data-confirm-cancel]");
  expect($("[data-send-all-open]")!.className).not.toContain("secondary");
});

// ---------- another device's text is never sent unseen ----------
// (Maria's tap on "Saada" first takes the focus from the box she typed in, and that saves: a refusal answered to THAT save leaves the screen
// with the other device's text and the notice, and the send's own save then finds nothing left to save.)

test("a refusal that a save already on its way takes — Maria's tap blurs the box, which saves — still stops the send", async () => {
  fetchMock.mockImplementation(async () => json(409, conflictBody("Teisest seadmest")));
  await render({ single: true, students: [student(1, "Kati")] });
  const note = $("[data-note='0']") as HTMLTextAreaElement;
  await act(async () => note.focus());
  await type("[data-note='0']", "Valmis!");
  await act(async () => {
    note.blur();
    ($("[data-send='first']") as HTMLElement).click();
  });
  expect(fetchMock).toHaveBeenCalled(); // (the blur's save)
  expect($("[data-send-error]")!.textContent).toBe(REVIEW);
  expect($("[data-conflict]")).not.toBeNull();
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
});

test("while the notice of a refusal is open the protocol is not sent: 'Selge' first, then 'Saada' sends the text that is shown", async () => {
  fetchMock.mockImplementation(async () => json(409, conflictBody("Teisest seadmest")));
  await render({ single: true, students: [student(1, "Kati")] });
  await type("[data-note='0']", "Valmis!");
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe(REVIEW);
  fetchMock.mockClear();
  await click("[data-send='first']"); // (the notice is still open: she has not looked at it)
  expect($("[data-send-error]")!.textContent).toBe(REVIEW);
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  actions.sendProtocolAction.mockResolvedValue({ kind: "sent", again: false, version: 3, sentAt: SENT_AT });
  await click("[data-conflict-dismiss]");
  expect($("[data-send-error]")).toBeNull(); // ("Selge" takes the line with it)
  await click("[data-send='first']");
  expect(actions.sendProtocolAction).toHaveBeenCalledWith({ registrationId: 1, version: 3 });
  expect($("[data-send-error]")).toBeNull();
});

test("'Lukusta ja saada kõik' leaves a protocol with an open notice alone and names it with the reason, in the words that exist; the others are sent", async () => {
  fetchMock.mockImplementation(async () => json(409, conflictBody("Teisest seadmest")));
  await render({ single: false, students: [student(4, "Dora"), student(5, "Eve")] });
  await click("[data-student='5']");
  await type("[data-note='0']", "Valmis, Evel.");
  await click("[data-student='4']"); // (the one left saves in the background: refused, her notice opens)
  await wait(0);
  await wait(0);
  expect($("[data-student='5']")!.getAttribute("data-status")).toBe("draft");
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Dora");
  expect($("[data-confirm-review]")!.textContent).toBe(reviewAll("Eve"));
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 4, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-confirm-send]");
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([{ registrationId: 4, version: 1 }]);
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Dora.");
});

test("'Lukusta ja saada kõik': a refusal that a save already on its way takes is found before the send, and that protocol is named, not sent", async () => {
  const gate = { release: (): void => {} };
  const first = new Promise<void>((resolve) => (gate.release = resolve));
  let calls = 0;
  fetchMock.mockImplementation(async (_url, init) => {
    const id = (JSON.parse(String(init?.body)) as { registrationId: number }).registrationId;
    if (id === 5 && calls++ === 0) {
      await first; // (the background save of Eve, answered only after "Saada" in the confirmation was tapped)
      return json(409, conflictBody("Teisest seadmest"));
    }
    return json(409, conflictBody("Teisest seadmest"));
  });
  await render({ single: false, students: [student(4, "Dora"), student(5, "Eve")] });
  await click("[data-student='5']");
  await type("[data-note='0']", "Valmis, Evel.");
  await click("[data-student='4']"); // Eve's save is on its way
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Dora, Eve");
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 4, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-confirm-send]");
  await act(async () => gate.release());
  await wait(0);
  await wait(0);
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([{ registrationId: 4, version: 1 }]);
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Dora.");
  expect($$("[data-summary-failed]").map((p) => p.textContent)).toEqual([reviewAll("Eve")]);
  await click("[data-student='5']");
  expect($("[data-send-error]")!.textContent).toBe(REVIEW); // (and under her own button: her notice is above)
});

// ---------- what a bulk leaves under each student's own button ----------

test("a failed single 'Saada', then a bulk that sends her: no failure line is left under her now-sent protocol, and one the bulk could not send gets its reason under her own button", async () => {
  actions.sendProtocolAction.mockResolvedValue({ kind: "failed" });
  await render({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe("Saatmine ei õnnestunud. Proovi uuesti.");
  actions.sendProtocolsAction.mockResolvedValue([
    { registrationId: 1, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } },
    { registrationId: 2, result: { kind: "cancelled" } },
  ]);
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect($("[data-student='1']")!.getAttribute("data-status")).toBe("sent");
  expect($("[data-send-error]")).toBeNull(); // (Anu's screen: the red line is gone with the send)
  await click("[data-student='2']");
  expect($("[data-send-error]")!.textContent).toBe("Registreering on tühistatud: protokolli ei saadeta.");
  await click("[data-student='1']");
  expect($("[data-send-error]")).toBeNull();
});

// ---------- a screen restored by the browser's Back (fix round 1 of Task 11) ----------
// Next restores the page from the client router's copy of the visit's server render, which is older than what was saved since. The screen reads the
// server's text again (GET /api/admin/protokoll; here `answered` is its answer) and until it has it does not call its text saved, and a send waits
// for it: it is never made on text that is not the server's, and never on a text Maria has not been shown.

const OLD = student(1, "Kati", { version: 1, notes: ["Esimene.", ""], savedAt: "2026-10-12T08:00:00.000Z" });
const NEW = student(1, "Kati", { version: 2, notes: ["Teine.", ""], savedAt: "2026-10-12T08:05:00.000Z" });

test("a restored screen: 'Saada' waits for the server's text; another text is shown and NOT sent, with the line that says so; pressed again it sends that version", async () => {
  actions.sendProtocolAction.mockResolvedValue({ kind: "sent", again: false, version: 2, sentAt: SENT_AT });
  await renderOnly({ single: true, students: [OLD] });
  expect(read).toHaveBeenCalledTimes(1);
  expect($("[data-save-status]")!.textContent).toBe("Kontrollin salvestatud teksti…");
  await click("[data-send='first']");
  expect(actions.sendProtocolAction).not.toHaveBeenCalled(); // waiting for the server's text
  expect($("[data-send='first']")!.textContent).toBe("Saadan…");
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true);
  await answered(answer([NEW]));
  expect(actions.sendProtocolAction).not.toHaveBeenCalled(); // the text on the screen changed under her: not sent unseen
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Teine.");
  expect($("[data-send-error]")!.textContent).toBe("Protokolli muudeti vahepeal mujal ja siin on nüüd uus tekst. Vaata see üle ja saada siis.");
  expect($("[data-save-status]")!.textContent).toBe("Salvestatud 11:05");
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled(); // and nothing was saved over it
  await click("[data-send='first']");
  expect(actions.sendProtocolAction).toHaveBeenCalledTimes(1);
  expect(actions.sendProtocolAction).toHaveBeenCalledWith({ registrationId: 1, version: 2 });
});

test("a restored screen whose text the server still holds: 'Saada' sends after the server's text is read, at that version", async () => {
  actions.sendProtocolAction.mockResolvedValue({ kind: "sent", again: false, version: 1, sentAt: SENT_AT });
  await renderOnly({ single: true, students: [OLD] });
  await click("[data-send='first']");
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
  await answered(answer([OLD]));
  expect(actions.sendProtocolAction).toHaveBeenCalledWith({ registrationId: 1, version: 1 });
  expect($("[data-send-error]")).toBeNull();
  expect($("[data-locked]")).not.toBeNull();
});

test("a restored screen the server never answers: 'Saada' says the text is not confirmed after 10 s and sends nothing; the boxes are writable again", async () => {
  await renderOnly({ single: true, students: [OLD] });
  await click("[data-send='first']");
  await wait(9_999);
  expect($("[data-send='first']")!.textContent).toBe("Saadan…");
  await wait(1);
  expect($("[data-send-error]")!.textContent).toBe("Kõik pole veel salvestatud. Saada uuesti, kui ühendus on tagasi.");
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
  expect($("[data-save-status]")!.textContent).toBe("Kontrollin salvestatud teksti…"); // it still has not read the server's text
});

test("a restored screen: 'Lukusta ja saada kõik' waits for the server's text; the one whose text changed is shown and named, not sent; the others go; again, it goes", async () => {
  const view: TestView = { single: false, students: [student(1, "Anu", { version: 1, notes: ["Esimene.", ""] }), student(2, "Berit", { version: 1, notes: ["Valmis", ""] })] };
  const fresh = [student(1, "Anu", { version: 2, notes: ["Teine.", ""], savedAt: "2026-10-12T08:05:00.000Z" }), student(2, "Berit", { version: 1, notes: ["Valmis", ""] })];
  await renderOnly(view);
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Anu, Berit");
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 2, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-confirm-send]");
  expect(actions.sendProtocolsAction).not.toHaveBeenCalled(); // waiting for the server's text
  await answered(answer(fresh));
  expect(actions.sendProtocolsAction).toHaveBeenCalledTimes(1);
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([{ registrationId: 2, version: 1 }]); // Anu's stale text is not in it
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Berit.");
  expect($("[data-summary-failed]")!.textContent).toBe("Ei saadetud: Anu. Protokolli muudeti vahepeal mujal ja siin on nüüd uus tekst. Vaata see üle ja saada siis.");
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Teine."); // Anu's screen shows the server's text now
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 1, result: { kind: "sent", again: false, version: 2, sentAt: SENT_AT } }]);
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect(actions.sendProtocolsAction).toHaveBeenLastCalledWith([{ registrationId: 1, version: 2 }]);
});

test("a restored screen the server never answers: 'Lukusta ja saada kõik' sends nothing and names every student as not confirmed", async () => {
  await renderOnly({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  await wait(10_000);
  expect(actions.sendProtocolsAction).not.toHaveBeenCalled();
  expect($("[data-summary-failed]")!.textContent).toBe("Ei saadetud: Anu, Berit. Kõik pole veel salvestatud. Saada uuesti, kui ühendus on tagasi.");
  expect($("[data-send-confirm]")).toBeNull();
});

test("a student the server's answer no longer lists (cancelled meanwhile) is not one of 'Lukusta ja saada kõik': not named, not sent", async () => {
  await renderOnly({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await answered(answer([student(1, "Anu")]));
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Anu");
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 1, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-confirm-send]");
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([{ registrationId: 1, version: 1 }]);
});

// ---------- fix round 2 of Task 11: her own save while a send waits for the read; a read that is refused ----------

/** The browser's focus leaving a box (a tap on a button takes it): the box's save goes. */
const blur = async (selector: string) => {
  await act(async () => void ($(selector) as HTMLElement).dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await wait(0);
};

test("P5: the read still to come, Maria types and taps 'Saada' while her own save (the tap's blur) is on its way: its answer moves the version, but the text she was shown is the text sent — no 'changed elsewhere' line", async () => {
  actions.sendProtocolAction.mockResolvedValue({ kind: "sent", again: false, version: 2, sentAt: SENT_AT });
  let answerSave!: (r: Response) => void;
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answerSave = resolve)));
  await renderOnly({ single: true, students: [student(1, "Kati")] });
  await type("[data-note='0']", "Valmis. Lõpp.");
  await blur("[data-note='0']");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await click("[data-send='first']");
  expect($("[data-send='first']")!.textContent).toBe("Saadan…");
  await act(async () => {
    answerSave(json(200, { ok: true, version: 2, savedAt: "2026-10-12T15:05:00.000Z" }));
    await vi.advanceTimersByTimeAsync(0);
  });
  await wait(0);
  expect($("[data-send-error]")).toBeNull();
  expect(actions.sendProtocolAction).toHaveBeenCalledTimes(1);
  expect(actions.sendProtocolAction).toHaveBeenCalledWith({ registrationId: 1, version: 2 });
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Valmis. Lõpp.");
});

test("P5, 'Lukusta ja saada kõik': her own save on its way when it is pressed moves the version, and she is sent, with the text she was shown, not left out as changed", async () => {
  actions.sendProtocolsAction.mockResolvedValue([
    { registrationId: 1, result: { kind: "sent", again: false, version: 2, sentAt: SENT_AT } },
    { registrationId: 2, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } },
  ]);
  let answerSave!: (r: Response) => void;
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answerSave = resolve)));
  await renderOnly({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await type("[data-note='0']", "Valmis. Lõpp.");
  await blur("[data-note='0']");
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect(actions.sendProtocolsAction).not.toHaveBeenCalled();
  await act(async () => {
    answerSave(json(200, { ok: true, version: 2, savedAt: "2026-10-12T15:05:00.000Z" }));
    await vi.advanceTimersByTimeAsync(0);
  });
  await answered(answer([student(1, "Anu"), student(2, "Berit")])); // the read, made before her save: Anu's older version changes nothing
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([
    { registrationId: 1, version: 2 },
    { registrationId: 2, version: 1 },
  ]);
  expect($("[data-summary-failed]")).toBeNull();
  expect($("[data-summary-sent]")!.textContent).toBe("Saadetud: Anu, Berit.");
});

test("the read is refused (401): 'Saada' stops at once with the signed-out line, sends nothing, and the boxes are writable", async () => {
  await renderOnly({ single: true, students: [student(1, "Kati")] });
  await answered({ status: 401, body: { ok: false, error: "unauthorized" } });
  await click("[data-send='first']");
  expect($("[data-send-error]")!.textContent).toBe("Salvestamata — logi uuesti sisse. Tekst on selles seadmes alles.");
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect($("[data-send='first']")!.textContent).toBe("Saada");
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
});

test("the read is refused (401): 'Lukusta ja saada kõik' sends nothing and names every student under the signed-out line", async () => {
  await renderOnly({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await answered({ status: 401, body: { ok: false, error: "unauthorized" } });
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect(actions.sendProtocolsAction).not.toHaveBeenCalled();
  expect($("[data-summary-failed]")!.textContent).toBe("Ei saadetud: Anu, Berit. Salvestamata — logi uuesti sisse. Tekst on selles seadmes alles.");
});

test("a student the read no longer lists says she is gone: 'Saada' says so, and she is not one of 'Lukusta ja saada kõik'", async () => {
  await renderOnly({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await answered(answer([student(1, "Anu")]));
  await click("[data-student='2']");
  expect($("[data-editor='2'] [data-save-status]")!.textContent).toBe("Seda registreeringut enam ei ole. Tekst on selles seadmes alles.");
  await click("[data-editor='2'] [data-send='first']");
  expect($("[data-editor='2'] [data-send-error]")!.textContent).toBe("Seda registreeringut ei leitud.");
  expect(actions.sendProtocolAction).not.toHaveBeenCalled();
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Anu");
  expect($("[data-confirm-skipped]")).toBeNull();
});

// ---------- the final review's parked items ----------

test("item 7a: a student the read no longer lists is not one of 'Lukusta ja saada kõik', even with text of hers not saved yet", async () => {
  fetchMock.mockImplementation(() => new Promise<Response>(() => {})); // (her save hangs: her text stays unconfirmed)
  await renderOnly({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  await click("[data-student='2']");
  await type("[data-note='0']", "Valmis, Berit.");
  await answered(answer([student(1, "Anu")])); // Berit cancelled meanwhile: her text stays, still saving
  expect($("[data-student='2']")).not.toBeNull();
  await click("[data-send-all-open]");
  expect($("[data-confirm-will]")!.textContent).toBe("Saavad protokolli: Anu");
  actions.sendProtocolsAction.mockResolvedValue([{ registrationId: 1, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } }]);
  await click("[data-confirm-send]");
  expect(actions.sendProtocolsAction).toHaveBeenCalledWith([{ registrationId: 1, version: 1 }]);
  expect($("[data-summary-failed]")).toBeNull();
});

const REFRESHED = "Protokolli muudeti vahepeal mujal ja siin on nüüd uus tekst. Vaata see üle ja saada siis.";
const STALE = "Protokolli muudeti vahepeal mujal. Laadi leht uuesti ja vaata see üle.";

test("item 3: 'Saada' answered 'stale' (another device saved since): the server's text is read again and shown, the line says so, and the next 'Saada' sends the current version", async () => {
  actions.sendProtocolAction.mockResolvedValueOnce({ kind: "stale", version: 2 });
  await render({ single: true, students: [OLD] });
  await click("[data-send='first']");
  expect(read).toHaveBeenCalledTimes(2); // read again at once
  expect($("[data-send='first']")!.textContent).toBe("Saadan…"); // waiting for it, the boxes read-only
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(true);
  await answered(answer([NEW]));
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Teine.");
  expect($("[data-send-error]")!.textContent).toBe(REFRESHED);
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
  actions.sendProtocolAction.mockResolvedValueOnce({ kind: "sent", again: false, version: 2, sentAt: SENT_AT });
  await click("[data-send='first']");
  expect(actions.sendProtocolAction).toHaveBeenLastCalledWith({ registrationId: 1, version: 2 });
  expect($("[data-send-error]")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled(); // (nothing saved over the server's text)
});

test("item 3: 'Saada' answered 'stale' and the read never comes: after 10 s the line says to reload, and the boxes are writable", async () => {
  actions.sendProtocolAction.mockResolvedValueOnce({ kind: "stale", version: 2 });
  await render({ single: true, students: [OLD] });
  await click("[data-send='first']");
  await wait(10_000);
  expect($("[data-send-error]")!.textContent).toBe(STALE);
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
});

test("item 3: 'Lukusta ja saada kõik' answered 'stale' for one student reads the server's text again, so the next send sends her current version", async () => {
  await render({ single: false, students: [student(1, "Anu"), student(2, "Berit")] });
  actions.sendProtocolsAction.mockResolvedValueOnce([
    { registrationId: 1, result: { kind: "sent", again: false, version: 1, sentAt: SENT_AT } },
    { registrationId: 2, result: { kind: "stale", version: 2 } },
  ]);
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect($$("[data-summary-failed]").map((p) => p.textContent)).toEqual([`Ei saadetud: Berit. ${STALE}`]);
  expect(read).toHaveBeenCalledTimes(2); // read again at once
  await answered(answer([student(1, "Anu", { sentVersion: 1, sentAt: SENT_AT }), student(2, "Berit", { version: 2, notes: ["Teine.", ""] })]));
  await click("[data-student='2']");
  expect(($("[data-note='0']") as HTMLTextAreaElement).value).toBe("Teine.");
  actions.sendProtocolsAction.mockResolvedValueOnce([{ registrationId: 2, result: { kind: "sent", again: false, version: 2, sentAt: SENT_AT } }]);
  await click("[data-send-all-open]");
  await click("[data-confirm-send]");
  expect(actions.sendProtocolsAction).toHaveBeenLastCalledWith([{ registrationId: 2, version: 2 }]);
});
