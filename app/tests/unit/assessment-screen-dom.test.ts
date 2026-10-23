// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AssessmentScreen } from "@/components/admin/AssessmentScreen";
import type { ScreenAnswer } from "@/components/admin/protocol-autosave";
import type { ScreenStudentView, ScreenView } from "@/components/admin/ProtocolScreen";
import type { AssessmentView } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";

// Maria's assessment screen (spec §5.3, §8; R2, R3; admin UX pass README A4): the header (the student, a meta line, the save chip), the action bar
// („{n} punkti · {k} hinnatud“, „Kinnita kõik“, „Saada hinnang · {k} kinnitatud, {p} paranda“), and a card for each point (its photos, its title,
// the segmented verdict, a comment box that opens by itself on „Paranda“ and „Lisa märkus“ otherwise); the taps stored at once and kept when
// they cannot be; the send with its checks and NO confirmation, the notes saved and every tap stored first; the screen locked after it; the
// notes-only protocol of an e-course without points; the student's new round brought by a read. Every tap and the send name the round the
// screen shows: the server's "stale" (the student sent a new round meanwhile) reads the new round and says so.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const action = vi.hoisted(() => ({ sendAssessmentAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => action);
vi.mock("@/server/actions/admin-protocols", () => ({ sendProtocolAction: vi.fn(), sendProtocolsAction: vi.fn() })); // the course day's sends are never used here

const TITLES = ["Ettevalmistus", "Kulmude kuju", "Värvimine"];
const SENT_AT = "2026-11-11T09:00:00.000Z";
const NEW_ROUND = "Õpilane saatis vahepeal uue korra. Vaata see üle.";
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
const render = async (s: ScreenStudentView, extra: { course?: string; expired?: string } = {}) => {
  await act(async () => root.render(createElement(AssessmentScreen, { view: view(s), read, ...extra })));
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

test("the header: the student is the H1, the meta line names the course, the round, the day it was sent and the status; the chip is the page's SaveStatus", async () => {
  await render(student(), { course: "Kulmude e-kursus" });
  expect($("h1")!.textContent).toBe("Kati Kask");
  expect($("[data-assess-course]")!.textContent).toBe("Kulmude e-kursus");
  expect($("[data-assess-round]")!.textContent).toBe("Praktiline töö, 1. kord");
  expect($("[data-assess-sent-at]")!.textContent).toBe("saadetud 10.11.2026 12:00");
  expect($("[data-assess-status]")!.textContent).toBe("Ootab hindamist");
  expect($("[data-editor='4'] [data-save-status]")).not.toBeNull();
  // the chip sits in the header row with the title, not in a card of its own
  expect($("[data-assess-head]")!.contains($("[data-save-status]"))).toBe(true);
  // an access that ran out says so under the header
  expect($("[data-access-expired]")).toBeNull();
  await act(async () => root.render(createElement(AssessmentScreen, { view: view(student()), read, expired: "Ligipääs lõppes 01.01.2026. Hinnata ja saata saad ikka." })));
  expect($("[data-access-expired]")!.textContent).toBe("Ligipääs lõppes 01.01.2026. Hinnata ja saata saad ikka.");
});

test("each point is a card: its newest round's photos (the first one large), the earlier ones folded, its title, the segmented verdict, then 'Lisa märkus'; a photo opens the viewer", async () => {
  await render(student({ assessment: assessment({ round: 2, photos: [[photo(11), photo(12)], [photo(21, 2), photo(13)], [photo(14)]] }) }));
  expect($$("[data-assess-point]").map((p) => p.getAttribute("data-assess-point"))).toEqual(["0", "1", "2"]);
  expect($$("[data-assess-point] [data-assess-title]").map((h) => h.textContent)).toEqual(TITLES);
  expect(ids("[data-assess-point='0'] [data-latest-photos] [data-assess-photo]")).toEqual(["11", "12"]);
  expect($("[data-assess-point='0'] [data-assess-photo='11']")!.hasAttribute("data-assess-hero")).toBe(true);
  expect($("[data-assess-point='0'] [data-assess-photo='12']")!.hasAttribute("data-assess-hero")).toBe(false);
  expect(ids("[data-assess-point='1'] [data-latest-photos] [data-assess-photo]")).toEqual(["21"]);
  expect(ids("[data-assess-point='1'] [data-earlier-photos] [data-assess-photo]")).toEqual(["13"]);
  expect($("[data-assess-point='0'] [data-earlier-photos]")).toBeNull();
  expect($("[data-assess-photo='21'] img")!.getAttribute("src")).toBe("/api/admin/foto/21?v=pisi");
  expect($$("[data-assess-point='0'] [data-verdict]").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
    ["Kinnitatud", "false"],
    ["Paranda", "false"],
  ]);
  // the card: its photos, its title, the verdict, then the way to a comment (no box until one is wanted)
  const card = $("[data-assess-point='0']")!;
  const order = ["[data-latest-photos]", "[data-assess-title]", "[data-verdict]", "[data-add-note]"].map((selector) => card.querySelector(selector)!);
  order.slice(1).forEach((el, i) => expect(order[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING, `part ${i + 1} follows part ${i}`).toBeTruthy());
  expect($$("[data-add-note]").map((b) => b.textContent)).toEqual(["Lisa märkus", "Lisa märkus", "Lisa märkus"]);
  expect($("[data-note]")).toBeNull();
  // the one send is the informed button; not the course day's buttons
  expect($$("[data-assess-send]").map((b) => b.textContent)).toEqual(["Saada hinnang · 0 kinnitatud"]);
  expect([$("[data-send]"), $("[data-send-all-open]")]).toEqual([null, null]);
  await click("[data-assess-photo='12']");
  expect($("[data-photo-viewer] img")!.getAttribute("src")).toBe("/api/admin/foto/12");
  expect($("[data-viewer-count]")!.textContent).toBe("2 / 2");
  await click("[data-viewer-close]");
  expect($("[data-photo-viewer]")).toBeNull();
});

test("the action bar: '{n} punkti · {k} hinnatud' follows the taps, 'Kinnita kõik' and the send are in it, the send is 'Saada hinnang · {k} kinnitatud, {p} paranda' and drops ', 0 paranda'", async () => {
  await render(student());
  expect($("[data-assess-progress]")!.textContent).toBe("3 punkti · 0 hinnatud");
  expect($("[data-approve-all]")!.textContent).toBe("Kinnita kõik");
  expect($("[data-assess-bar]")!.contains($("[data-approve-all]"))).toBe(true);
  expect($("[data-assess-bar]")!.contains($("[data-assess-send]"))).toBe(true);
  expect($("[data-assess-send]")!.textContent).toBe("Saada hinnang · 0 kinnitatud"); // k = 0 stays literal
  await click("[data-assess-point='0'] [data-verdict='ok']");
  await click("[data-assess-point='1'] [data-verdict='ok']");
  expect($("[data-assess-progress]")!.textContent).toBe("3 punkti · 2 hinnatud");
  expect($("[data-assess-send]")!.textContent).toBe("Saada hinnang · 2 kinnitatud"); // nothing to fix: no ', 0 paranda'
  await click("[data-assess-point='2'] [data-verdict='fix']");
  expect($("[data-assess-progress]")!.textContent).toBe("3 punkti · 3 hinnatud");
  expect($("[data-assess-send]")!.textContent).toBe("Saada hinnang · 2 kinnitatud, 1 paranda");
  await click("[data-assess-point='2'] [data-verdict='fix']"); // cleared again
  expect($("[data-assess-send]")!.textContent).toBe("Saada hinnang · 2 kinnitatud");
});

test("'Kinnita kõik' approves only the points without a verdict, one tap each naming the round; 'Paranda' stays; the button then has nothing left to do", async () => {
  held = [null, "fix", null];
  await render(student({ assessment: assessment({ verdicts: [null, "fix", null] }) }));
  await click("[data-approve-all]");
  expect(posted("/api/admin/hinnang")).toEqual([
    { accessId: 4, protocolId: 9, round: 1, stage: 0, verdict: "ok" },
    { accessId: 4, protocolId: 9, round: 1, stage: 2, verdict: "ok" },
  ]);
  expect([pressed(0), pressed(1), pressed(2)]).toEqual([["true", "false"], ["false", "true"], ["true", "false"]]);
  expect($("[data-assess-progress]")!.textContent).toBe("3 punkti · 3 hinnatud");
  expect($("[data-assess-send]")!.textContent).toBe("Saada hinnang · 2 kinnitatud, 1 paranda");
  expect($("[data-approve-all]")!.getAttribute("aria-disabled")).toBe("true");
  await click("[data-approve-all]");
  expect(posted("/api/admin/hinnang")).toHaveLength(2);
  expect($("[data-verdict-unsaved]")).toBeNull();
});

test("'Kinnita kõik' with no answer keeps the taps ('Salvestamata'); the next tap's refusal drops them, says so and reads the server again", async () => {
  await render(student());
  verdictAnswer = () => Promise.reject(new TypeError("offline"));
  await click("[data-approve-all]");
  expect($$("[data-verdict-unsaved]")).toHaveLength(3);
  expect([pressed(0), pressed(1), pressed(2)]).toEqual([["true", "false"], ["true", "false"], ["true", "false"]]);
  verdictAnswer = async () => json(409, { ok: false, error: "closed" });
  const reads = read.mock.calls.length;
  await click("[data-assess-point='0'] [data-verdict='ok']"); // sends the kept ones first: refused
  expect($("[data-assess-error]")!.textContent).toBe("Hinnangut ei salvestatud: töö seis muutus vahepeal. Vaata punktid üle.");
  expect(read.mock.calls.length).toBeGreaterThan(reads);
});

test("'Kinnita kõik' is off while nothing is submitted: it sends nothing", async () => {
  await render(student({ protocolId: null, version: 0, assessment: assessment({ status: "open", round: 0, submittedAt: null, photos: [[], [], []] }) }));
  expect($("[data-approve-all]")!.getAttribute("aria-disabled")).toBe("true");
  await click("[data-approve-all]");
  expect(posted("/api/admin/hinnang")).toEqual([]);
});

test("the send has no confirmation: with every point decided it saves the notes, stores the taps and sends at once", async () => {
  action.sendAssessmentAction.mockResolvedValue({ kind: "sent", status: "passed", completed: true, version: 1, sentAt: SENT_AT });
  await render(student());
  await click("[data-approve-all]");
  await click("[data-assess-send]");
  expect([$("[data-assess-confirm-box]"), $("[data-confirm-panel]"), $("[data-assess-confirm]")]).toEqual([null, null, null]);
  expect(action.sendAssessmentAction.mock.calls).toEqual([[{ accessId: 4, version: 1, protocolId: 9, round: 1 }]]);
  expect($("[data-assess-sent]")!.textContent).toBe("Hinnang saadetud. Koolitus on lõpetatud.");
});

test("'Paranda' opens the comment box by itself; 'Kinnitatud' and a point not yet decided offer 'Lisa märkus', which opens it with the focus in it; words already there keep it open", async () => {
  await render(student({ notes: ["", "", "Hea valgus."] }));
  expect($("[data-assess-point='1'] [data-note]")).toBeNull();
  await click("[data-assess-point='1'] [data-verdict='fix']");
  const box = $("[data-assess-point='1'] [data-note='1']") as HTMLTextAreaElement;
  expect(box).not.toBeNull();
  expect(box.getAttribute("aria-label")).toBe("Märkus: Kulmude kuju");
  expect($("[data-assess-point='1'] [data-add-note]")).toBeNull();
  expect(document.activeElement).not.toBe(box); // the focus stays on the verdict button
  await click("[data-assess-point='1'] [data-verdict='ok']"); // changed her mind, nothing written
  expect($("[data-assess-point='1'] [data-note]")).toBeNull();
  expect($("[data-assess-point='1'] [data-add-note]")).not.toBeNull();
  await click("[data-assess-point='0'] [data-add-note]");
  expect($("[data-assess-point='0'] [data-add-note]")).toBeNull();
  expect(document.activeElement).toBe($("[data-assess-point='0'] [data-note='0']"));
  // a note already written stays open whatever the verdict
  expect(($("[data-assess-point='2'] [data-note='2']") as HTMLTextAreaElement).value).toBe("Hea valgus.");
  // words typed into a box keep it open when they are deleted again
  await type("[data-note='0']", "x");
  await type("[data-note='0']", "");
  expect($("[data-assess-point='0'] [data-note='0']")).not.toBeNull();
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
  expect($("[data-assess-round]")!.textContent).toBe("Praktiline töö: õpilane ei ole veel saatnud");
  await click("[data-assess-send]");
  expect($("[data-assess-error]")!.textContent).toBe("Õpilane ei ole tööd veel hindamiseks saatnud.");
  expect(action.sendAssessmentAction).not.toHaveBeenCalled();
  await click("[data-assess-point='0'] [data-add-note]"); // (a note can be written before the student has sent anything)
  await type("[data-note='0']", "Jälgi valgust");
  await wait(1500);
  expect(posted("/api/admin/protokoll")).toEqual([{ accessId: 4, protocolId: null, version: 0, titles: TITLES, notes: ["Jälgi valgust", "", ""], generalNote: "" }]);
});

test("'Saada hinnang' names the points without a verdict, then the Paranda points without a note; then, with no confirmation, it saves the notes, sends the version and the round, and the screen locks", async () => {
  action.sendAssessmentAction.mockResolvedValue({ kind: "sent", status: "fix", completed: false, version: 2, sentAt: SENT_AT });
  await render(student());
  await click("[data-assess-point='0'] [data-verdict='ok']");
  await click("[data-assess-point='1'] [data-verdict='fix']");
  await click("[data-assess-send]");
  expect($("[data-assess-error]")!.textContent).toBe("Vali hinnang ka punktidele: 3.");
  await click("[data-assess-point='2'] [data-verdict='ok']");
  await click("[data-assess-send]");
  expect($("[data-assess-error]")!.textContent).toBe("Lisa märkus Paranda-punktidele: 2.");
  expect(action.sendAssessmentAction).not.toHaveBeenCalled(); // both refusals were the screen's own
  await type("[data-note='1']", "Kuju on ebaühtlane");
  await click("[data-assess-send]");
  expect($("[data-assess-error]")).toBeNull();
  expect(posted("/api/admin/protokoll")).toEqual([{ accessId: 4, protocolId: 9, version: 1, titles: TITLES, notes: ["", "Kuju on ebaühtlane", ""], generalNote: "" }]);
  expect(action.sendAssessmentAction.mock.calls).toEqual([[{ accessId: 4, version: 2, protocolId: 9, round: 1 }]]);
  expect($("[data-assess-sent]")!.textContent).toBe("Hinnang saadetud. Paranda-punktid: 2.");
  expect([$("[data-assess-confirm-box]"), $("[data-confirm-panel]")]).toEqual([null, null]);
  expect($("[data-assess-status]")!.getAttribute("data-assess-status")).toBe("fix");
  // sent: read-only until "Muuda" (a correction of the same round, spec §8), the verdicts too
  expect($("[data-edit]")).not.toBeNull();
  expect(($("[data-note='1']") as HTMLTextAreaElement).readOnly).toBe(true);
  expect(allOff()).toBe(true);
  await click("[data-edit]");
  expect([allOff(), ($("[data-note='1']") as HTMLTextAreaElement).readOnly, $("[data-assess-send]")!.textContent]).toEqual([false, false, "Saada hinnang · 2 kinnitatud, 1 paranda"]);
});

test("an approving send locks the verdicts for good: 'Muuda' opens the notes only, and they go again with 'Saada uuesti'", async () => {
  action.sendAssessmentAction.mockResolvedValue({ kind: "sent", status: "passed", completed: true, version: 1, sentAt: SENT_AT });
  await render(student());
  for (const point of [0, 1, 2]) await click(`[data-assess-point='${point}'] [data-verdict='ok']`);
  expect($("[data-assess-send]")!.textContent).toBe("Saada hinnang · 3 kinnitatud");
  await click("[data-assess-send]");
  expect(action.sendAssessmentAction.mock.calls).toEqual([[{ accessId: 4, version: 1, protocolId: 9, round: 1 }]]);
  expect($("[data-assess-sent]")!.textContent).toBe("Hinnang saadetud. Koolitus on lõpetatud.");
  expect($("[data-assess-locked]")).not.toBeNull();
  await click("[data-edit]");
  expect(allOff()).toBe(true);
  expect($("[data-approve-all]")!.getAttribute("aria-disabled")).toBe("true"); // the verdicts are locked for good
  await click("[data-assess-point='0'] [data-add-note]");
  expect(($("[data-note='0']") as HTMLTextAreaElement).readOnly).toBe(false);
  expect($("[data-assess-send]")!.textContent).toBe("Saada uuesti");
  // the notes go again at once, no panel either
  action.sendAssessmentAction.mockResolvedValue({ kind: "sent", status: "passed", completed: false, version: 2, sentAt: SENT_AT });
  await type("[data-note='0']", "Tubli!");
  await click("[data-assess-send]");
  expect([$("[data-assess-confirm-box]"), $("[data-confirm-panel]")]).toEqual([null, null]);
  expect(action.sendAssessmentAction).toHaveBeenCalledTimes(2);
  expect($("[data-assess-sent]")!.textContent).toBe("Märkused saadetud.");
});

test("a tap that cannot be stored stops the send, and says so: nothing goes to the student", async () => {
  await render(student());
  verdictAnswer = () => Promise.reject(new TypeError("offline"));
  for (const point of [0, 1, 2]) await click(`[data-assess-point='${point}'] [data-verdict='ok']`);
  expect($$("[data-verdict-unsaved]")).toHaveLength(3);
  await click("[data-assess-send]");
  expect($("[data-assess-error]")!.textContent).toBe("Kõik hinnangud ei ole veel salvestatud. Proovi uuesti, kui ühendus on tagasi.");
  expect(action.sendAssessmentAction).not.toHaveBeenCalled();
});

test("'Saada hinnang' from a screen of an older round: the server sends nothing ('stale'); the screen reads the student's new round, shows it and says she sent one", async () => {
  action.sendAssessmentAction.mockResolvedValue({ kind: "stale", version: 1 });
  await render(student({ assessment: assessment({ verdicts: ["ok", "ok", "ok"] }) }));
  const reads = read.mock.calls.length;
  await click("[data-assess-send]");
  expect(action.sendAssessmentAction.mock.calls).toEqual([[{ accessId: 4, version: 1, protocolId: 9, round: 1 }]]);
  expect(read.mock.calls.length).toBe(reads + 1); // the send waits for the read
  const round2 = assessment({ round: 2, verdicts: ["ok", null, "ok"], photos: [[photo(11)], [photo(31, 2), photo(13)], [photo(14)]] });
  await answered(answer([student({ assessment: round2 })]));
  expect($("[data-assess-error]")!.textContent).toBe(NEW_ROUND);
  expect($("[data-assess-sent]")).toBeNull();
  expect(ids("[data-assess-point='1'] [data-latest-photos] [data-assess-photo]")).toEqual(["31"]);
  expect([pressed(0), pressed(1)]).toEqual([["true", "false"], ["false", "false"]]);
});

test("an e-course without points: the plain notes protocol, sent with 'Saada' as a contact course's — no verdicts, no confirmation", async () => {
  action.sendAssessmentAction.mockResolvedValue({ kind: "sent", status: "open", completed: false, version: 2, sentAt: SENT_AT });
  await render(student({ titles: [], notes: [], assessment: assessment({ status: "open", round: 0, submittedAt: null, verdicts: [], photos: [] }) }));
  expect([$("[data-assess-point]"), $("[data-verdict]"), $("[data-assess-status]")]).toEqual([null, null, null]);
  expect($("[data-assess-round]")!.textContent).toBe("Protokoll");
  expect($("[data-assess-send]")!.textContent).toBe("Saada");
  await click("[data-assess-send]");
  expect($("[data-assess-error]")!.textContent).toBe("Protokoll on tühi. Kirjuta midagi enne saatmist.");
  await type("[data-general]", "Tubli töö, jätka harjutamist.");
  await click("[data-assess-send]");
  expect([$("[data-assess-confirm-box]"), $("[data-confirm-panel]"), $("[data-approve-all]"), $("[data-assess-progress]")]).toEqual([null, null, null, null]); // (no points: no action bar)
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

// ---------- a screen left open "between other work" (final review I2): what it shows follows the server ----------

const TIMEOUT_LINE = "Vastust ei tulnud: kontrollin, kas protokoll saadeti. Juba saadetud protokolli teist korda ei saadeta.";
const ALL_OK: ("ok" | "fix" | null)[] = ["ok", "ok", "ok"];
/** „Saada hinnang · …“: one press sends (no confirmation). */
const send = async () => click("[data-assess-send]");
/** The window comes back (focus): the screen reads the server again, answered with `s`. */
const backToWindow = async (s: ScreenStudentView) => {
  await act(async () => void window.dispatchEvent(new Event("focus")));
  await answered(answer([s]));
};

test("the round line is the screen's: 'Praktiline töö, 1. kord', and a read that brings the student's new round says '2. kord'", async () => {
  await render(student());
  expect($("[data-assess-round]")!.textContent).toBe("Praktiline töö, 1. kord");
  await backToWindow(student({ assessment: assessment({ round: 2, photos: [[photo(41, 2), photo(11)], [photo(13)], [photo(14)]] }) }));
  expect($("[data-assess-round]")!.textContent).toBe("Praktiline töö, 2. kord");
  expect(ids("[data-assess-point='0'] [data-latest-photos] [data-assess-photo]")).toEqual(["41"]);
});

test("a send with no answer: 'Vastust ei tulnud …', the server read again; the read shows it sent — the line goes and the screen locks with the server's status", async () => {
  action.sendAssessmentAction.mockReturnValue(new Promise(() => {})); // never answered
  await render(student({ assessment: assessment({ verdicts: ALL_OK }) }));
  await send();
  expect(action.sendAssessmentAction.mock.calls).toEqual([[{ accessId: 4, version: 1, protocolId: 9, round: 1 }]]);
  const reads = read.mock.calls.length;
  await wait(30_000); // SEND_TIMEOUT_MS
  expect($("[data-assess-error]")!.textContent).toBe(TIMEOUT_LINE);
  expect(read.mock.calls.length).toBe(reads + 1);
  await answered(answer([student({ sentVersion: 1, sentAt: SENT_AT, assessment: assessment({ status: "passed", locked: true, verdicts: ALL_OK, sentVerdicts: ALL_OK }) })]));
  expect($("[data-assess-error]")).toBeNull();
  expect($("[data-assess-status]")!.getAttribute("data-assess-status")).toBe("passed");
  expect([$("[data-edit]") !== null, allOff(), ($("[data-general]") as HTMLTextAreaElement).readOnly]).toEqual([true, true, true]);
  expect(action.sendAssessmentAction).toHaveBeenCalledTimes(1);
});

test("a send with no answer that the read shows NOT sent: the line stays, the screen stays open, and a send again is Maria's", async () => {
  action.sendAssessmentAction.mockReturnValue(new Promise(() => {}));
  await render(student({ assessment: assessment({ verdicts: ALL_OK }) }));
  await send();
  await wait(30_000);
  await answered(answer([student({ assessment: assessment({ verdicts: ALL_OK }) })]));
  expect($("[data-assess-error]")!.textContent).toBe(TIMEOUT_LINE);
  expect($("[data-assess-status]")!.getAttribute("data-assess-status")).toBe("review");
  expect([$("[data-edit]"), allOff()]).toEqual([null, false]);
  expect($("[data-assess-send]")!.getAttribute("aria-disabled")).toBeNull();
});

test("'already' (sent from another device meanwhile): the screen reads the server again and takes its status — locked, not 'Ootab hindamist' with the boxes open", async () => {
  action.sendAssessmentAction.mockResolvedValue({ kind: "already", version: 1, sentAt: SENT_AT });
  await render(student({ assessment: assessment({ verdicts: ALL_OK }) }));
  const reads = read.mock.calls.length;
  await send();
  expect($("[data-assess-sent]")!.textContent).toBe("See hinnang on juba saadetud.");
  expect(read.mock.calls.length).toBe(reads + 1);
  await answered(answer([student({ sentVersion: 1, sentAt: SENT_AT, assessment: assessment({ status: "passed", locked: true, verdicts: ALL_OK, sentVerdicts: ALL_OK }) })]));
  expect($("[data-assess-status]")!.getAttribute("data-assess-status")).toBe("passed");
  expect([$("[data-edit]") !== null, allOff(), $("[data-assess-locked]") !== null]).toEqual([true, true, true]);
});

test("with no confirmation to close, a read that brings the student's new round updates the send's counts at once (her cleared 'Paranda' verdict is not counted); the next press names what is missing", async () => {
  await render(student({ assessment: assessment({ verdicts: ALL_OK }) }));
  expect($("[data-assess-send]")!.textContent).toBe("Saada hinnang · 3 kinnitatud");
  await backToWindow(student({ assessment: assessment({ round: 2, verdicts: ["ok", null, "ok"], photos: [[photo(11)], [photo(31, 2), photo(13)], [photo(14)]] }) }));
  expect($("[data-assess-send]")!.textContent).toBe("Saada hinnang · 2 kinnitatud");
  expect($("[data-assess-progress]")!.textContent).toBe("3 punkti · 2 hinnatud");
  expect(action.sendAssessmentAction).not.toHaveBeenCalled();
  // a press now names the verdict still missing, not the round before
  await click("[data-assess-send]");
  expect($("[data-assess-error]")!.textContent).toBe("Vali hinnang ka punktidele: 2.");
  expect(action.sendAssessmentAction).not.toHaveBeenCalled();
  // the new round's counts
  held = ["ok", null, "ok"]; // (the server's verdicts of round 2)
  await click("[data-assess-point='1'] [data-verdict='fix']");
  expect($("[data-assess-send]")!.textContent).toBe("Saada hinnang · 2 kinnitatud, 1 paranda");
});

test("after a stale send and the read of the student's new round, the next 'Saada hinnang' names round 2 (and so does its tap)", async () => {
  action.sendAssessmentAction
    .mockResolvedValueOnce({ kind: "stale", version: 1 })
    .mockResolvedValueOnce({ kind: "sent", status: "passed", completed: true, version: 1, sentAt: SENT_AT });
  await render(student({ assessment: assessment({ verdicts: ALL_OK }) }));
  await send();
  await answered(answer([student({ assessment: assessment({ round: 2, verdicts: ["ok", null, "ok"], photos: [[photo(11)], [photo(31, 2), photo(13)], [photo(14)]] }) })]));
  expect($("[data-assess-error]")!.textContent).toBe(NEW_ROUND);
  held = ["ok", null, "ok"]; // (the server's verdicts of round 2)
  await click("[data-assess-point='1'] [data-verdict='ok']");
  expect(posted("/api/admin/hinnang")).toEqual([{ accessId: 4, protocolId: 9, round: 2, stage: 1, verdict: "ok" }]);
  await send();
  expect(action.sendAssessmentAction.mock.calls).toEqual([
    [{ accessId: 4, version: 1, protocolId: 9, round: 1 }],
    [{ accessId: 4, version: 1, protocolId: 9, round: 2 }],
  ]);
  expect($("[data-assess-sent]")!.textContent).toBe("Hinnang saadetud. Koolitus on lõpetatud.");
});

test("the send's dock (fixed to the bottom on a phone) carries data-fab-avoid so the 💬 bubble lifts above it, and the screen's bottom padding is its measured height", async () => {
  await render(student());
  const dock = $("[data-assess-dock]")!;
  expect(dock.hasAttribute("data-fab-avoid")).toBe(true);
  expect(dock.contains($("[data-assess-send]"))).toBe(true);
  expect(($("[data-assessment-screen]") as HTMLElement).style.getPropertyValue("--dock-h")).toBe("0px"); // (a wide screen: the dock has no box of its own)
  // a phone: the dock has a box; a message inside it makes it taller, and the padding follows
  let height = 84.2;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = this.hasAttribute("data-assess-dock") ? height : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: h ? 360 : 0, bottom: h, width: h ? 360 : 0, height: h, toJSON: () => ({}) } as DOMRect;
  });
  await act(async () => void window.dispatchEvent(new Event("resize")));
  expect(($("[data-assessment-screen]") as HTMLElement).style.getPropertyValue("--dock-h")).toBe("85px");
  height = 120.6;
  await click("[data-assess-send]"); // the refusal's line comes into the dock
  expect($("[data-assess-dock]")!.contains($("[data-assess-error]"))).toBe(true);
  expect(($("[data-assessment-screen]") as HTMLElement).style.getPropertyValue("--dock-h")).toBe("121px");
});

test("wording: always „kord“, never „voor“ — nowhere in the admin's texts (README A4)", () => {
  expect(JSON.stringify(adminEt).match(/\bvoor\w*/gi) ?? []).toEqual([]);
  expect(adminEt.assessment.screen.errors.newRound).toBe(NEW_ROUND);
});
