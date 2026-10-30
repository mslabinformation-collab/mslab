import { describe, expect, test } from "vitest";
import {
  NOTE_MAX, answerOf, appliesAt, checkState, cleanNote, markPinged, mergeAnswers, ownFaults, pingsFor, planCounts, readAnswersDoc, sharedState, stateIn, testerOf,
  type AnswersDoc, type IncomingAnswer, type Ping, type Status, type StoredAnswer, type TestItem, type TestPlan,
} from "@/domain/testplan";

// The test page's pure rules (phase 4, piece 1, spec §2 D4–D6, D10, §5–§7): a check's state against its answer and its mark, the note, the
// merge of a save into the stored answers, the Telegram pings a save earns, the session-to-tester match and the counts. No database.

const MARKED = "2026-10-16T00:00:00.000Z";
const BUILD = "2026-10-22T08:00:00.000Z";

const base: TestItem = {
  id: "a-one", area: "avalik", who: "maria", device: "telefon", title: "Üks", steps: ["Tee seda."], expect: ["Näed seda."], why: "Sest.", risk: "med", writes: false,
};
const item = (over: Partial<TestItem> = {}): TestItem => ({ ...base, ...over });

/** Three checks, one per tester: Maria's (never marked), Dim's and the shared one (both redo, the shared one on the plan-wide mark). */
const PLAN: TestPlan = {
  version: 1,
  marked: MARKED,
  areas: [{ id: "avalik", name: "Avalik leht" }],
  items: [
    item({ id: "maria-1", who: "maria" }),
    item({ id: "dim-1", who: "dim", mark: "redo", markedAt: "2026-10-20T00:00:00.000Z" }),
    item({ id: "koos-1", who: "koos", mark: "redo" }),
  ],
};

const answer = (status: Status, at: string, over: Partial<StoredAnswer> = {}): StoredAnswer => ({ status, note: "", at, by: "a@x.test", ...over });
const doc = (answers: Record<string, StoredAnswer> = {}): AnswersDoc => ({ v: 1, answers });
const inc = (status: Status, note = ""): IncomingAnswer => ({ status, note });
/** The incoming "clear" (Dim 29.10): a save takes the check's answer back. */
const clear = (): IncomingAnswer => ({ status: "clear", note: "" });

describe("appliesAt: the instant a redo is judged by", () => {
  const CASES: { name: string; item: TestItem; expected: string | null }[] = [
    { name: "no mark", item: item(), expected: null },
    { name: "reworded: only a redo has an instant", item: item({ mark: "reworded", markedAt: "2026-10-20T00:00:00.000Z" }), expected: null },
    { name: "new: only a redo has an instant", item: item({ mark: "new" }), expected: null },
    { name: "redo with its own markedAt", item: item({ mark: "redo", markedAt: "2026-10-20T09:00:00.000Z" }), expected: "2026-10-20T09:00:00.000Z" },
    { name: "redo without markedAt: the plan's marked", item: item({ mark: "redo" }), expected: MARKED },
    { name: "redo marked \"deploy\": the build instant", item: item({ mark: "redo", markedAt: "deploy" }), expected: BUILD },
  ];
  test.each(CASES)("$name", ({ item: it, expected }) => {
    expect(appliesAt(it, PLAN, BUILD)).toBe(expected);
  });
});

describe("checkState: open, done or failed (spec §4)", () => {
  const redo20 = item({ mark: "redo", markedAt: "2026-10-20T00:00:00.000Z" });
  const CASES: { name: string; item: TestItem; answer: StoredAnswer | undefined; state: "open" | "done" | "failed"; overtaken: boolean }[] = [
    { name: "no answer: open", item: item(), answer: undefined, state: "open", overtaken: false },
    { name: "ok: done", item: item(), answer: answer("ok", "2026-10-17T10:00:00.000Z"), state: "done", overtaken: false },
    // admin UX pass piece 4c (Dim 29.10, Q2): „Jäta vahele“ has no button any more, and one stored before is open again, its answer kept
    { name: "skip: open, its answer kept (Dim 29.10)", item: item(), answer: answer("skip", "2026-10-17T10:00:00.000Z"), state: "open", overtaken: false },
    { name: "redo marked 20.10, skipped 19.10: open, the skip overtaken", item: redo20, answer: answer("skip", "2026-10-19T10:00:00.000Z"), state: "open", overtaken: true },
    { name: "bad: failed", item: item(), answer: answer("bad", "2026-10-17T10:00:00.000Z"), state: "failed", overtaken: false },
    { name: "redo marked 20.10, answered ok 19.10: open, the old answer overtaken", item: redo20, answer: answer("ok", "2026-10-19T10:00:00.000Z"), state: "open", overtaken: true },
    { name: "redo marked 20.10, answered bad 19.10: open, the old failure overtaken", item: redo20, answer: answer("bad", "2026-10-19T10:00:00.000Z"), state: "open", overtaken: true },
    { name: "redo marked 20.10, answered ok 21.10: done", item: redo20, answer: answer("ok", "2026-10-21T10:00:00.000Z"), state: "done", overtaken: false },
    { name: "redo marked 20.10, answered bad 21.10: failed", item: redo20, answer: answer("bad", "2026-10-21T10:00:00.000Z"), state: "failed", overtaken: false },
    { name: "redo, answered at the very instant of the mark: still valid (only an earlier answer is overtaken)", item: redo20, answer: answer("ok", "2026-10-20T00:00:00.000Z"), state: "done", overtaken: false },
    { name: "redo without markedAt, answered before the plan's marked: open", item: item({ mark: "redo" }), answer: answer("ok", "2026-10-15T23:59:59.000Z"), state: "open", overtaken: true },
    { name: "redo without markedAt, answered after the plan's marked: done", item: item({ mark: "redo" }), answer: answer("ok", "2026-10-16T00:00:01.000Z"), state: "done", overtaken: false },
    { name: "redo marked \"deploy\", build 22.10, answered 21.10: open", item: item({ mark: "redo", markedAt: "deploy" }), answer: answer("ok", "2026-10-21T10:00:00.000Z"), state: "open", overtaken: true },
    { name: "redo marked \"deploy\", build 22.10, answered 23.10: done", item: item({ mark: "redo", markedAt: "deploy" }), answer: answer("ok", "2026-10-23T10:00:00.000Z"), state: "done", overtaken: false },
    { name: "reworded never reopens an answer", item: item({ mark: "reworded", markedAt: "2026-10-20T00:00:00.000Z" }), answer: answer("ok", "2026-10-01T00:00:00.000Z"), state: "done", overtaken: false },
    { name: "new never reopens an answer", item: item({ mark: "new", markedAt: "2026-10-20T00:00:00.000Z" }), answer: answer("bad", "2026-10-01T00:00:00.000Z"), state: "failed", overtaken: false },
    { name: "the same instants written with and without milliseconds compare as instants, not as text", item: item({ mark: "redo", markedAt: "2026-10-20T09:00:00Z" }), answer: answer("ok", "2026-10-20T09:00:00.000Z"), state: "done", overtaken: false },
  ];
  test.each(CASES)("$name", ({ item: it, answer: a, state, overtaken }) => {
    const got = checkState(it, a, PLAN, BUILD);
    expect(got.state).toBe(state);
    expect(got.overtaken).toEqual(overtaken ? a : null);
    // an overtaken answer is no longer the check's answer: it is shown under "Varasem vastus", not as the last one; a skip that stands stays the
    // check's answer though the check is open (its last line and its note are shown)
    expect(got.answer).toEqual(overtaken || a === undefined ? null : a);
  });
});

// Admin polish Part A (Dim 29.10: „Automaattest counts for us“, reversing D10's "never counts" of 25.10): the state of a check on Maria's and Dim's
// page is a person's answer while it stands, else Automaattest's (its OK done, its Viga failed, its Jäta vahele open); an answer a redo has overtaken
// counts for neither. `answer` and `overtaken` stay the person's: the two halves, the note box and the last line are a person's only.
describe("sharedState: a person's answer, else Automaattest's (Dim 29.10)", () => {
  const redo20 = item({ mark: "redo", markedAt: "2026-10-20T00:00:00.000Z" });
  const P = (status: Status, at = "2026-10-21T10:00:00.000Z") => answer(status, at, { by: "m@x.test" });
  const A = (status: Status, at = "2026-10-21T11:00:00.000Z") => answer(status, at, { by: "auto@x.test" });
  const CASES: { name: string; it?: TestItem; person?: StoredAnswer; auto?: StoredAnswer; state: "open" | "done" | "failed"; answer: "person" | null; overtaken: boolean }[] = [
    { name: "nobody answered: open", state: "open", answer: null, overtaken: false },
    { name: "a person's OK: done", person: P("ok"), state: "done", answer: "person", overtaken: false },
    { name: "a person's Viga: failed", person: P("bad"), state: "failed", answer: "person", overtaken: false },
    { name: "Automaattest's OK alone: done, with no person's answer", auto: A("ok"), state: "done", answer: null, overtaken: false },
    { name: "Automaattest's Viga alone: failed", auto: A("bad"), state: "failed", answer: null, overtaken: false },
    { name: "Automaattest's Jäta vahele alone: open", auto: A("skip"), state: "open", answer: null, overtaken: false },
    { name: "a person's OK wins over Automaattest's Viga", person: P("ok"), auto: A("bad"), state: "done", answer: "person", overtaken: false },
    { name: "a person's Viga wins over Automaattest's OK", person: P("bad"), auto: A("ok"), state: "failed", answer: "person", overtaken: false },
    { name: "a person's Jäta vahele (stored before the button went) wins too: open", person: P("skip"), auto: A("ok"), state: "open", answer: "person", overtaken: false },
    { name: "redo 20.10, a person's OK of 19.10 overtaken, Automaattest's OK of 21.10: done (its), the person's under „Varasem vastus“", it: redo20, person: P("ok", "2026-10-19T10:00:00.000Z"), auto: A("ok"), state: "done", answer: null, overtaken: true },
    { name: "redo 20.10, Automaattest's OK of 19.10 overtaken: open", it: redo20, auto: A("ok", "2026-10-19T10:00:00.000Z"), state: "open", answer: null, overtaken: false },
    { name: "redo 20.10, both of 19.10 overtaken: open, the person's under „Varasem vastus“", it: redo20, person: P("bad", "2026-10-19T10:00:00.000Z"), auto: A("ok", "2026-10-19T11:00:00.000Z"), state: "open", answer: null, overtaken: true },
  ];
  test.each(CASES)("$name", ({ it = item(), person, auto, state, answer: from, overtaken }) => {
    const got = sharedState(it, person, auto, PLAN, BUILD);
    expect(got.state).toBe(state);
    expect(got.answer).toEqual(from === "person" ? person : null);
    expect(got.overtaken).toEqual(overtaken ? person : null);
  });

  // review Minor 8: the page and the counts read a doc through one helper
  test("stateIn reads a check of a doc: its person's answer in `answers`, Automaattest's in `auto`; a doc without `auto` is checkState of `answers`", () => {
    const it = PLAN.items[0];
    const withBoth: AnswersDoc = { v: 1, answers: { "maria-1": P("bad") }, auto: { "maria-1": A("ok") } };
    expect(stateIn(withBoth, it, PLAN, BUILD)).toEqual(sharedState(it, P("bad"), A("ok"), PLAN, BUILD));
    expect(stateIn({ v: 1, answers: {}, auto: { "maria-1": A("ok") } }, it, PLAN, BUILD).state).toBe("done");
    expect(stateIn(doc({ "maria-1": P("ok") }), it, PLAN, BUILD)).toEqual(checkState(it, P("ok"), PLAN, BUILD));
    expect(stateIn(doc(), it, PLAN, BUILD)).toEqual({ state: "open", answer: null, overtaken: null });
  });

  test("with no Automaattest answer it is checkState itself", () => {
    for (const a of [undefined, P("ok"), P("bad"), P("skip"), P("ok", "2026-10-19T10:00:00.000Z")]) {
      const it = item({ mark: "redo", markedAt: "2026-10-20T00:00:00.000Z" });
      expect(sharedState(it, a, undefined, PLAN, BUILD)).toEqual(checkState(it, a, PLAN, BUILD));
    }
  });
});

describe("cleanNote", () => {
  test.each([
    { name: "only white space", raw: "   \n\t ", expected: "" },
    { name: "trimmed", raw: " a ", expected: "a" },
    { name: "inner white space kept", raw: "  a  b\nc ", expected: "a  b\nc" },
    { name: "not a string", raw: 5, expected: "" },
    { name: "null", raw: null, expected: "" },
    { name: "undefined", raw: undefined, expected: "" },
    { name: "an object", raw: { toString: () => "x" }, expected: "" },
  ])("$name", ({ raw, expected }) => {
    expect(cleanNote(raw)).toBe(expected);
  });

  test("cut at NOTE_MAX code points, not UTF-16 units: 1001 emoji → 1000 emoji", () => {
    expect(NOTE_MAX).toBe(1000);
    const cut = cleanNote("😀".repeat(1001));
    expect(Array.from(cut)).toHaveLength(1000);
    expect(cut).toBe("😀".repeat(1000));
  });

  test("exactly NOTE_MAX is kept whole; the limit counts after trimming", () => {
    expect(cleanNote("a".repeat(1000))).toBe("a".repeat(1000));
    expect(cleanNote(`  ${"a".repeat(1000)}  `)).toBe("a".repeat(1000));
  });

  test("idempotent: a cut that ends in white space does not leave it behind", () => {
    const once = cleanNote(`${"a".repeat(999)}   b`);
    expect(once).toBe("a".repeat(999));
    expect(cleanNote(once)).toBe(once);
  });
});

describe("readAnswersDoc: a stored value of any shape → a valid doc", () => {
  const good = { status: "ok", note: "n", at: "2026-10-17T10:00:00.000Z", by: "a@x.test" };
  test.each([
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "a string", value: "x" },
    { name: "a number", value: 5 },
    { name: "an array", value: [good] },
    { name: "an empty object", value: {} },
    { name: "another version", value: { v: 2, answers: { "a-one": good } } },
    { name: "answers not an object", value: { v: 1, answers: [good] } },
    { name: "answers missing", value: { v: 1 } },
  ])("$name → an empty doc", ({ value }) => {
    expect(readAnswersDoc(value)).toEqual({ v: 1, answers: {} });
  });

  test("good entries are kept as they are; bad entries are dropped one by one", () => {
    const value = {
      v: 1,
      answers: {
        "a-one": { ...good, pinged: "2026-10-17T10:00:01.000Z", notePinged: true },
        "a-two": { ...good, status: "maybe" }, // not a status
        "a-three": { ...good, at: "yesterday" }, // not an instant
        "a-four": { ...good, at: 5 },
        "a-five": null,
        "a-six": "ok",
        "a-seven": { ...good, status: "bad" },
      },
    };
    expect(readAnswersDoc(value)).toEqual({
      v: 1,
      answers: {
        "a-one": { ...good, pinged: "2026-10-17T10:00:01.000Z", notePinged: true },
        "a-seven": { ...good, status: "bad" },
      },
    });
  });

  test("a damaged field is repaired, not fatal: the note is cleaned, a missing 'by' is '', a bad 'pinged' or 'notePinged' is left out", () => {
    const value = { v: 1, answers: { "a-one": { status: "bad", note: `  ${"x".repeat(1200)}  `, at: "2026-10-17T10:00:00.000Z", pinged: "soon", notePinged: "yes" } } };
    const got = readAnswersDoc(value).answers["a-one"];
    expect(got).toEqual({ status: "bad", note: "x".repeat(1000), at: "2026-10-17T10:00:00.000Z", by: "" });
    expect(readAnswersDoc({ v: 1, answers: { "a-one": { ...good, note: 5 } } }).answers["a-one"].note).toBe("");
  });

  test("an id called __proto__ is an ordinary key, it does not change the object's prototype", () => {
    const value = JSON.parse(`{"v":1,"answers":{"__proto__":${JSON.stringify(good)}}}`);
    const got = readAnswersDoc(value);
    expect(Object.getPrototypeOf(got.answers)).toBe(Object.prototype);
    expect(Object.keys(got.answers)).toEqual(["__proto__"]);
  });

  test("returns a copy: editing the result does not touch the stored value", () => {
    const value = { v: 1, answers: { "a-one": { ...good } } };
    const got = readAnswersDoc(value);
    got.answers["a-one"].note = "changed";
    expect(value.answers["a-one"].note).toBe("n");
  });
});

describe("mergeAnswers (spec D4, §5)", () => {
  const NOW = new Date("2026-10-17T10:00:00.000Z");

  test("an id that is not in the plan is ignored; the others are written", () => {
    const { doc: merged, changed } = mergeAnswers(doc(), { ghost: inc("ok"), "maria-1": inc("ok", "hea") }, PLAN, "m@x.test", NOW, BUILD);
    expect(changed).toEqual(["maria-1"]);
    expect(Object.keys(merged.answers)).toEqual(["maria-1"]);
    expect(merged.answers["maria-1"]).toEqual({ status: "ok", note: "hea", at: NOW.toISOString(), by: "m@x.test" });
  });

  test("`by` comes from the argument, never from the incoming object; `at` is the server's `now`, never the device's", () => {
    const sneaky = { status: "ok", note: "", by: "evil@x.test", at: "2020-01-01T00:00:00.000Z", clientAt: "2020-01-01T00:00:00.000Z", pinged: "2020-01-01T00:00:00.000Z" } as unknown as IncomingAnswer;
    const { doc: merged } = mergeAnswers(doc(), { "maria-1": sneaky }, PLAN, "m@x.test", NOW, BUILD);
    expect(merged.answers["maria-1"]).toEqual({ status: "ok", note: "", at: NOW.toISOString(), by: "m@x.test" });
  });

  test("the note is cleaned: trimmed, white space is no note, cut at 1000", () => {
    const { doc: merged } = mergeAnswers(doc(), { "maria-1": inc("bad", "  a  "), "dim-1": inc("bad", "   "), "koos-1": inc("bad", "😀".repeat(1001)) }, PLAN, "m@x.test", NOW, BUILD);
    expect(merged.answers["maria-1"].note).toBe("a");
    expect(merged.answers["dim-1"].note).toBe("");
    expect(Array.from(merged.answers["koos-1"].note)).toHaveLength(1000);
  });

  test("an entry with a status that is none of ok / bad / skip is ignored", () => {
    const wrong = { status: "maybe", note: "" } as unknown as IncomingAnswer;
    const { doc: merged, changed } = mergeAnswers(doc(), { "maria-1": wrong, "dim-1": inc("skip") }, PLAN, "m@x.test", NOW, BUILD);
    expect(changed).toEqual(["dim-1"]);
    expect(Object.keys(merged.answers)).toEqual(["dim-1"]);
  });

  test("a stored answer to an id outside the plan survives a merge untouched; so do the other checks' answers", () => {
    const stored = doc({ gone: answer("bad", "2026-09-01T00:00:00.000Z", { note: "vana", pinged: "2026-09-01T00:00:01.000Z" }), "dim-1": answer("ok", "2026-10-16T12:00:00.000Z", { by: "d@x.test" }) });
    const { doc: merged, changed } = mergeAnswers(stored, { "maria-1": inc("ok") }, PLAN, "m@x.test", NOW, BUILD);
    expect(changed).toEqual(["maria-1"]);
    expect(merged.answers.gone).toEqual(stored.answers.gone);
    expect(merged.answers["dim-1"]).toEqual(stored.answers["dim-1"]);
  });

  test("two merges in sequence keep both ids; the stored doc is not edited in place", () => {
    const first = mergeAnswers(doc(), { "maria-1": inc("ok") }, PLAN, "m@x.test", NOW, BUILD);
    const frozen = JSON.stringify(first.doc);
    const second = mergeAnswers(first.doc, { "dim-1": inc("bad", "viga") }, PLAN, "d@x.test", new Date("2026-10-17T11:00:00.000Z"), BUILD);
    expect(Object.keys(second.doc.answers).sort()).toEqual(["dim-1", "maria-1"]);
    expect(second.doc.answers["maria-1"].by).toBe("m@x.test");
    expect(second.doc.answers["dim-1"].by).toBe("d@x.test");
    expect(JSON.stringify(first.doc)).toBe(frozen);
  });

  test("the same id answered again replaces the answer: the later press wins", () => {
    const first = mergeAnswers(doc(), { "maria-1": inc("ok") }, PLAN, "m@x.test", NOW, BUILD);
    const second = mergeAnswers(first.doc, { "maria-1": inc("skip", "hiljem") }, PLAN, "d@x.test", new Date("2026-10-17T11:00:00.000Z"), BUILD);
    expect(second.doc.answers["maria-1"]).toEqual({ status: "skip", note: "hiljem", at: "2026-10-17T11:00:00.000Z", by: "d@x.test" });
  });

  test("nothing incoming: nothing changed", () => {
    const stored = doc({ "maria-1": answer("ok", "2026-10-16T12:00:00.000Z") });
    const got = mergeAnswers(stored, {}, PLAN, "m@x.test", NOW, BUILD);
    expect(got.changed).toEqual([]);
    expect(got.doc).toEqual(stored);
  });

  // Dim 29.10: a save can take an answer back. The incoming status "clear" removes the check's stored answer, with its note and ping records.
  describe("a clear takes an answer back (Dim 29.10)", () => {
    const stored = doc({
      "maria-1": answer("bad", "2026-10-16T12:00:00.000Z", { note: "katki", pinged: "2026-10-16T12:00:01.000Z", notePinged: true }),
      "dim-1": answer("ok", "2026-10-16T13:00:00.000Z", { by: "d@x.test" }),
    });

    test("removes that check's answer, the note and the ping records with it; the other answers stay as they were; the stored doc is not edited", () => {
      const frozen = JSON.stringify(stored);
      const { doc: merged, changed } = mergeAnswers(stored, { "maria-1": clear() }, PLAN, "m@x.test", NOW, BUILD);
      expect(merged).toEqual(doc({ "dim-1": stored.answers["dim-1"] }));
      expect(changed).toEqual(["maria-1"]);
      expect(JSON.stringify(stored)).toBe(frozen);
    });

    test("ignores whatever note it carries: a clear is not an answer with a note", () => {
      const { doc: merged } = mergeAnswers(stored, { "maria-1": { status: "clear", note: "ei loe" } }, PLAN, "m@x.test", NOW, BUILD);
      expect(Object.keys(merged.answers)).toEqual(["dim-1"]);
    });

    test("a clear of a check with no answer, or of an id outside the plan, is a no-op: nothing removed, nothing changed", () => {
      const got = mergeAnswers(stored, { "koos-1": clear(), ghost: clear() }, PLAN, "m@x.test", NOW, BUILD);
      expect(got.changed).toEqual([]);
      expect(got.doc).toEqual(stored);
      // (an answer stored for an id the plan no longer has is not the save's to remove)
      const old = doc({ ghost: answer("bad", "2026-09-01T00:00:00.000Z", { note: "vana" }) });
      expect(mergeAnswers(old, { ghost: clear() }, PLAN, "m@x.test", NOW, BUILD).doc).toEqual(old);
    });

    test("one save may carry presses and clears: each id is taken as sent", () => {
      const { doc: merged, changed } = mergeAnswers(stored, { "maria-1": clear(), "koos-1": inc("skip", "hiljem"), "dim-1": clear() }, PLAN, "m@x.test", NOW, BUILD);
      expect(changed).toEqual(["maria-1", "koos-1", "dim-1"]);
      expect(merged).toEqual(doc({ "koos-1": { status: "skip", note: "hiljem", at: NOW.toISOString(), by: "m@x.test" } }));
    });

    test("a doc that holds nothing left after it is an empty map, and a doc without `auto` gets none", () => {
      const only = doc({ "maria-1": answer("ok", "2026-10-16T12:00:00.000Z") });
      const merged = mergeAnswers(only, { "maria-1": clear() }, PLAN, "m@x.test", NOW, BUILD).doc;
      expect(merged).toEqual({ v: 1, answers: {} });
      expect(Object.keys(merged)).toEqual(["v", "answers"]);
    });

    test("earns no Telegram message, whatever was cleared: a Viga, with its note, or an OK", () => {
      for (const id of ["maria-1", "dim-1"]) {
        const merged = mergeAnswers(stored, { [id]: clear() }, PLAN, "m@x.test", NOW, BUILD);
        expect(pingsFor(stored, merged.doc, merged.changed, PLAN, BUILD), id).toEqual([]);
      }
    });

    test("a Viga cleared and then pressed again is a new answer: it earns its first message again, with no memory of the cleared one", () => {
      const first = new Date("2026-10-17T10:00:00.000Z");
      const bad1 = mergeAnswers(doc(), { "maria-1": inc("bad", "katki") }, PLAN, "m@x.test", first, BUILD);
      const pings1 = pingsFor(doc(), bad1.doc, bad1.changed, PLAN, BUILD);
      expect(pings1).toEqual([{ id: "maria-1", kind: "bad" }]);
      const sent1 = markPinged(bad1.doc, pings1, first);

      const cleared = mergeAnswers(sent1, { "maria-1": clear() }, PLAN, "m@x.test", new Date("2026-10-17T10:05:00.000Z"), BUILD);
      expect(pingsFor(sent1, cleared.doc, cleared.changed, PLAN, BUILD)).toEqual([]);
      expect(cleared.doc.answers).toEqual({});

      const later = new Date("2026-10-17T10:10:00.000Z");
      const bad2 = mergeAnswers(cleared.doc, { "maria-1": inc("bad", "katki") }, PLAN, "m@x.test", later, BUILD);
      expect(bad2.doc.answers["maria-1"]).toEqual({ status: "bad", note: "katki", at: later.toISOString(), by: "m@x.test" }); // (no `pinged`, no `notePinged` carried)
      expect(pingsFor(cleared.doc, bad2.doc, bad2.changed, PLAN, BUILD)).toEqual([{ id: "maria-1", kind: "bad" }]);
    });
  });

  test("`buildAt` is required: a call without it does not compile (a forgotten build instant must not turn into a message on every save)", () => {
    // @ts-expect-error the sixth argument, the build instant a "deploy" mark reads as, has no default
    const withoutBuildAt = () => mergeAnswers(doc(), {}, PLAN, "m@x.test", NOW);
    expect(typeof withoutBuildAt).toBe("function"); // (never called: `tsc --noEmit` is the check)
  });
});

describe("the pings a save earns: pingsFor and markPinged (spec D6)", () => {
  /** One save, as the route runs it: merge, find the pings, and (the sends having worked) record them. */
  function save(stored: AnswersDoc, id: string, status: Status, note: string, at: string): { doc: AnswersDoc; pings: Ping[]; recorded: AnswersDoc } {
    const now = new Date(at);
    const merged = mergeAnswers(stored, { [id]: inc(status, note) }, PLAN, "m@x.test", now, BUILD);
    const pings = pingsFor(stored, merged.doc, merged.changed, PLAN, BUILD);
    return { doc: merged.doc, pings, recorded: markPinged(merged.doc, pings, now) };
  }

  test("the sequence: bad → note → no more; ok then bad again → a new failure", () => {
    // 1. a Viga without a note: the first message
    const s1 = save(doc(), "maria-1", "bad", "", "2026-10-17T10:00:00.000Z");
    expect(s1.pings).toEqual([{ id: "maria-1", kind: "bad" }]);
    expect(s1.recorded.answers["maria-1"].pinged).toBe("2026-10-17T10:00:00.000Z");
    expect(s1.recorded.answers["maria-1"].notePinged).toBeUndefined();

    // 2. the same failure gets its first note: the second message, once
    const s2 = save(s1.recorded, "maria-1", "bad", "nupp on katki", "2026-10-17T10:05:00.000Z");
    expect(s2.pings).toEqual([{ id: "maria-1", kind: "note" }]);
    expect(s2.recorded.answers["maria-1"].pinged).toBe("2026-10-17T10:00:00.000Z"); // the first message's instant is kept
    expect(s2.recorded.answers["maria-1"].notePinged).toBe(true);

    // 3. another note on the same failure: nothing more
    const s3 = save(s2.recorded, "maria-1", "bad", "nupp on ikka katki, ka tahvlis", "2026-10-17T10:10:00.000Z");
    expect(s3.pings).toEqual([]);
    expect(s3.recorded.answers["maria-1"].pinged).toBe("2026-10-17T10:00:00.000Z");
    expect(s3.recorded.answers["maria-1"].notePinged).toBe(true);

    // 4. answered OK, then Viga again: a new failure with its own messages
    const s4a = save(s3.recorded, "maria-1", "ok", "", "2026-10-17T11:00:00.000Z");
    expect(s4a.pings).toEqual([]);
    expect(s4a.doc.answers["maria-1"].pinged).toBeUndefined();
    expect(s4a.doc.answers["maria-1"].notePinged).toBeUndefined();
    const s4b = save(s4a.recorded, "maria-1", "bad", "", "2026-10-17T12:00:00.000Z");
    expect(s4b.pings).toEqual([{ id: "maria-1", kind: "bad" }]);
    expect(s4b.recorded.answers["maria-1"].pinged).toBe("2026-10-17T12:00:00.000Z");
  });

  test("the same failure saved again with the same note, or with no note, sends nothing", () => {
    const s1 = save(doc(), "maria-1", "bad", "katki", "2026-10-17T10:00:00.000Z");
    expect(s1.pings).toEqual([{ id: "maria-1", kind: "bad" }]);
    const again = save(s1.recorded, "maria-1", "bad", "katki", "2026-10-17T10:01:00.000Z");
    expect(again.pings).toEqual([]);
    const emptied = save(s1.recorded, "maria-1", "bad", "", "2026-10-17T10:02:00.000Z");
    expect(emptied.pings).toEqual([]);
  });

  test("5. a Viga on a check a redo has reopened is a new failure: the answer before the mark does not count", () => {
    // dim-1 is a redo marked 20.10; the failure at 17.10 was before that, the Viga at 21.10 comes after the fix
    const s1 = save(doc(), "dim-1", "bad", "", "2026-10-17T10:00:00.000Z");
    expect(s1.pings).toEqual([{ id: "dim-1", kind: "bad" }]);
    const s2 = save(s1.recorded, "dim-1", "bad", "", "2026-10-21T10:00:00.000Z");
    expect(s2.pings).toEqual([{ id: "dim-1", kind: "bad" }]);
    expect(s2.recorded.answers["dim-1"].pinged).toBe("2026-10-21T10:00:00.000Z");
    // ...and it is one failure again from then on: its note is the second message, once
    const s3 = save(s2.recorded, "dim-1", "bad", "ikka katki", "2026-10-21T10:05:00.000Z");
    expect(s3.pings).toEqual([{ id: "dim-1", kind: "note" }]);
    const s4 = save(s3.recorded, "dim-1", "bad", "ikka katki, jah", "2026-10-21T10:06:00.000Z");
    expect(s4.pings).toEqual([]);
  });

  test("a redo marked \"deploy\" judges the failure by the build instant (merge and pings read the same instant)", () => {
    const plan: TestPlan = { ...PLAN, items: [item({ id: "d-1", mark: "redo", markedAt: "deploy" })] };
    const run = (stored: AnswersDoc, status: Status, note: string, at: string) => {
      const now = new Date(at);
      const merged = mergeAnswers(stored, { "d-1": inc(status, note) }, plan, "m@x.test", now, BUILD);
      const pings = pingsFor(stored, merged.doc, merged.changed, plan, BUILD);
      return { pings, recorded: markPinged(merged.doc, pings, now) };
    };
    // a failure before the build (21.10, build 22.10), then a Viga after the build: a new failure
    const before = run(doc(), "bad", "", "2026-10-21T10:00:00.000Z");
    expect(before.pings).toEqual([{ id: "d-1", kind: "bad" }]);
    const after = run(before.recorded, "bad", "", "2026-10-23T10:00:00.000Z");
    expect(after.pings).toEqual([{ id: "d-1", kind: "bad" }]);
    // a Viga after the build and its note: one failure, the note is the second message
    const noted = run(after.recorded, "bad", "katki", "2026-10-23T10:05:00.000Z");
    expect(noted.pings).toEqual([{ id: "d-1", kind: "note" }]);
  });

  test("the same failure saved four times on a check marked \"deploy\" earns exactly one message", () => {
    // the safety net (the stamp tool was skipped): every save is after the build, so it is one failure, announced once, whatever the note edits
    const plan: TestPlan = { ...PLAN, items: [item({ id: "d-1", mark: "redo", markedAt: "deploy" })] };
    let stored = doc();
    const perSave: string[][] = [];
    ["katki", "katki, tahvlis ka", "katki, tahvlis ka, kell 10", "katki, tahvlis ka, kell 10 hommikul"].forEach((note, i) => {
      const now = new Date(Date.UTC(2026, 9, 23, 10, i)); // 23.10, after the build of 22.10
      const merged = mergeAnswers(stored, { "d-1": inc("bad", note) }, plan, "m@x.test", now, BUILD);
      const pings = pingsFor(stored, merged.doc, merged.changed, plan, BUILD);
      perSave.push(pings.map((p) => p.kind));
      stored = markPinged(merged.doc, pings, now);
    });
    expect(perSave).toEqual([["bad"], [], [], []]);
    expect(stored.answers["d-1"].pinged).toBe("2026-10-23T10:00:00.000Z");
  });

  test("6. a brand-new Viga that already has a note: the first message only (it carries the note), and the note is marked sent", () => {
    const s = save(doc(), "maria-1", "bad", "nupp on katki", "2026-10-17T10:00:00.000Z");
    expect(s.pings).toEqual([{ id: "maria-1", kind: "bad" }]);
    expect(s.recorded.answers["maria-1"].pinged).toBe("2026-10-17T10:00:00.000Z");
    expect(s.recorded.answers["maria-1"].notePinged).toBe(true);
    // and so the next save of that failure sends nothing
    expect(save(s.recorded, "maria-1", "bad", "nupp on katki, tahvlis ka", "2026-10-17T10:05:00.000Z").pings).toEqual([]);
  });

  test("a Viga pressed on an answer with a note carries that old note: it is not this failure's, so the first message has none and the note typed next is the second", () => {
    // the page sends the check's note as it stands with a press: OK "Tahvlis korras", then Viga with that same note
    const ok = save(doc(), "maria-1", "ok", "Tahvlis korras", "2026-10-17T10:00:00.000Z");
    const s1 = save(ok.recorded, "maria-1", "bad", "Tahvlis korras", "2026-10-17T10:05:00.000Z");
    expect(s1.pings).toEqual([{ id: "maria-1", kind: "bad", oldNote: true }]);
    expect(s1.recorded.answers["maria-1"].pinged).toBe("2026-10-17T10:05:00.000Z");
    expect(s1.recorded.answers["maria-1"].notePinged).toBeUndefined();
    // the same failure saved again with the old note unchanged (Viga pressed twice, the field left alone): still nothing of that note
    const s2 = save(s1.recorded, "maria-1", "bad", "Tahvlis korras", "2026-10-17T10:06:00.000Z");
    expect(s2.pings).toEqual([]);
    // the description she then types: the second message, once
    const s3 = save(s2.recorded, "maria-1", "bad", "Nupp ei tööta", "2026-10-17T10:07:00.000Z");
    expect(s3.pings).toEqual([{ id: "maria-1", kind: "note" }]);
    expect(s3.recorded.answers["maria-1"].notePinged).toBe(true);
    expect(save(s3.recorded, "maria-1", "bad", "Nupp ei tööta, ka telefonis", "2026-10-17T10:08:00.000Z").pings).toEqual([]);
  });

  test("...the same for a skip's note and for the note of a failure a redo has overtaken; a note that differs from the answer before it is the failure's own", () => {
    const skip = save(doc(), "maria-1", "skip", "Hiljem", "2026-10-17T10:00:00.000Z");
    expect(save(skip.recorded, "maria-1", "bad", "Hiljem", "2026-10-17T10:05:00.000Z").pings).toEqual([{ id: "maria-1", kind: "bad", oldNote: true }]);
    // dim-1: a redo marked 20.10; the failure of 17.10 is overtaken, and a new Viga carrying its note does not carry it as its own
    const old = save(doc(), "dim-1", "bad", "Vana viga", "2026-10-17T10:00:00.000Z");
    expect(save(old.recorded, "dim-1", "bad", "Vana viga", "2026-10-21T10:00:00.000Z").pings).toEqual([{ id: "dim-1", kind: "bad", oldNote: true }]);
    // a new note with the Viga: the first message carries it, and it counts as sent
    const own = save(skip.recorded, "maria-1", "bad", "Nupp ei tööta", "2026-10-17T10:05:00.000Z");
    expect(own.pings).toEqual([{ id: "maria-1", kind: "bad" }]);
    expect(own.recorded.answers["maria-1"].notePinged).toBe(true);
  });

  test("markPinged: a first message for an old note records the failure as announced, and the note as still to come", () => {
    const stored = doc({ "maria-1": answer("bad", "2026-10-17T10:00:00.000Z", { note: "Tahvlis korras" }) });
    expect(markPinged(stored, [{ id: "maria-1", kind: "bad", oldNote: true }], new Date("2026-10-17T10:00:05.000Z")).answers["maria-1"]).toEqual({
      ...stored.answers["maria-1"],
      pinged: "2026-10-17T10:00:05.000Z",
    });
  });

  test("an OK or a skip with no note sends nothing; neither does an id that was not changed", () => {
    expect(save(doc(), "maria-1", "ok", "", "2026-10-17T10:00:00.000Z").pings).toEqual([]);
    expect(save(doc(), "maria-1", "skip", "", "2026-10-17T10:00:00.000Z").pings).toEqual([]);
    const failing = doc({ "maria-1": answer("bad", "2026-10-17T10:00:00.000Z", { note: "x" }) });
    expect(pingsFor(failing, failing, [], PLAN, BUILD)).toEqual([]);
  });

  // Dim 22.10: every answer has a note box, and the first note on any answer is one message ("note": the answer is shown by pingText).
  test("the first note on an OK is one message, once; later edits and the same OK pressed again send nothing", () => {
    const s1 = save(doc(), "maria-1", "ok", "", "2026-10-17T10:00:00.000Z");
    expect(s1.pings).toEqual([]);
    const s2 = save(s1.recorded, "maria-1", "ok", "Telefonis korras", "2026-10-17T10:05:00.000Z");
    expect(s2.pings).toEqual([{ id: "maria-1", kind: "note" }]);
    expect(s2.recorded.answers["maria-1"].notePinged).toBe(true);
    expect(s2.recorded.answers["maria-1"].pinged).toBeUndefined(); // (only a failure is "announced")
    const s3 = save(s2.recorded, "maria-1", "ok", "Telefonis korras, tahvlis ka", "2026-10-17T10:06:00.000Z");
    expect(s3.pings).toEqual([]);
    expect(s3.recorded.answers["maria-1"].notePinged).toBe(true); // carried over while it is the same answer
    expect(save(s3.recorded, "maria-1", "ok", "Telefonis korras, tahvlis ka", "2026-10-17T10:07:00.000Z").pings).toEqual([]);
    // the same OK pressed again keeps the field as it is: nothing
    expect(save(s2.recorded, "maria-1", "ok", "Telefonis korras", "2026-10-17T10:08:00.000Z").pings).toEqual([]);
  });

  test("the first note on a skip is one message too; a note that comes with the press itself counts", () => {
    const s1 = save(doc(), "maria-1", "skip", "", "2026-10-17T10:00:00.000Z");
    expect(s1.pings).toEqual([]);
    const s2 = save(s1.recorded, "maria-1", "skip", "Hiljem", "2026-10-17T10:05:00.000Z");
    expect(s2.pings).toEqual([{ id: "maria-1", kind: "note" }]);
    expect(save(s2.recorded, "maria-1", "skip", "Hiljem, kui õpilased on", "2026-10-17T10:06:00.000Z").pings).toEqual([]);
    // a fresh check answered OK with its note in the same save (the press and the typing reached the server together)
    const both = save(doc(), "koos-1", "ok", "Korras", "2026-10-17T10:00:00.000Z");
    expect(both.pings).toEqual([{ id: "koos-1", kind: "note" }]);
    expect(both.recorded.answers["koos-1"].notePinged).toBe(true);
  });

  test("an OK pressed on an answer with a note carries that note: it is not this answer's first note; the one typed next is", () => {
    // Viga "Nupp ei tööta" (announced, note sent), then OK with that note along, then the note rewritten
    const bad = save(doc(), "maria-1", "bad", "Nupp ei tööta", "2026-10-17T10:00:00.000Z");
    const ok = save(bad.recorded, "maria-1", "ok", "Nupp ei tööta", "2026-10-17T10:05:00.000Z");
    expect(ok.pings).toEqual([]);
    expect(ok.recorded.answers["maria-1"].notePinged).toBeUndefined();
    const typed = save(ok.recorded, "maria-1", "ok", "Parandatud, nupp töötab", "2026-10-17T10:06:00.000Z");
    expect(typed.pings).toEqual([{ id: "maria-1", kind: "note" }]);
    // ...and an OK's note carried to a skip, then to a Viga, is likewise nothing new
    const okNote = save(doc(), "koos-1", "ok", "Tahvlis korras", "2026-10-17T10:00:00.000Z");
    expect(okNote.pings).toEqual([{ id: "koos-1", kind: "note" }]);
    const skip = save(okNote.recorded, "koos-1", "skip", "Tahvlis korras", "2026-10-17T10:05:00.000Z");
    expect(skip.pings).toEqual([]);
    expect(skip.recorded.answers["koos-1"].notePinged).toBeUndefined(); // a different answer: its own first note is still to come
    expect(save(skip.recorded, "koos-1", "skip", "Jätsin vahele, sest ei saanud", "2026-10-17T10:06:00.000Z").pings).toEqual([{ id: "koos-1", kind: "note" }]);
  });

  test("an OK on a check a redo has reopened is a new answer: the note of the overtaken one is not carried as sent", () => {
    // dim-1 is a redo marked 20.10; the OK of 17.10 had its note announced, the OK of 21.10 is a new answer
    const old = save(doc(), "dim-1", "ok", "Vana märkus", "2026-10-17T10:00:00.000Z");
    expect(old.pings).toEqual([{ id: "dim-1", kind: "note" }]);
    const again = save(old.recorded, "dim-1", "ok", "", "2026-10-21T10:00:00.000Z");
    expect(again.pings).toEqual([]);
    expect(again.recorded.answers["dim-1"].notePinged).toBeUndefined();
    expect(save(again.recorded, "dim-1", "ok", "Uus märkus", "2026-10-21T10:05:00.000Z").pings).toEqual([{ id: "dim-1", kind: "note" }]);
    // pressed with the old note along (the page sends the note it shows; an overtaken answer shows none, but the rule holds anyway)
    expect(save(old.recorded, "dim-1", "ok", "Vana märkus", "2026-10-21T10:00:00.000Z").pings).toEqual([]);
  });

  test("a note on an id that is not in the plan earns nothing; two answers with notes in one save: a ping for each, in the order saved", () => {
    const after = doc({ gone: answer("ok", "2026-10-17T10:00:00.000Z", { note: "vana" }) });
    expect(pingsFor(doc(), after, ["gone"], PLAN, BUILD)).toEqual([]);
    const now = new Date("2026-10-17T10:00:00.000Z");
    const merged = mergeAnswers(doc(), { "maria-1": inc("ok", "a"), "koos-1": inc("skip", "b"), "dim-1": inc("ok") }, PLAN, "m@x.test", now, BUILD);
    expect(pingsFor(doc(), merged.doc, merged.changed, PLAN, BUILD)).toEqual([{ id: "maria-1", kind: "note" }, { id: "koos-1", kind: "note" }]);
  });

  test("markPinged: the first note on an OK records only notePinged", () => {
    const stored = doc({ "maria-1": answer("ok", "2026-10-17T10:00:00.000Z", { note: "hea" }) });
    expect(markPinged(stored, [{ id: "maria-1", kind: "note" }], new Date("2026-10-17T10:00:05.000Z")).answers["maria-1"]).toEqual({ ...stored.answers["maria-1"], notePinged: true });
  });

  test("a Viga on an id that is not in the plan earns nothing, whatever the doc holds", () => {
    const after = doc({ gone: answer("bad", "2026-10-17T10:00:00.000Z", { note: "vana" }), "maria-1": answer("bad", "2026-10-17T10:00:00.000Z") });
    expect(pingsFor(doc(), after, ["gone"], PLAN, BUILD)).toEqual([]);
    expect(pingsFor(doc(), after, ["gone", "maria-1"], PLAN, BUILD)).toEqual([{ id: "maria-1", kind: "bad" }]);
  });

  test("two Vigas in one save: a ping for each, in the order saved", () => {
    const now = new Date("2026-10-17T10:00:00.000Z");
    const merged = mergeAnswers(doc(), { "maria-1": inc("bad"), "koos-1": inc("bad", "katki"), "dim-1": inc("ok") }, PLAN, "m@x.test", now, BUILD);
    expect(pingsFor(doc(), merged.doc, merged.changed, PLAN, BUILD)).toEqual([{ id: "maria-1", kind: "bad" }, { id: "koos-1", kind: "bad" }]);
  });

  test("a failed send records nothing: the pings are found again on the next save", () => {
    const merged = mergeAnswers(doc(), { "maria-1": inc("bad") }, PLAN, "m@x.test", new Date("2026-10-17T10:00:00.000Z"), BUILD);
    expect(pingsFor(doc(), merged.doc, merged.changed, PLAN, BUILD)).toEqual([{ id: "maria-1", kind: "bad" }]);
    // (nothing was recorded) the same failure saved again, now with a note: still the first message
    const retry = mergeAnswers(merged.doc, { "maria-1": inc("bad", "katki") }, PLAN, "m@x.test", new Date("2026-10-17T10:05:00.000Z"), BUILD);
    expect(pingsFor(merged.doc, retry.doc, retry.changed, PLAN, BUILD)).toEqual([{ id: "maria-1", kind: "bad" }]);
  });

  test("markPinged edits a copy, leaves other ids alone, and skips an id the doc does not hold", () => {
    const stored = doc({ "maria-1": answer("bad", "2026-10-17T10:00:00.000Z", { note: "x" }), "dim-1": answer("bad", "2026-10-17T10:00:00.000Z") });
    const frozen = JSON.stringify(stored);
    const got = markPinged(stored, [{ id: "maria-1", kind: "bad" }, { id: "ghost", kind: "bad" }], new Date("2026-10-17T10:00:05.000Z"));
    expect(JSON.stringify(stored)).toBe(frozen);
    expect(got.answers["maria-1"]).toEqual({ ...stored.answers["maria-1"], pinged: "2026-10-17T10:00:05.000Z", notePinged: true });
    expect(got.answers["dim-1"]).toEqual(stored.answers["dim-1"]);
    expect(got.answers.ghost).toBeUndefined();
    // a first message for a failure without a note leaves the note message still to come
    expect(markPinged(stored, [{ id: "dim-1", kind: "bad" }], new Date("2026-10-17T10:00:05.000Z")).answers["dim-1"]).toEqual({ ...stored.answers["dim-1"], pinged: "2026-10-17T10:00:05.000Z" });
  });
});

describe("answers are read off the document's own keys, never off Object.prototype", () => {
  // kebab-case lets a check be called like a member of every object
  const NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty"];
  const plan: TestPlan = { ...PLAN, items: NAMES.map((id) => item({ id })) };
  const NOW = new Date("2026-10-17T10:00:00.000Z");

  test("planCounts: unanswered checks with such ids are open, not done", () => {
    expect(planCounts(plan, doc(), BUILD, null)).toEqual({ total: 4, done: 0, open: 4, bad: 0, redo: 0 });
  });

  test.each(NAMES)("%s: a Viga is written as an own entry, counted as one, and earns its first message", (id) => {
    const merged = mergeAnswers(doc(), { [id]: inc("bad", "katki") }, plan, "m@x.test", NOW, BUILD);
    expect(merged.changed).toEqual([id]);
    expect(Object.keys(merged.doc.answers)).toEqual([id]);
    expect(planCounts(plan, merged.doc, BUILD, null)).toEqual({ total: 4, done: 0, open: 3, bad: 1, redo: 0 });
    const pings = pingsFor(doc(), merged.doc, merged.changed, plan, BUILD);
    expect(pings).toEqual([{ id, kind: "bad" }]);
    expect(markPinged(merged.doc, pings, NOW).answers[id]).toEqual({ status: "bad", note: "katki", at: NOW.toISOString(), by: "m@x.test", pinged: NOW.toISOString(), notePinged: true });
  });

  test.each(NAMES)("%s: answerOf (exported for the server and the page) finds an own entry and never the prototype's member", (id) => {
    expect(answerOf({}, id)).toBeUndefined();
    const own = answer("ok", NOW.toISOString());
    expect(answerOf({ [id]: own }, id)).toBe(own);
  });

  test.each(NAMES)("%s: markPinged does not invent an entry for an answer the doc does not hold; pingsFor finds none", (id) => {
    const got = markPinged(doc(), [{ id, kind: "bad" }], NOW);
    expect(Object.keys(got.answers)).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(got.answers, id)).toBe(false);
    expect(pingsFor(doc(), doc(), [id], plan, BUILD)).toEqual([]);
  });
});

describe("testerOf: the session's admin → Maria or Dim by the first word of their name (spec D10)", () => {
  const NAMES = "m@x.test=Maria Sosnina,d@x.test=Dim";
  test.each([
    { name: "Maria's address", email: "m@x.test", names: NAMES, expected: "maria" },
    { name: "Dim's address", email: "d@x.test", names: NAMES, expected: "dim" },
    { name: "an address that is not listed", email: "z@x.test", names: NAMES, expected: null },
    { name: "the match is case-insensitive (the address)", email: "M@X.Test", names: NAMES, expected: "maria" },
    { name: "...and the listed address", email: "d@x.test", names: "D@X.TEST=Dim", expected: "dim" },
    { name: "...and the name", email: "m@x.test", names: "m@x.test=MARIA sosnina", expected: "maria" },
    { name: "white space around the entries and the name", email: "m@x.test", names: " d@x.test = Dim , m@x.test =  Maria Sosnina ", expected: "maria" },
    { name: "a name that is neither Maria nor Dim", email: "k@x.test", names: `${NAMES},k@x.test=Kati Tamm`, expected: null },
    { name: "the first word only: a longer first word is not Dim", email: "k@x.test", names: "k@x.test=Dimitri Ivanov", expected: null },
    { name: "the first word only: Dim as a later word does not count", email: "k@x.test", names: "k@x.test=Kati Dim", expected: null },
    { name: "an entry with an empty name", email: "k@x.test", names: "k@x.test=", expected: null },
    { name: "no names setting", email: "m@x.test", names: undefined, expected: null },
    { name: "an empty names setting", email: "m@x.test", names: "", expected: null },
    { name: "an empty address", email: "", names: NAMES, expected: null },
    { name: "an entry without a name", email: "m@x.test", names: "m@x.test", expected: null },
  ])("$name", ({ email, names, expected }) => {
    expect(testerOf(email, names)).toBe(expected);
  });
});

describe("planCounts: what the header and the Avaleht card show (spec §4, §5)", () => {
  // maria-1 answered OK; dim-1 (redo marked 20.10) failed on 19.10, so it is open again with the failure overtaken; koos-1 (redo on the plan-wide mark) OK after it
  const FULL = doc({
    "maria-1": answer("ok", "2026-10-17T10:00:00.000Z"),
    "dim-1": answer("bad", "2026-10-19T10:00:00.000Z"),
    "koos-1": answer("ok", "2026-10-17T10:00:00.000Z"),
    gone: answer("bad", "2026-10-17T10:00:00.000Z"), // an id no longer in the plan: never counted
  });

  test("everything (who null), then each tester's own share plus the shared checks", () => {
    expect(planCounts(PLAN, FULL, BUILD, null)).toEqual({ total: 3, done: 2, open: 1, bad: 0, redo: 1 });
    // Maria: her own check and the shared one; Dim's check is left out
    expect(planCounts(PLAN, FULL, BUILD, "maria")).toEqual({ total: 2, done: 2, open: 0, bad: 0, redo: 0 });
    // Dim: his own (reopened by the redo) and the shared one
    expect(planCounts(PLAN, FULL, BUILD, "dim")).toEqual({ total: 2, done: 1, open: 1, bad: 0, redo: 1 });
  });

  test("a stored „Jäta vahele“ counts as open, not as done, and is no redo (piece 4c, Dim 29.10)", () => {
    const skipped = doc({ "maria-1": answer("skip", "2026-10-17T10:00:00.000Z", { note: "Hiljem" }), "koos-1": answer("ok", "2026-10-17T10:00:00.000Z") });
    expect(planCounts(PLAN, skipped, BUILD, "maria")).toEqual({ total: 2, done: 1, open: 1, bad: 0, redo: 0 });
  });

  test("a failure counts as bad, not as done or open; an unanswered check is open but not a redo", () => {
    const failing = doc({ "maria-1": answer("bad", "2026-10-17T10:00:00.000Z"), "dim-1": answer("bad", "2026-10-21T10:00:00.000Z") });
    expect(planCounts(PLAN, failing, BUILD, null)).toEqual({ total: 3, done: 0, open: 1, bad: 2, redo: 0 });
    expect(planCounts(PLAN, doc(), BUILD, "maria")).toEqual({ total: 2, done: 0, open: 2, bad: 0, redo: 0 });
  });

  test("redo counts only open checks that carry an overtaken answer", () => {
    // koos-1 is a redo on the plan-wide mark (16.10): answered before it → overtaken; dim-1 has no answer at all
    const stale = doc({ "koos-1": answer("ok", "2026-10-15T10:00:00.000Z") });
    expect(planCounts(PLAN, stale, BUILD, null)).toEqual({ total: 3, done: 0, open: 3, bad: 0, redo: 1 });
  });

  test("the counts add up: done + open + bad = total", () => {
    for (const who of [null, "maria", "dim"] as const) {
      const c = planCounts(PLAN, FULL, BUILD, who);
      expect(c.done + c.open + c.bad).toBe(c.total);
    }
  });

  test("an answer to an id outside the plan does not count, and an empty plan counts nothing", () => {
    expect(planCounts({ ...PLAN, items: [] }, FULL, BUILD, null)).toEqual({ total: 0, done: 0, open: 0, bad: 0, redo: 0 });
  });
});

describe("ownFaults: the number on Testimine's menu badge (admin UX pass, B6)", () => {
  const ME = "maria@example.test";
  const DIM = "dim@example.test";

  test("counts the standing „Viga“ answers the signed-in admin gave, not another admin's and not their OK or skip", () => {
    const answers = doc({
      "maria-1": answer("bad", "2026-10-17T10:00:00.000Z", { by: ME }),
      "dim-1": answer("bad", "2026-10-21T10:00:00.000Z", { by: DIM }),
      "koos-1": answer("ok", "2026-10-21T10:00:00.000Z", { by: ME }),
    });
    expect(ownFaults(PLAN, answers, BUILD, ME)).toBe(1);
    expect(ownFaults(PLAN, answers, BUILD, DIM)).toBe(1);
    expect(ownFaults(PLAN, answers, BUILD, "nobody@example.test")).toBe(0);
    expect(ownFaults(PLAN, doc(), BUILD, ME)).toBe(0);
  });

  test("the address is compared without regard to case or white space; an empty address owns nothing", () => {
    const answers = doc({ "maria-1": answer("bad", "2026-10-17T10:00:00.000Z", { by: "Maria@Example.test" }) });
    expect(ownFaults(PLAN, answers, BUILD, " maria@EXAMPLE.test ")).toBe(1);
    expect(ownFaults(PLAN, answers, BUILD, "")).toBe(0);
    expect(ownFaults(PLAN, doc({ "maria-1": answer("bad", "2026-10-17T10:00:00.000Z", { by: "" }) }), BUILD, "")).toBe(0);
  });

  test("a Viga that a redo has reopened is open again and no longer counts; neither does an answer to a check the plan lost", () => {
    // dim-1 is a redo marked 20.10: a failure of 19.10 is overtaken, one of 21.10 stands
    const answers = doc({
      "dim-1": answer("bad", "2026-10-19T10:00:00.000Z", { by: ME }),
      "koos-1": answer("bad", "2026-10-21T10:00:00.000Z", { by: ME }),
      gone: answer("bad", "2026-10-21T10:00:00.000Z", { by: ME }),
    });
    expect(ownFaults(PLAN, answers, BUILD, ME)).toBe(1);
  });
});

// Dim 25.10: a third tester, „Automaattest“ (an automatic tester on the staging site), whose answers are never Maria's or Dim's. They are kept
// in the doc's own `auto` map, with the same answer shape; Maria's and Dim's stay in `answers` exactly as before. (Since Dim 29.10 its answer is
// a check's state where no person's answer stands: sharedState, above.)
describe("Automaattest: a third tester whose answers stay apart (Dim 25.10)", () => {
  const AUTO = "auto@x.test";
  const NAMES = `m@x.test=Maria Sosnina,d@x.test=Dim,${AUTO}=Automaattest`;
  const NOW = new Date("2026-10-25T10:00:00.000Z");
  const withAuto = (answers: Record<string, StoredAnswer>, auto: Record<string, StoredAnswer>): AnswersDoc => ({ v: 1, answers, auto });

  test.each([
    { name: "the name Automaattest", email: AUTO, names: NAMES, expected: "auto" },
    { name: "the name in any case", email: AUTO, names: `${AUTO}=automaattest`, expected: "auto" },
    { name: "a name that starts with it", email: AUTO, names: `${AUTO}=Automaattest 2`, expected: "auto" },
    { name: "...written as one word with more after it", email: AUTO, names: `${AUTO}=AUTOMAATTEST2`, expected: "auto" },
    { name: "Automaattest as a later word does not count", email: "k@x.test", names: "k@x.test=Kati Automaattest", expected: null },
    { name: "Maria stays Maria", email: "m@x.test", names: NAMES, expected: "maria" },
    { name: "Dim stays Dim", email: "d@x.test", names: NAMES, expected: "dim" },
  ])("testerOf: $name", ({ email, names, expected }) => {
    expect(testerOf(email, names)).toBe(expected);
  });

  test("a save into `auto` writes only `auto`: Maria's and Dim's answers are left exactly as they were", () => {
    const stored = doc({ "maria-1": answer("ok", "2026-10-17T10:00:00.000Z", { by: "m@x.test", note: "hea", notePinged: true }) });
    const { doc: merged, changed } = mergeAnswers(stored, { "maria-1": inc("bad", "katki"), "dim-1": inc("ok") }, PLAN, AUTO, NOW, BUILD, "auto");
    expect(changed).toEqual(["maria-1", "dim-1"]);
    expect(merged.answers).toEqual(stored.answers);
    expect(merged.auto).toEqual({
      "maria-1": { status: "bad", note: "katki", at: NOW.toISOString(), by: AUTO },
      "dim-1": { status: "ok", note: "", at: NOW.toISOString(), by: AUTO },
    });
    expect(stored).toEqual(doc({ "maria-1": answer("ok", "2026-10-17T10:00:00.000Z", { by: "m@x.test", note: "hea", notePinged: true }) })); // (not edited in place)
  });

  test("a save by Maria or Dim never touches `auto`, and an Automaattest answer's ping records do not carry over into hers", () => {
    const auto = { "maria-1": answer("bad", "2026-10-24T10:00:00.000Z", { by: AUTO, note: "katki", pinged: "2026-10-24T10:00:00.000Z", notePinged: true }) };
    const stored = withAuto({}, auto);
    const { doc: merged } = mergeAnswers(stored, { "maria-1": inc("bad") }, PLAN, "m@x.test", NOW, BUILD);
    expect(merged.auto).toEqual(auto);
    expect(merged.answers["maria-1"]).toEqual({ status: "bad", note: "", at: NOW.toISOString(), by: "m@x.test" });
    // ...so her Viga is a new failure of her own, announced as hers
    expect(pingsFor(stored, merged, ["maria-1"], PLAN, BUILD)).toEqual([{ id: "maria-1", kind: "bad" }]);
  });

  test("an old doc without `auto`: a save by Maria adds none; a save into `auto` starts it", () => {
    const shared = mergeAnswers(doc(), { "maria-1": inc("ok") }, PLAN, "m@x.test", NOW, BUILD);
    expect(Object.keys(shared.doc)).toEqual(["v", "answers"]);
    const auto = mergeAnswers(doc(), { "maria-1": inc("ok") }, PLAN, AUTO, NOW, BUILD, "auto");
    expect(auto.doc).toEqual({ v: 1, answers: {}, auto: { "maria-1": { status: "ok", note: "", at: NOW.toISOString(), by: AUTO } } });
  });

  // Dim 29.10: a clear takes back the session's own side only. Maria's taking back her answer leaves Automaattest's, so a check Automaattest passed
  // is its pass again (the page's rule, Task 5); Automaattest's taking back its own leaves hers.
  test("a clear by Maria removes her answer and leaves `auto` exactly as it was; a clear into `auto` removes Automaattest's and leaves `answers`", () => {
    const stored = withAuto(
      { "maria-1": answer("bad", "2026-10-17T10:00:00.000Z", { by: "m@x.test", note: "katki", pinged: "2026-10-17T10:00:01.000Z", notePinged: true }) },
      { "maria-1": answer("ok", "2026-10-24T10:00:00.000Z", { by: AUTO }), "dim-1": answer("bad", "2026-10-24T10:00:00.000Z", { by: AUTO, pinged: "2026-10-24T10:00:01.000Z" }) },
    );
    const byMaria = mergeAnswers(stored, { "maria-1": clear() }, PLAN, "m@x.test", NOW, BUILD);
    expect(byMaria.changed).toEqual(["maria-1"]);
    expect(byMaria.doc).toEqual(withAuto({}, stored.auto!));

    const byAuto = mergeAnswers(stored, { "dim-1": clear(), "maria-1": clear() }, PLAN, AUTO, NOW, BUILD, "auto");
    expect(byAuto.changed).toEqual(["dim-1", "maria-1"]);
    expect(byAuto.doc).toEqual(withAuto(stored.answers, {}));

    // a clear of a check only the other side has answered is a no-op for this side
    const noop = mergeAnswers(stored, { "dim-1": clear() }, PLAN, "m@x.test", NOW, BUILD);
    expect(noop.changed).toEqual([]);
    expect(noop.doc).toEqual(stored);
  });

  test("Automaattest's Viga taken back earns no message, and its Viga pressed again is a new failure, marked `auto`", () => {
    const first = new Date("2026-10-25T10:00:00.000Z");
    const bad = mergeAnswers(doc(), { "maria-1": inc("bad", "nupp puudub") }, PLAN, AUTO, first, BUILD, "auto");
    const sent = markPinged(bad.doc, pingsFor(doc(), bad.doc, bad.changed, PLAN, BUILD, "auto"), first);
    const cleared = mergeAnswers(sent, { "maria-1": clear() }, PLAN, AUTO, NOW, BUILD, "auto");
    expect(pingsFor(sent, cleared.doc, cleared.changed, PLAN, BUILD, "auto")).toEqual([]);
    expect(cleared.doc.auto).toEqual({});
    const again = mergeAnswers(cleared.doc, { "maria-1": inc("bad", "nupp puudub") }, PLAN, AUTO, new Date("2026-10-25T11:00:00.000Z"), BUILD, "auto");
    expect(pingsFor(cleared.doc, again.doc, again.changed, PLAN, BUILD, "auto")).toEqual([{ id: "maria-1", kind: "bad", auto: true }]);
  });

  // Admin polish Part A (Dim 29.10, reversing D10's "never counts" of 25.10): Automaattest's answer is a check's state where no person's answer
  // stands, in the counts too (the header, the „Olek“ pills, the area bars, the Avaleht card); the menu badge (ownFaults) is as it was.
  test("planCounts take Automaattest's answer where no person's answer stands; ownFaults still counts each admin's own standing Vead, Automaattest's in `auto`", () => {
    const shared = { "maria-1": answer("ok", "2026-10-17T10:00:00.000Z", { by: "m@x.test" }) };
    const auto = {
      "maria-1": answer("bad", "2026-10-24T10:00:00.000Z", { by: AUTO }), // (Maria's OK wins)
      "dim-1": answer("bad", "2026-10-24T10:00:00.000Z", { by: AUTO }), // (after dim-1's redo of 20.10: it stands)
      "koos-1": answer("ok", "2026-10-24T10:00:00.000Z", { by: AUTO }),
    };
    expect(planCounts(PLAN, withAuto(shared, auto), BUILD, null)).toEqual({ total: 3, done: 2, open: 0, bad: 1, redo: 0 });
    expect(planCounts(PLAN, withAuto(shared, auto), BUILD, "maria")).toEqual({ total: 2, done: 2, open: 0, bad: 0, redo: 0 });
    expect(planCounts(PLAN, withAuto(shared, auto), BUILD, "dim")).toEqual({ total: 2, done: 1, open: 0, bad: 1, redo: 0 });
    // its Jäta vahele leaves a check open, and so does an answer of its a redo has overtaken (dim-1 marked 20.10, answered 19.10)
    const weak = { "dim-1": answer("ok", "2026-10-19T10:00:00.000Z", { by: AUTO }), "koos-1": answer("skip", "2026-10-24T10:00:00.000Z", { by: AUTO }) };
    expect(planCounts(PLAN, withAuto({}, weak), BUILD, "dim")).toEqual({ total: 2, done: 0, open: 2, bad: 0, redo: 0 });
    // the doc without `auto` (Automaattest's own numbers are its map passed as `answers`) counts as before
    expect(planCounts(PLAN, doc(auto), BUILD, null)).toEqual({ total: 3, done: 1, open: 0, bad: 2, redo: 0 });
    expect(ownFaults(PLAN, withAuto(shared, auto), BUILD, "m@x.test")).toBe(0);
    expect(ownFaults(PLAN, withAuto(shared, auto), BUILD, AUTO)).toBe(2);
  });

  test("planCounts: Maria's answer taken back on a check Automaattest passed counts it „Läbitud“ again, not open (Review Focus 5)", () => {
    const stored = withAuto(
      { "maria-1": answer("bad", "2026-10-25T09:00:00.000Z", { by: "m@x.test" }) },
      { "maria-1": answer("ok", "2026-10-24T10:00:00.000Z", { by: AUTO }) },
    );
    expect(planCounts(PLAN, stored, BUILD, "maria")).toMatchObject({ done: 0, bad: 1 });
    const cleared = mergeAnswers(stored, { "maria-1": clear() }, PLAN, "m@x.test", NOW, BUILD);
    expect(planCounts(PLAN, cleared.doc, BUILD, "maria")).toMatchObject({ done: 1, bad: 0, open: 1 }); // (koos-1 has no answer)
  });

  test("the mark rule holds for Automaattest's answers: a redo after its Viga reopens the check, and a Viga after the redo is a new failure", () => {
    // dim-1 is a redo marked 20.10
    const save = (stored: AnswersDoc, status: Status, note: string, at: string) => {
      const now = new Date(at);
      const merged = mergeAnswers(stored, { "dim-1": inc(status, note) }, PLAN, AUTO, now, BUILD, "auto");
      const pings = pingsFor(stored, merged.doc, merged.changed, PLAN, BUILD, "auto");
      return { pings, recorded: markPinged(merged.doc, pings, now) };
    };
    const early = save(doc(), "bad", "", "2026-10-19T10:00:00.000Z");
    expect(early.pings).toEqual([{ id: "dim-1", kind: "bad", auto: true }]);
    const st = checkState(PLAN.items[1], early.recorded.auto!["dim-1"], PLAN, BUILD);
    expect([st.state, st.answer, st.overtaken?.status]).toEqual(["open", null, "bad"]);
    const late = save(early.recorded, "bad", "", "2026-10-21T10:00:00.000Z");
    expect(late.pings).toEqual([{ id: "dim-1", kind: "bad", auto: true }]);
    expect(late.recorded.auto!["dim-1"].pinged).toBe("2026-10-21T10:00:00.000Z");
    expect(late.recorded.answers).toEqual({});
  });

  test("its pings: a Viga, then that Viga's first note, each once and marked `auto`; an OK or a Jäta vahele sends nothing, even with a note", () => {
    const save = (stored: AnswersDoc, id: string, status: Status, note: string, at: string) => {
      const now = new Date(at);
      const merged = mergeAnswers(stored, { [id]: inc(status, note) }, PLAN, AUTO, now, BUILD, "auto");
      const pings = pingsFor(stored, merged.doc, merged.changed, PLAN, BUILD, "auto");
      return { pings, recorded: markPinged(merged.doc, pings, now) };
    };
    const s1 = save(doc(), "maria-1", "bad", "", "2026-10-25T10:00:00.000Z");
    expect(s1.pings).toEqual([{ id: "maria-1", kind: "bad", auto: true }]);
    const s2 = save(s1.recorded, "maria-1", "bad", "nupp puudub", "2026-10-25T10:01:00.000Z");
    expect(s2.pings).toEqual([{ id: "maria-1", kind: "note", auto: true }]);
    expect(s2.recorded.auto!["maria-1"]).toMatchObject({ pinged: "2026-10-25T10:00:00.000Z", notePinged: true });
    expect(save(s2.recorded, "maria-1", "bad", "nupp puudub ikka", "2026-10-25T10:02:00.000Z").pings).toEqual([]);
    // an OK and a Jäta vahele, with a note or without
    const ok = save(doc(), "maria-2", "ok", "", "2026-10-25T10:00:00.000Z");
    expect(ok.pings).toEqual([]);
    expect(save(ok.recorded, "maria-2", "ok", "korras", "2026-10-25T10:01:00.000Z").pings).toEqual([]);
    expect(save(doc(), "dim-1", "skip", "hiljem", "2026-10-25T10:00:00.000Z").pings).toEqual([]);
  });

  test("markPinged records a ping marked `auto` in `auto` only, and one without the mark in `answers` only", () => {
    const one = answer("bad", NOW.toISOString(), { note: "katki" });
    const both = withAuto({ "maria-1": { ...one, by: "m@x.test" } }, { "maria-1": { ...one, by: AUTO } });
    const auto = markPinged(both, [{ id: "maria-1", kind: "bad", auto: true }], NOW);
    expect(auto.answers).toEqual(both.answers);
    expect(auto.auto!["maria-1"]).toEqual({ ...one, by: AUTO, pinged: NOW.toISOString(), notePinged: true });
    const shared = markPinged(both, [{ id: "maria-1", kind: "bad" }], NOW);
    expect(shared.auto).toEqual(both.auto);
    expect(shared.answers["maria-1"].pinged).toBe(NOW.toISOString());
    // a doc without `auto` gets none from a ping marked `auto`
    expect(markPinged(doc(both.answers), [{ id: "maria-1", kind: "bad", auto: true }], NOW)).toEqual(doc(both.answers));
  });

  test("readAnswersDoc reads `auto` by the same rules as `answers`; a doc without it has none, and one that is not an object is dropped", () => {
    const good = { status: "bad", note: " katki ", at: "2026-10-25T10:00:00.000Z", by: AUTO, pinged: "2026-10-25T10:00:00.000Z" };
    const read = readAnswersDoc({ v: 1, answers: {}, auto: { "maria-1": good, "maria-2": { ...good, status: "maybe" } } });
    expect(read).toEqual({ v: 1, answers: {}, auto: { "maria-1": { ...good, note: "katki" } } });
    expect(Object.keys(readAnswersDoc({ v: 1, answers: {} }))).toEqual(["v", "answers"]);
    expect(Object.keys(readAnswersDoc({ v: 1, answers: {}, auto: [good] }))).toEqual(["v", "answers"]);
    expect(Object.keys(readAnswersDoc({ v: 1, answers: {}, auto: null }))).toEqual(["v", "answers"]);
  });
});

// Dim 30.10: a note box under every check. A note typed without pressing is stored on its own, `{ status: "note", note, at, by }` in the session's own
// map (`answers`, or `auto` for Automaattest), one entry per check per side as ever. It decides no state ("open stays open, Automaattest's ✓ stays ✓")
// and counts as nothing; its first note pings Telegram like any answer's. A "note" whose text cleans to "" is a clear.
describe("a note on its own (Dim 30.10)", () => {
  const NOW = new Date("2026-10-30T10:00:00.000Z");
  const AUTO = "auto@x.test";
  const redo20 = item({ mark: "redo", markedAt: "2026-10-20T00:00:00.000Z" });
  /** A note stored on its own (Maria's unless `over` says otherwise). */
  const noted = (note: string, at = "2026-10-21T10:00:00.000Z", over: Partial<StoredAnswer> = {}): StoredAnswer => ({ status: "note", note, at, by: "m@x.test", ...over });
  /** A note sent on its own, as the page sends one typed on a check with no answer of hers. */
  const alone = (note: string): IncomingAnswer => ({ status: "note", note });
  const A = (status: Status, at = "2026-10-21T11:00:00.000Z") => answer(status, at, { by: AUTO });
  const withAuto = (answers: Record<string, StoredAnswer>, auto: Record<string, StoredAnswer>): AnswersDoc => ({ v: 1, answers, auto });

  test("checkState: a note is open, with the note as the check's answer; no redo overtakes it (a note is no verdict)", () => {
    expect(checkState(item(), noted("Nupp on hall"), PLAN, BUILD)).toEqual({ state: "open", answer: noted("Nupp on hall"), overtaken: null });
    // (typed before the redo's instant: still the check's note, never „Varasem vastus“)
    const early = noted("Nupp on hall", "2026-10-19T10:00:00.000Z");
    expect(checkState(redo20, early, PLAN, BUILD)).toEqual({ state: "open", answer: early, overtaken: null });
  });

  const CASES: { name: string; it?: TestItem; auto?: StoredAnswer; state: "open" | "done" | "failed" }[] = [
    { name: "no Automaattest answer: open", state: "open" },
    { name: "Automaattest's OK: done (its ✓ stays)", auto: A("ok"), state: "done" },
    { name: "Automaattest's Viga: failed", auto: A("bad"), state: "failed" },
    { name: "Automaattest's Jäta vahele: open", auto: A("skip"), state: "open" },
    { name: "Automaattest's note alone: open", auto: noted("auto märkus", "2026-10-21T11:00:00.000Z", { by: AUTO }), state: "open" },
    { name: "Automaattest's OK a redo overtook: open", it: redo20, auto: A("ok", "2026-10-19T10:00:00.000Z"), state: "open" },
  ];
  test.each(CASES)("sharedState: a person's note, $name; the answer is her note, nothing overtaken", ({ it = item(), auto, state }) => {
    const person = noted("Minu märkus");
    expect(sharedState(it, person, auto, PLAN, BUILD)).toEqual({ state, answer: person, overtaken: null });
  });

  test("sharedState: Automaattest's note alone decides nothing either, and a person's answer still wins over it", () => {
    const autoNote = noted("auto märkus", "2026-10-21T11:00:00.000Z", { by: AUTO });
    expect(sharedState(item(), undefined, autoNote, PLAN, BUILD)).toEqual({ state: "open", answer: null, overtaken: null });
    const ok = answer("ok", "2026-10-21T10:00:00.000Z", { by: "m@x.test" });
    expect(sharedState(item(), ok, autoNote, PLAN, BUILD)).toEqual({ state: "done", answer: ok, overtaken: null });
    // stateIn reads the same off a doc
    expect(stateIn(withAuto({ "maria-1": noted("x") }, { "maria-1": A("ok") }), PLAN.items[0], PLAN, BUILD)).toEqual({ state: "done", answer: noted("x"), overtaken: null });
  });

  test("planCounts and ownFaults: a note counts as nothing (open, or Automaattest's state), never as a redo", () => {
    // maria-1 her note alone; koos-1 her note over Automaattest's OK; dim-1 (redo 20.10) her note typed before the redo, and Automaattest's note
    const notes = withAuto(
      { "maria-1": noted("a"), "koos-1": noted("b"), "dim-1": noted("c", "2026-10-19T10:00:00.000Z") },
      { "koos-1": A("ok"), "dim-1": noted("d", "2026-10-21T11:00:00.000Z", { by: AUTO }) },
    );
    expect(planCounts(PLAN, notes, BUILD, null)).toEqual({ total: 3, done: 1, open: 2, bad: 0, redo: 0 });
    expect(planCounts(PLAN, doc({ "maria-1": noted("a") }), BUILD, "maria")).toEqual({ total: 2, done: 0, open: 2, bad: 0, redo: 0 });
    expect(ownFaults(PLAN, withAuto({ "maria-1": noted("a") }, { "dim-1": noted("d", "2026-10-21T11:00:00.000Z", { by: AUTO }) }), BUILD, "m@x.test")).toBe(0);
    expect(ownFaults(PLAN, withAuto({}, { "dim-1": noted("d", "2026-10-21T11:00:00.000Z", { by: AUTO }) }), BUILD, AUTO)).toBe(0);
  });

  test("readAnswersDoc keeps a stored note by the rules of any answer, in either map; a note whose text cleans to nothing is no entry", () => {
    const at = "2026-10-30T09:00:00.000Z";
    const value = {
      v: 1,
      answers: { "maria-1": { status: "note", note: "  Nupp on hall  ", at, by: "m@x.test", notePinged: true }, "maria-2": { status: "note", note: "   ", at, by: "m@x.test" } },
      auto: { "dim-1": { status: "note", note: "auto", at, by: AUTO }, "koos-1": { status: "note", note: 5, at, by: AUTO } },
    };
    expect(readAnswersDoc(value)).toEqual({
      v: 1,
      answers: { "maria-1": { status: "note", note: "Nupp on hall", at, by: "m@x.test", notePinged: true } },
      auto: { "dim-1": { status: "note", note: "auto", at, by: AUTO } },
    });
  });

  test("mergeAnswers stores it as `{ status: \"note\", note, at, by }`, the note cleaned, in the session's own map only", () => {
    const { doc: merged, changed } = mergeAnswers(doc(), { "maria-1": alone("  Nupp on hall  ") }, PLAN, "m@x.test", NOW, BUILD);
    expect(changed).toEqual(["maria-1"]);
    expect(merged).toEqual(doc({ "maria-1": { status: "note", note: "Nupp on hall", at: NOW.toISOString(), by: "m@x.test" } }));
    const ok = { "maria-1": answer("ok", "2026-10-21T10:00:00.000Z", { by: "m@x.test" }) };
    const byAuto = mergeAnswers(doc(ok), { "maria-1": alone("auto märkus") }, PLAN, AUTO, NOW, BUILD, "auto");
    expect(byAuto.doc).toEqual(withAuto(ok, { "maria-1": { status: "note", note: "auto märkus", at: NOW.toISOString(), by: AUTO } }));
    // an id outside the plan is ignored, as for any answer
    expect(mergeAnswers(doc(), { ghost: alone("x") }, PLAN, "m@x.test", NOW, BUILD)).toEqual({ doc: doc(), changed: [] });
  });

  test("a note whose text cleans to \"\" acts exactly as a clear: the entry of that map goes, whatever it was; with none, nothing changes", () => {
    const stored = withAuto(
      { "maria-1": noted("Nupp on hall", "2026-10-21T10:00:00.000Z", { notePinged: true }), "dim-1": answer("ok", "2026-10-21T10:00:00.000Z", { by: "m@x.test" }) },
      { "maria-1": A("ok") },
    );
    const emptied = mergeAnswers(stored, { "maria-1": alone("   "), "dim-1": alone(""), "koos-1": alone("") }, PLAN, "m@x.test", NOW, BUILD);
    expect(emptied.changed).toEqual(["maria-1", "dim-1"]);
    expect(emptied.doc).toEqual(withAuto({}, stored.auto!));
    expect(emptied.doc).toEqual(mergeAnswers(stored, { "maria-1": clear(), "dim-1": clear(), "koos-1": clear() }, PLAN, "m@x.test", NOW, BUILD).doc);
    expect(pingsFor(stored, emptied.doc, emptied.changed, PLAN, BUILD)).toEqual([]);
  });

  /** One save of one check, as the route runs it: merge, find the pings, record them. */
  function save(stored: AnswersDoc, id: string, incoming: IncomingAnswer, at: string, by = "m@x.test", side: "answers" | "auto" = "answers") {
    const now = new Date(at);
    const merged = mergeAnswers(stored, { [id]: incoming }, PLAN, by, now, BUILD, side);
    const pings = pingsFor(stored, merged.doc, merged.changed, PLAN, BUILD, side);
    return { pings, recorded: markPinged(merged.doc, pings, now) };
  }

  test("its first note pings once, kind \"note\"; retyping pings nothing; emptying it (the clear) pings nothing; a note typed after that is a new one", () => {
    const s1 = save(doc(), "maria-1", alone("Nupp on hall"), "2026-10-30T10:00:00.000Z");
    expect(s1.pings).toEqual([{ id: "maria-1", kind: "note" }]);
    expect(s1.recorded.answers["maria-1"]).toEqual({ status: "note", note: "Nupp on hall", at: "2026-10-30T10:00:00.000Z", by: "m@x.test", notePinged: true });
    const s2 = save(s1.recorded, "maria-1", alone("Nupp on hall, ka telefonis"), "2026-10-30T10:01:00.000Z");
    expect(s2.pings).toEqual([]);
    expect(s2.recorded.answers["maria-1"].notePinged).toBe(true); // (carried: the same note entry)
    const s3 = save(s2.recorded, "maria-1", alone(""), "2026-10-30T10:02:00.000Z");
    expect(s3.pings).toEqual([]);
    expect(s3.recorded.answers).toEqual({});
    // (no memory of the cleared one, as for a clear: Dim 29.10)
    expect(save(s3.recorded, "maria-1", alone("Uus märkus"), "2026-10-30T10:03:00.000Z").pings).toEqual([{ id: "maria-1", kind: "note" }]);
  });

  test("a Viga pressed over a note carries its text: it earns its Viga message (no note of its own yet), and that text is not sent again", () => {
    const n = save(doc(), "maria-1", alone("Nupp ei tööta"), "2026-10-30T10:00:00.000Z");
    expect(n.pings).toEqual([{ id: "maria-1", kind: "note" }]);
    const bad = save(n.recorded, "maria-1", inc("bad", "Nupp ei tööta"), "2026-10-30T10:01:00.000Z");
    expect(bad.pings).toEqual([{ id: "maria-1", kind: "bad", oldNote: true }]);
    expect(bad.recorded.answers["maria-1"]).toEqual({ status: "bad", note: "Nupp ei tööta", at: "2026-10-30T10:01:00.000Z", by: "m@x.test", pinged: "2026-10-30T10:01:00.000Z" });
    // the same failure saved again with the same text: nothing; the description typed next: the second message, once
    const again = save(bad.recorded, "maria-1", inc("bad", "Nupp ei tööta"), "2026-10-30T10:02:00.000Z");
    expect(again.pings).toEqual([]);
    const typed = save(again.recorded, "maria-1", inc("bad", "Nupp ei tööta, ka telefonis"), "2026-10-30T10:03:00.000Z");
    expect(typed.pings).toEqual([{ id: "maria-1", kind: "note" }]);
  });

  test("a Läbitud pressed over a note carries its text and pings nothing; a note typed on it next is its first", () => {
    const n = save(doc(), "koos-1", alone("Tahvlis korras"), "2026-10-30T10:00:00.000Z");
    const ok = save(n.recorded, "koos-1", inc("ok", "Tahvlis korras"), "2026-10-30T10:01:00.000Z");
    expect(ok.pings).toEqual([]);
    expect(ok.recorded.answers["koos-1"]).toEqual({ status: "ok", note: "Tahvlis korras", at: "2026-10-30T10:01:00.000Z", by: "m@x.test" });
    expect(save(ok.recorded, "koos-1", inc("ok", "Tahvlis ja telefonis korras"), "2026-10-30T10:02:00.000Z").pings).toEqual([{ id: "koos-1", kind: "note" }]);
  });

  test("Automaattest's note alone pings nothing (only its Viga pings); a note on an id outside the plan earns nothing", () => {
    const auto = save(doc(), "maria-1", alone("Kõik sammud läbitud."), "2026-10-30T10:00:00.000Z", AUTO, "auto");
    expect(auto.pings).toEqual([]);
    expect(auto.recorded.auto!["maria-1"]).toEqual({ status: "note", note: "Kõik sammud läbitud.", at: "2026-10-30T10:00:00.000Z", by: AUTO });
    expect(pingsFor(doc(), doc({ ghost: noted("x") }), ["ghost"], PLAN, BUILD)).toEqual([]);
    expect(markPinged(doc({ "maria-1": noted("x") }), [{ id: "maria-1", kind: "note" }], NOW).answers["maria-1"]).toEqual({ ...noted("x"), notePinged: true });
  });
});
