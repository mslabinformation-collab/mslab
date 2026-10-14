// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AssessmentScreen } from "@/components/admin/AssessmentScreen";
import type { ScreenAnswer } from "@/components/admin/protocol-autosave";
import type { ScreenStudentView, ScreenView } from "@/components/admin/ProtocolScreen";
import type { AssessmentView } from "@/domain/protocols";

// Maria's assessment screen (spec §5.3, §8; R2, R3): under each point's heading its photos and verdict buttons, then its box; the taps stored at
// once and kept when they cannot be; "Saada hinnang" with its checks, its one confirmation, the notes saved and every tap stored first; the
// screen locked after it; the notes-only protocol of an e-course without points; the student's new round brought by a read. Every tap and the
// send name the round the screen shows: the server's "stale" (the student sent a new round meanwhile) reads the new round and says so.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const action = vi.hoisted(() => ({ sendAssessmentAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => action);
vi.mock("@/server/actions/admin-protocols", () => ({ sendProtocolAction: vi.fn(), sendProtocolsAction: vi.fn() })); // the course day's sends are never used here

const TITLES = ["Ettevalmistus", "Kulmude kuju", "Värvimine"];
const SENT_AT = "2026-11-11T09:00:00.000Z";
const NEW_ROUND = "Õpilane saatis vahepeal uue vooru. Vaata see üle.";
const photo = (id: number, round = 1) => ({ id, round, width: 1600, height: 1200 });
const assessment = (over: Partial<AssessmentView> = {}): AssessmentView => ({
  accessId: 4,
  clientId: 2,
  email: "kati@example.com",
  status: "review",
  round: 1,
  submittedAt: "2026-11-10T10:00:00.000Z",
  verdicts: [null, null, null],
  sentVerdicts: null,
  photos: [[photo(11), photo(12)], [photo(13)], [photo(14)]],
  locked: false,
  expiresAt: "2027-05-10T10:00:00.000Z",
  ...over,
});
const student = (over: Partial<ScreenStudentView> = {}): ScreenStudentView => ({
  registrationId: 4, // the ACCESS's id on an access's screen
  protocolId: 9,
  name: "Kati Kask",
  awaiting: false,
  version: 1,
  titles: TITLES,
  notes: ["", "", ""],
  generalNote: "",
  sentVersion: null,
  sentAt: null,
  savedAt: null,
  assessment: assessment(),
  ...over,
});

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** What the server holds of the verdicts: POST /api/admin/hinnang stores each tap here (`storing`) unless a test answers otherwise. */
let held: (string | null)[];
const storing = async (b: { stage: number; verdict: string | null }) => {
  held[b.stage] = b.verdict;
  return json(200, { ok: true, verdicts: [...held] });
};
let verdictAnswer: (b: { stage: number; verdict: string | null }) => Promise<Response>;
const posted = (url: string) => fetchMock.mock.calls.filter(([u]) => String(u) === url).map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
// The screen reads the server's text again when it is shown (here `read`, answered by hand: each call waits for the test).
const pending: ((answer: ScreenAnswer) => void)[] = [];
const read = vi.fn(() => new Promise<ScreenAnswer>((resolve) => pending.push(resolve)));
const answer = (students: ScreenStudentView[]): ScreenAnswer => ({ status: 200, body: { ok: true, students } });
const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const answered = async (reply: ScreenAnswer) => {
  await act(async () => {
    pending.pop()!(reply);
    await Promise.resolve();
  });
  await wait();
};
const view = (s: ScreenStudentView): ScreenView => ({ single: true, owner: "access", source: { ligipaas: 4 }, students: [s] });
const render = async (s: ScreenStudentView) => {
  await act(async () => root.render(createElement(AssessmentScreen, { view: view(s), read })));
  await answered(answer([s]));
};
const click = async (selector: string) => {
  await act(async () => ($(selector) as HTMLElement).click());
  await wait();
  await wait();
};
const type = async (selector: string, value: string) =>
  act(async () => {
    const el = $(selector) as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const pressed = (point: number) => $$(`[data-assess-point='${point}'] [data-verdict]`).map((b) => b.getAttribute("aria-pressed"));
const ids = (selector: string) => $$(selector).map((el) => el.getAttribute("data-assess-photo"));
const allOff = () => $$("[data-verdict]").every((b) => (b as HTMLButtonElement).disabled);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  held = [null, null, null];
  verdictAnswer = storing;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { stage: number; verdict: string | null; version: number };
    if (String(input) === "/api/admin/hinnang") return verdictAnswer(body);
    return json(200, { ok: true, version: body.version + 1, savedAt: "2026-11-11T08:00:00.000Z", protocolId: 9 }); // the notes' save
  });
  vi.stubGlobal("fetch", fetchMock);
  action.sendAssessmentAction.mockReset();
  read.mockClear();
  pending.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("each point: under its heading the newest round's photos, the earlier ones folded, the verdict buttons, then its box; 'Saada hinnang' is the one send; a photo opens the viewer", async () => {
  await render(student({ assessment: assessment({ round: 2, photos: [[photo(11), photo(12)], [photo(21, 2), photo(13)], [photo(14)]] }) }));
  expect($$("[data-assess-point]").map((p) => p.getAttribute("data-assess-point"))).toEqual(["0", "1", "2"]);
  expect(ids("[data-assess-point='0'] [data-latest-photos] [data-assess-photo]")).toEqual(["11", "12"]);
  expect(ids("[data-assess-point='1'] [data-latest-photos] [data-assess-photo]")).toEqual(["21"]);
  expect(ids("[data-assess-point='1'] [data-earlier-photos] [data-assess-photo]")).toEqual(["13"]);
  expect($("[data-assess-point='0'] [data-earlier-photos]")).toBeNull();
  expect($("[data-assess-photo='21'] img")!.getAttribute("src")).toBe("/api/admin/foto/21?v=pisi");
  expect($$("[data-assess-point='0'] [data-verdict]").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
    ["Kinnitatud", "false"],
    ["Paranda", "false"],
  ]);
  // the point's heading (its box's label), then its photos and verdicts, then its box
  const label = $("[data-editor='4'] label")!;
  const point = $("[data-assess-point='0']")!;
  expect(label.textContent).toBe("Ettevalmistus");
  expect(label.compareDocumentPosition(point) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(point.compareDocumentPosition($("[data-note='0']")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect($$("[data-assess-send]").map((b) => b.textContent)).toEqual(["Saada hinnang"]);
  expect([$("[data-send]"), $("[data-send-all-open]")]).toEqual([null, null]); // not the course day's buttons
  expect($("[data-assess-status]")!.textContent).toBe("Ootab hindamist");
  await click("[data-assess-photo='12']");
  expect($("[data-photo-viewer] img")!.getAttribute("src")).toBe("/api/admin/foto/12");
  expect($("[data-viewer-count]")!.textContent).toBe("2 / 2");
  await click("[data-viewer-close]");
  expect($("[data-photo-viewer]")).toBeNull();
});

test("R2: a tap is stored at once through /api/admin/hinnang, naming the round the screen shows, never through the notes' save; the pressed one tapped again clears it", async () => {
  await render(student());
  await click("[data-assess-point='1'] [data-verdict='fix']");
  expect(posted("/api/admin/hinnang")).toEqual([{ accessId: 4, protocolId: 9, round: 1, stage: 1, verdict: "fix" }]);
  expect(pressed(1)).toEqual(["false", "true"]);
  expect(posted("/api/admin/protokoll")).toEqual([]);
  await click("[data-assess-point='1'] [data-verdict='fix']");
  expect(posted("/api/admin/hinnang")[1]).toEqual({ accessId: 4, protocolId: 9, round: 1, stage: 1, verdict: null });
  expect(pressed(1)).toEqual(["false", "false"]);
  expect($("[data-verdict-unsaved]")).toBeNull();
});

test("a tap with no answer keeps its look with 'Salvestamata'; the next tap sends it again before its own", async () => {
  await render(student());
  verdictAnswer = () => Promise.reject(new TypeError("offline"));
  await click("[data-assess-point='0'] [data-verdict='ok']");
  expect(pressed(0)).toEqual(["true", "false"]);
  expect($("[data-assess-point='0'] [data-verdict-unsaved]")!.textContent).toBe("Salvestamata");
  verdictAnswer = storing;
  await click("[data-assess-point='2'] [data-verdict='ok']");
  expect(posted("/api/admin/hinnang").map((b) => [b.stage, b.verdict])).toEqual([[0, "ok"], [0, "ok"], [2, "ok"]]);
  expect($("[data-verdict-unsaved]")).toBeNull();
  expect([pressed(0), pressed(2)]).toEqual([["true", "false"], ["true", "false"]]);
});

test("a refused tap (the work changed meanwhile) is dropped, says so, and the screen reads the server again", async () => {
  await render(student());
  verdictAnswer = async () => json(409, { ok: false, error: "closed" });
  const reads = read.mock.calls.length;
  await click("[data-assess-point='0'] [data-verdict='ok']");
  expect(pressed(0)).toEqual(["false", "false"]);
  expect($("[data-assess-error]")!.textContent).toBe("Hinnangut ei salvestatud: töö seis muutus vahepeal. Vaata punktid üle.");
  expect(read.mock.calls.length).toBe(reads + 1);
});

test("a tap from a screen of an older round: the server stores nothing ('stale'), the screen reads the student's new round and says she sent one; the next tap names the new round", async () => {
  await render(student());
  verdictAnswer = async () => json(409, { ok: false, error: "stale" });
  const reads = read.mock.calls.length;
  await click("[data-assess-point='0'] [data-verdict='ok']");
  expect(posted("/api/admin/hinnang")).toEqual([{ accessId: 4, protocolId: 9, round: 1, stage: 0, verdict: "ok" }]);
  expect(pressed(0)).toEqual(["false", "false"]);
  expect($("[data-assess-error]")!.textContent).toBe(NEW_ROUND);
  expect(read.mock.calls.length).toBe(reads + 1);
  await answered(answer([student({ assessment: assessment({ round: 2, photos: [[photo(41, 2), photo(11)], [photo(13)], [photo(14)]] }) })]));
  expect(ids("[data-assess-point='0'] [data-latest-photos] [data-assess-photo]")).toEqual(["41"]);
  expect($("[data-assess-error]")!.textContent).toBe(NEW_ROUND);
  verdictAnswer = storing;
  await click("[data-assess-point='0'] [data-verdict='ok']");
  expect(posted("/api/admin/hinnang")[1]).toEqual({ accessId: 4, protocolId: 9, round: 2, stage: 0, verdict: "ok" });
  expect(pressed(0)).toEqual(["true", "false"]);
  expect($("[data-assess-error]")).toBeNull();
});

test("before the student has sent her work: the verdict buttons are off and 'Saada hinnang' says why; Maria's notes save already, as the access's", async () => {
  await render(student({ protocolId: null, version: 0, assessment: assessment({ status: "open", round: 0, submittedAt: null, photos: [[], [], []] }) }));
  expect(allOff()).toBe(true);
  expect($$("[data-no-photos]")).toHaveLength(3);
  expect($("[data-assess-waiting]")).not.toBeNull();
  expect($("[data-assess-status]")!.textContent).toBe("Ootab õpilase tööd");
  await click("[data-assess-send]");
  expect($("[data-assess-error]")!.textContent).toBe("Õpilane ei ole tööd veel hindamiseks saatnud.");
  expect(action.sendAssessmentAction).not.toHaveBeenCalled();
  await type("[data-note='0']", "Jälgi valgust");
  await wait(1500);
  expect(posted("/api/admin/protokoll")).toEqual([{ accessId: 4, protocolId: null, version: 0, titles: TITLES, notes: ["Jälgi valgust", "", ""], generalNote: "" }]);
});

test("'Saada hinnang' names the points without a verdict, then the Paranda points without a note; then one confirmation; it saves the notes, sends the version and the round, and the screen locks", async () => {
  action.sendAssessmentAction.mockResolvedValue({ kind: "sent", status: "fix", completed: false, version: 2, sentAt: SENT_AT });
  await render(student());
  await click("[data-assess-point='0'] [data-verdict='ok']");
  await click("[data-assess-point='1'] [data-verdict='fix']");
  await click("[data-assess-send]");
  expect($("[data-assess-error]")!.textContent).toBe("Vali hinnang ka punktidele: 3.");
  await click("[data-assess-point='2'] [data-verdict='ok']");
  await click("[data-assess-send]");
  expect($("[data-assess-error]")!.textContent).toBe("Lisa märkus Paranda-punktidele: 2.");
  await type("[data-note='1']", "Kuju on ebaühtlane");
  await click("[data-assess-send]");
  expect($("[data-assess-error]")).toBeNull();
  expect($("[data-assess-confirm-box]")!.textContent).toContain("Kinnitatud: 2 · Paranda: 1");
  expect(action.sendAssessmentAction).not.toHaveBeenCalled();
  await click("[data-assess-confirm]");
  expect(posted("/api/admin/protokoll")).toEqual([{ accessId: 4, protocolId: 9, version: 1, titles: TITLES, notes: ["", "Kuju on ebaühtlane", ""], generalNote: "" }]);
  expect(action.sendAssessmentAction.mock.calls).toEqual([[{ accessId: 4, version: 2, protocolId: 9, round: 1 }]]);
  expect($("[data-assess-sent]")!.textContent).toBe("Hinnang saadetud. Paranda-punktid: 2.");
  expect($("[data-assess-confirm-box]")).toBeNull();
  expect($("[data-assess-status]")!.getAttribute("data-assess-status")).toBe("fix");
  // sent: read-only until "Muuda" (a correction of the same round, spec §8), the verdicts too
  expect($("[data-edit]")).not.toBeNull();
  expect(($("[data-note='1']") as HTMLTextAreaElement).readOnly).toBe(true);
  expect(allOff()).toBe(true);
  await click("[data-edit]");
  expect([allOff(), ($("[data-note='1']") as HTMLTextAreaElement).readOnly, $("[data-assess-send]")!.textContent]).toEqual([false, false, "Saada hinnang"]);
});

test("an approving send locks the verdicts for good: 'Muuda' opens the notes only, and they go again with 'Saada uuesti'", async () => {
  action.sendAssessmentAction.mockResolvedValue({ kind: "sent", status: "passed", completed: true, version: 1, sentAt: SENT_AT });
  await render(student());
  for (const point of [0, 1, 2]) await click(`[data-assess-point='${point}'] [data-verdict='ok']`);
  await click("[data-assess-send]");
  expect($("[data-assess-confirm-box]")!.textContent).toContain("Kõik punktid on kinnitatud: praktiline töö on sooritatud.");
  await click("[data-assess-confirm]");
  expect(action.sendAssessmentAction.mock.calls).toEqual([[{ accessId: 4, version: 1, protocolId: 9, round: 1 }]]);
  expect($("[data-assess-sent]")!.textContent).toBe("Hinnang saadetud. Koolitus on lõpetatud.");
  expect($("[data-assess-locked]")).not.toBeNull();
  await click("[data-edit]");
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
  expect(allOff()).toBe(true);
  expect($("[data-assess-send]")!.textContent).toBe("Saada uuesti");
});

test("a tap that cannot be stored stops the send, and says so: nothing goes to the student", async () => {
  await render(student());
  verdictAnswer = () => Promise.reject(new TypeError("offline"));
  for (const point of [0, 1, 2]) await click(`[data-assess-point='${point}'] [data-verdict='ok']`);
  expect($$("[data-verdict-unsaved]")).toHaveLength(3);
  await click("[data-assess-send]");
  await click("[data-assess-confirm]");
  expect($("[data-assess-error]")!.textContent).toBe("Kõik hinnangud ei ole veel salvestatud. Proovi uuesti, kui ühendus on tagasi.");
  expect(action.sendAssessmentAction).not.toHaveBeenCalled();
});

test("'Saada hinnang' from a screen of an older round: the server sends nothing ('stale'); the screen reads the student's new round, shows it and says she sent one", async () => {
  action.sendAssessmentAction.mockResolvedValue({ kind: "stale", version: 1 });
  await render(student({ assessment: assessment({ verdicts: ["ok", "ok", "ok"] }) }));
  await click("[data-assess-send]");
  const reads = read.mock.calls.length;
  await click("[data-assess-confirm]");
  expect(action.sendAssessmentAction.mock.calls).toEqual([[{ accessId: 4, version: 1, protocolId: 9, round: 1 }]]);
  expect(read.mock.calls.length).toBe(reads + 1); // the send waits for the read
  const round2 = assessment({ round: 2, verdicts: ["ok", null, "ok"], photos: [[photo(11)], [photo(31, 2), photo(13)], [photo(14)]] });
  await answered(answer([student({ assessment: round2 })]));
  expect($("[data-assess-error]")!.textContent).toBe(NEW_ROUND);
  expect($("[data-assess-sent]")).toBeNull();
  expect(ids("[data-assess-point='1'] [data-latest-photos] [data-assess-photo]")).toEqual(["31"]);
  expect([pressed(0), pressed(1)]).toEqual([["true", "false"], ["false", "false"]]);
  expect($("[data-assess-confirm-box]")).toBeNull();
});

test("an e-course without points: the plain notes protocol, sent with 'Saada' as a contact course's — no verdicts, no confirmation", async () => {
  action.sendAssessmentAction.mockResolvedValue({ kind: "sent", status: "open", completed: false, version: 2, sentAt: SENT_AT });
  await render(student({ titles: [], notes: [], assessment: assessment({ status: "open", round: 0, submittedAt: null, verdicts: [], photos: [] }) }));
  expect([$("[data-assess-point]"), $("[data-verdict]"), $("[data-assess-status]")]).toEqual([null, null, null]);
  expect($("[data-assess-send]")!.textContent).toBe("Saada");
  await click("[data-assess-send]");
  expect($("[data-assess-error]")!.textContent).toBe("Protokoll on tühi. Kirjuta midagi enne saatmist.");
  await type("[data-general]", "Tubli töö, jätka harjutamist.");
  await click("[data-assess-send]");
  expect($("[data-assess-confirm-box]")).toBeNull();
  expect(action.sendAssessmentAction.mock.calls).toEqual([[{ accessId: 4, version: 2, protocolId: 9, round: 0 }]]);
  expect($("[data-assess-sent]")!.textContent).toBe("Märkused saadetud.");
  expect($("[data-edit]")).not.toBeNull();
});

test("R3: coming back to the window reads the server again, and the student's new round is shown: its photos, the Paranda verdict cleared, the notes open without 'Muuda'", async () => {
  const sent = { version: 2, sentVersion: 2, sentAt: SENT_AT, notes: ["", "Kuju on ebaühtlane", ""] };
  await render(student({ ...sent, assessment: assessment({ status: "fix", verdicts: ["ok", "fix", "ok"], sentVerdicts: ["ok", "fix", "ok"] }) }));
  expect([$("[data-edit]") !== null, allOff()]).toEqual([true, true]);
  await act(async () => void window.dispatchEvent(new Event("focus")));
  const round2 = assessment({ status: "review", round: 2, verdicts: ["ok", null, "ok"], sentVerdicts: ["ok", "fix", "ok"], photos: [[photo(11)], [photo(31, 2), photo(13)], [photo(14)]] });
  await answered(answer([student({ ...sent, assessment: round2 })]));
  expect(ids("[data-assess-point='1'] [data-latest-photos] [data-assess-photo]")).toEqual(["31"]);
  expect([pressed(0), pressed(1)]).toEqual([["true", "false"], ["false", "false"]]);
  expect($("[data-assess-status]")!.getAttribute("data-assess-status")).toBe("review");
  expect($("[data-edit]")).toBeNull();
  expect(($("[data-note='1']") as HTMLTextAreaElement).readOnly).toBe(false);
  expect(allOff()).toBe(false);
});
