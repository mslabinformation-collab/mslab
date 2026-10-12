import { describe, expect, test } from "vitest";
import {
  checkFeedback, checkStages, FEEDBACK_CHOICES, FEEDBACK_ORDER, FEEDBACK_TEXT_MAX, feedbackOpen, feedbackOpenFor, hasText, isChoice, newToSend, overLimit, PROTOCOL_LIMITS,
  protocolStatus, readStages, stagesFrom, summarizeFeedback,
} from "@/domain/protocols";
import { storable } from "@/lib/storable";
import { toStorable } from "@/lib/to-storable";

// The protocols' and the feedback form's pure rules (spec §3, §7, §10 unit): the status table, the headings and their limits, what a save
// may hold, the open rule at the Tallinn date's edges, and the answers' check.

describe("a protocol's status (spec §3)", () => {
  test("none without a row; a draft until it is sent; sent while the version is the sent one; changed after a saved edit", () => {
    expect(protocolStatus(null)).toBe("none");
    expect(protocolStatus({ sentAt: null, version: 3, sentVersion: null })).toBe("draft");
    expect(protocolStatus({ sentAt: new Date("2026-10-12T15:00:00Z"), version: 3, sentVersion: 3 })).toBe("sent");
    expect(protocolStatus({ sentAt: "2026-10-12T15:00:00.000Z", version: 4, sentVersion: 3 })).toBe("changed");
  });
});

describe("the stage headings (spec §3)", () => {
  test("the course editor's list: trimmed, blank rows dropped; more than 30, or one over 120 characters, refused", () => {
    expect(checkStages([" Ettevalmistus ", "", "  ", "Värvimine"])).toEqual({ ok: true, stages: ["Ettevalmistus", "Värvimine"] });
    expect(checkStages(Array.from({ length: 30 }, (_, i) => `Punkt ${i + 1}`))).toMatchObject({ ok: true });
    expect(checkStages(Array.from({ length: 31 }, (_, i) => `Punkt ${i + 1}`))).toEqual({ ok: false, error: "tooMany" });
    expect(checkStages(["x".repeat(120)])).toMatchObject({ ok: true });
    expect(checkStages(["x".repeat(121)])).toEqual({ ok: false, error: "tooLong" });
    expect(checkStages([`  ${"x".repeat(120)}  `])).toMatchObject({ ok: true }); // trimmed before it is measured
    expect(checkStages([])).toEqual({ ok: true, stages: [] });
  });

  test("as stored (jsonb: anything): strings only, trimmed, no blanks, at most 30 of at most 120 characters", () => {
    expect(readStages(["  Ettevalmistus ", 7, "", null, "Kulmude analüüs"])).toEqual(["Ettevalmistus", "Kulmude analüüs"]);
    expect(readStages(null)).toEqual([]);
    expect(readStages({ et: "x" })).toEqual([]);
    expect(readStages(Array.from({ length: 40 }, (_, i) => `P${i}`))).toHaveLength(PROTOCOL_LIMITS.stages);
    expect(readStages(["y".repeat(200)])).toEqual(["y".repeat(PROTOCOL_LIMITS.title)]);
  });

  test("a new protocol copies them, each with an empty note", () => {
    expect(stagesFrom(["Ettevalmistus", "Värvimine"])).toEqual([
      { title: "Ettevalmistus", note: "" },
      { title: "Värvimine", note: "" },
    ]);
  });
});

describe("what a protocol holds", () => {
  test("hasText: a note or the general notes, blank text does not count", () => {
    expect(hasText({ stages: [{ title: "A", note: "  \n " }], generalNote: " " })).toBe(false);
    expect(hasText({ stages: [{ title: "A", note: "hea" }], generalNote: "" })).toBe(true);
    expect(hasText({ stages: [], generalNote: "Üldiselt hästi" })).toBe(true);
  });

  test("overLimit names each box over 10 000 characters, the general notes as 'general'", () => {
    const long = "ä".repeat(PROTOCOL_LIMITS.note + 1);
    expect(overLimit(["ok", "x".repeat(PROTOCOL_LIMITS.note)], "")).toEqual([]);
    expect(overLimit(["ok", long, long], long)).toEqual([1, 2, "general"]);
  });

  test("'Lukusta ja saada kõik' takes what has text and is not sent as it is", () => {
    expect(newToSend("draft", true)).toBe(true);
    expect(newToSend("none", true)).toBe(true); // typed, its first save not answered yet
    expect(newToSend("changed", true)).toBe(true);
    expect(newToSend("sent", true)).toBe(false);
    for (const status of ["none", "draft", "changed", "sent"] as const) expect(newToSend(status, false)).toBe(false);
  });
});

describe("when the feedback form opens (spec §3), at the Tallinn date's edges", () => {
  const group = (startsAt: string, over: Partial<Parameters<typeof feedbackOpen>[0]> = {}) => ({
    status: "confirmed" as const,
    kind: "group" as const,
    session: { startsAt: new Date(startsAt), cancelled: false },
    protocolSentAt: null,
    ...over,
  });

  test("a group session that started before today (Tallinn) opens it; one that starts today does not, whatever the hour", () => {
    // 11.10.2026 23:30 in Tallinn (summer time, UTC+3)
    const late = "2026-10-11T20:30:00Z";
    expect(feedbackOpen(group(late), new Date("2026-10-11T20:50:00Z"))).toBe(false); // 23:50 the same evening
    expect(feedbackOpen(group(late), new Date("2026-10-11T21:10:00Z"))).toBe(true); // 00:10 on 12.10
    expect(feedbackOpen(group("2026-10-12T07:00:00Z"), new Date("2026-10-12T20:59:00Z"))).toBe(false); // the course day itself
    // winter time (UTC+2): 14.11 10:00, asked at 00:30 on 15.11
    expect(feedbackOpen(group("2026-11-14T08:00:00Z"), new Date("2026-11-14T22:30:00Z"))).toBe(true);
  });

  test("a sent protocol opens it at once, for an individual course too; a cancelled registration never; a called-off session not by its date", () => {
    const now = new Date("2026-10-12T12:00:00Z");
    expect(feedbackOpen({ status: "confirmed", kind: "individual", session: null, protocolSentAt: new Date("2026-10-12T11:00:00Z") }, now)).toBe(true);
    expect(feedbackOpen({ status: "awaiting_prepayment", kind: "individual", session: null, protocolSentAt: null }, now)).toBe(false);
    expect(feedbackOpen(group("2026-10-12T07:00:00Z", { protocolSentAt: new Date("2026-10-12T11:00:00Z") }), now)).toBe(true);
    expect(feedbackOpen(group("2026-10-01T07:00:00Z", { status: "cancelled" }), now)).toBe(false);
    expect(feedbackOpen(group("2026-10-01T07:00:00Z", { status: "cancelled", protocolSentAt: new Date() }), now)).toBe(false);
    expect(feedbackOpen(group("2026-10-01T07:00:00Z", { session: { startsAt: new Date("2026-10-01T07:00:00Z"), cancelled: true } }), now)).toBe(false);
    expect(feedbackOpen(group("2026-10-01T07:00:00Z", { kind: "individual" }), now)).toBe(false); // only a group opens by its date
  });

  test("feedbackOpenFor: the same rule from a row read with its session and protocol", () => {
    const now = new Date("2026-10-12T12:00:00Z");
    const row = { status: "confirmed" as const, kind: "group" as const, startsAt: new Date("2026-10-01T07:00:00Z"), sessionStatus: "scheduled", protocolSentAt: null };
    expect(feedbackOpenFor(row, now)).toBe(true);
    expect(feedbackOpenFor({ ...row, sessionStatus: "cancelled" }, now)).toBe(false);
    expect(feedbackOpenFor({ ...row, kind: "individual", startsAt: null, sessionStatus: null }, now)).toBe(false);
    expect(feedbackOpenFor({ ...row, kind: "individual", startsAt: null, sessionStatus: null, protocolSentAt: now }, now)).toBe(true);
  });
});

describe("the feedback answers (spec §7)", () => {
  test("the known keys, each of the right kind; null is not answered", () => {
    expect(checkFeedback({ score: 8, expectations: "met", message: "  Aitäh!  " })).toEqual({ ok: true, answers: { score: 8, expectations: "met", message: "Aitäh!" } });
    expect(checkFeedback({ score: null, clarity: "very_clear" })).toEqual({ ok: true, answers: { clarity: "very_clear" } });
    const all = { score: 10, expectations: "exceeded", clarity: "fairly_clear", balance: "more_practice", ready: "mostly", trainer: "excellent", safe: "very", materials: "rather_yes", recommend: "Jah", message: "Väga hea" };
    expect(checkFeedback(all)).toEqual({ ok: true, answers: all });
  });

  test("an unknown key, an out-of-range score, an unknown option, a text too long or not storable: the key that is wrong", () => {
    expect(checkFeedback({ score: 8, extra: "x" })).toEqual({ ok: false, error: "answers" });
    for (const score of [0, 11, 7.5, "8", true]) expect(checkFeedback({ score })).toEqual({ ok: false, error: "score" });
    expect(checkFeedback({ expectations: "met", clarity: "nope" })).toEqual({ ok: false, error: "clarity" });
    expect(checkFeedback({ ready: 3 })).toEqual({ ok: false, error: "ready" });
    expect(checkFeedback({ message: "x".repeat(FEEDBACK_TEXT_MAX) })).toMatchObject({ ok: true });
    expect(checkFeedback({ message: "x".repeat(FEEDBACK_TEXT_MAX + 1) })).toEqual({ ok: false, error: "message" });
    expect(checkFeedback({ recommend: "nul\u0000" })).toEqual({ ok: false, error: "recommend" });
    expect(checkFeedback({ recommend: 5 })).toEqual({ ok: false, error: "recommend" });
  });

  test("nothing answered is an empty submit; anything that is not an object is no answers", () => {
    for (const empty of [{}, { message: "   " }, { score: null, recommend: "" }]) expect(checkFeedback(empty)).toEqual({ ok: false, error: "empty" });
    for (const bad of [null, undefined, [], "x", 8]) expect(checkFeedback(bad)).toEqual({ ok: false, error: "answers" });
  });

  test("the paper form's order and options; isChoice names the seven choice questions only", () => {
    expect(FEEDBACK_ORDER.filter(isChoice)).toEqual(["expectations", "clarity", "balance", "ready", "trainer", "safe", "materials"]);
    expect(["constructor", "__proto__", "score", "message"].some(isChoice)).toBe(false);
    expect(FEEDBACK_ORDER).toEqual(["score", "expectations", "clarity", "balance", "ready", "trainer", "safe", "materials", "recommend", "message"]);
    expect(FEEDBACK_CHOICES).toEqual({
      expectations: ["exceeded", "met", "not_met"],
      clarity: ["very_clear", "fairly_clear", "needs_work"],
      balance: ["ideal", "more_practice", "more_theory"],
      ready: ["fully", "mostly", "rather_not", "no"],
      trainer: ["excellent", "good", "satisfactory", "needs_growth"],
      safe: ["very", "rather_yes", "rather_not"],
      materials: ["yes", "rather_yes", "rather_not", "no"],
    });
  });

  test("summarizeFeedback: how many, the average score of those that gave one (one decimal), and every option's count", () => {
    const s = summarizeFeedback([{ score: 9, expectations: "exceeded" }, { score: 8, expectations: "met", safe: "very" }, { message: "hea" }]);
    expect([s.count, s.scored, s.average]).toEqual([3, 2, 8.5]);
    expect(s.options.expectations).toEqual({ exceeded: 1, met: 1, not_met: 0 });
    expect(s.options.safe).toEqual({ very: 1, rather_yes: 0, rather_not: 0 });
    expect(summarizeFeedback([{ message: "x" }]).average).toBeNull();
    expect(summarizeFeedback([{ score: 7 }, { score: 8 }, { score: 8 }]).average).toBe(7.7);
  });
});

describe("toStorable", () => {
  test("drops the control characters and lone surrogates Postgres refuses, keeps the words, tabs and line breaks", () => {
    const pasted = "Kulmud\u000bhästi\u0000\tjah\r\nlõpp\ud800";
    expect(storable(pasted)).toBe(false);
    expect(toStorable(pasted)).toBe("Kulmudhästi\tjah\r\nlõpp");
    expect(storable(toStorable(pasted))).toBe(true);
    expect(toStorable("Привет 👋")).toBe("Привет 👋");
  });

  test("storable.ts's rule, character by character: what storable refuses toStorable drops, and nothing else", () => {
    for (let c = 0; c <= 0x7f; c++) {
      const s = `a${String.fromCharCode(c)}b`;
      expect(toStorable(s) === s, `U+${c.toString(16)}`).toBe(storable(s));
    }
    for (const s of ["👋", "\ud800", "\udc00", "\udc00\ud800", "a\ud800b\udc00c", "\ud83d👋"]) expect(toStorable(s) === s, JSON.stringify(s)).toBe(storable(s));
    expect(toStorable("\ud83d👋")).toBe("👋"); // a lone high surrogate before a pair: only it goes
  });
});
