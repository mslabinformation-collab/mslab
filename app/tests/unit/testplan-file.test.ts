import { describe, expect, test } from "vitest";
import plan from "@/data/testplan.json";
import { checkPlan } from "@/domain/testplan";

// The test page's plan file (phase 4, piece 1, spec §3, §8): src/data/testplan.json passes checkPlan, and checkPlan names each way a plan can
// go wrong (house style: line caps, full stops, ids, enums, marks). A mistake in the file fails this test before the page ever sees it.

// (built, so this file holds no address itself: tests/unit/test-addresses.test.ts scans every tracked file)
const FREE_MAIL = ["tester", "gmail.com"].join("@");

type Plan = {
  version?: unknown;
  marked?: unknown;
  areas: Record<string, unknown>[];
  items: Record<string, unknown>[];
};

/** A deep copy of the real plan, to break one thing in. */
const copy = (): Plan => structuredClone(plan) as unknown as Plan;
/** The first check, to break (the real plan must hold at least one). */
const first = (p: Plan) => p.items[0];
const words = (n: number) => `${Array.from({ length: n }, (_, i) => `sõna${i + 1}`).join(" ")}.`;

describe("src/data/testplan.json", () => {
  test("passes checkPlan, and holds at least one check", () => {
    expect(checkPlan(plan)).toEqual([]);
    expect(plan.items.length).toBeGreaterThan(0);
  });

  test("a notes-only area holds no check", () => {
    const noChecks = new Set(plan.areas.filter((a) => "checks" in a).map((a) => a.id));
    expect(noChecks.size).toBeGreaterThan(0);
    for (const item of plan.items) expect(noChecks.has(item.area), item.id).toBe(false);
  });
});

describe("checkPlan: one broken thing, one problem naming it", () => {
  const CASES: { name: string; break: (p: Plan) => void; named: string }[] = [
    { name: "a duplicate id", break: (p) => void p.items.push({ ...first(p) }), named: "duplicate id" },
    { name: "an id that is not kebab-case", break: (p) => void (first(p).id = "Avalik Avaleht"), named: "kebab-case" },
    { name: "an unknown area", break: (p) => void (first(p).area = "puudub"), named: "unknown area" },
    { name: "an empty steps", break: (p) => void (first(p).steps = []), named: "steps is empty" },
    { name: "an empty expect", break: (p) => void (first(p).expect = []), named: "expect is empty" },
    { name: "9 expect lines", break: (p) => void (first(p).expect = Array.from({ length: 9 }, (_, i) => `Rida ${i + 1}.`)), named: "expect has 9 lines" },
    { name: "9 steps", break: (p) => void (first(p).steps = Array.from({ length: 9 }, (_, i) => `Samm ${i + 1}.`)), named: "steps has 9 lines" },
    { name: "a 21-word step", break: (p) => void (first(p).steps = [words(21)]), named: "21 words" },
    { name: "a 21-word expect line", break: (p) => void (first(p).expect = [words(21)]), named: "21 words" },
    { name: "a 21-word why", break: (p) => void (first(p).why = words(21)), named: "why has 21 words" },
    { name: "a step without a final full stop", break: (p) => void (first(p).steps = ["Ava leht"]), named: "steps line 1 does not end with a full stop" },
    { name: "an expect line without a final full stop", break: (p) => void (first(p).expect = ["Näed lehte!"]), named: "expect line 1 does not end with a full stop" },
    { name: "a why without a final full stop", break: (p) => void (first(p).why = "Sest vaja"), named: "why does not end with a full stop" },
    { name: "an empty line", break: (p) => void (first(p).steps = ["Ava leht.", "  "]), named: "steps line 2 is empty" },
    { name: "a markedAt that is neither ISO nor deploy", break: (p) => void Object.assign(first(p), { mark: "redo", markedAt: "homme" }), named: "neither an ISO instant nor" },
    { name: "a markedAt with a date and no time", break: (p) => void Object.assign(first(p), { mark: "redo", markedAt: "2026-10-20" }), named: "neither an ISO instant nor" },
    { name: "a markedAt without a mark", break: (p) => void Object.assign(first(p), { markedAt: "2026-10-20T09:00:00.000Z" }), named: "markedAt without a mark" },
    { name: "\"deploy\" without a mark", break: (p) => void Object.assign(first(p), { markedAt: "deploy" }), named: "markedAt without a mark" },
    { name: "a mark that is none of redo / reworded / new", break: (p) => void Object.assign(first(p), { mark: "fixed" }), named: "mark \"fixed\"" },
    { name: "an href that does not start with /", break: (p) => void (first(p).href = "mslab.ee/koolitused"), named: "href" },
    { name: "an href that leaves the site (//host)", break: (p) => void (first(p).href = "//example.test/x"), named: "href" },
    { name: "a who outside the enum", break: (p) => void (first(p).who = "kati"), named: "who \"kati\"" },
    { name: "a device outside the enum", break: (p) => void (first(p).device = "kell"), named: "device \"kell\"" },
    { name: "a risk outside the enum", break: (p) => void (first(p).risk = "huge"), named: "risk \"huge\"" },
    { name: "writes that is not true or false", break: (p) => void (first(p).writes = "yes"), named: "writes must be true or false" },
    { name: "an empty title", break: (p) => void (first(p).title = " "), named: "title is empty" },
    { name: "a check in a checks:false area", break: (p) => void (first(p).area = String(p.areas.find((a) => a.checks === false)?.id)), named: "takes no checks" },
    { name: "a duplicate area id", break: (p) => void p.areas.push({ ...p.areas[0] }), named: "duplicate area id" },
    { name: "an area with checks: true", break: (p) => void (p.areas[1].checks = true), named: "checks may only be false" },
    { name: "an area without a name", break: (p) => void (p.areas[1].name = ""), named: "name is empty" },
    { name: "a version other than 1", break: (p) => void (p.version = 2), named: "version must be 1" },
    { name: "a marked that is no instant", break: (p) => void (p.marked = "16.10.2026"), named: "marked must be an ISO instant" },
    { name: "a free-mail address anywhere (here in a why)", break: (p) => void (first(p).why = `Kirjuta ${FREE_MAIL}.`), named: "free-mail" },
    { name: "a free-mail address in an area's note", break: (p) => void (p.areas[0].note = `Kirjuta ${FREE_MAIL}.`), named: "free-mail" },
  ];

  test.each(CASES)("$name", ({ break: breakIt, named }) => {
    const p = copy();
    breakIt(p);
    const problems = checkPlan(p);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(named);
  });

  test("a problem names the check it is in", () => {
    const p = copy();
    first(p).steps = [];
    expect(checkPlan(p)[0]).toContain(String(first(p).id));
  });
});

describe("checkPlan: what is fine", () => {
  test("a mark without its own markedAt (it falls back to the plan's `marked`)", () => {
    for (const mark of ["redo", "reworded", "new"]) {
      const p = copy();
      first(p).mark = mark;
      expect(checkPlan(p), mark).toEqual([]);
    }
  });

  test("a markedAt that is an ISO instant (with or without milliseconds), or \"deploy\"", () => {
    for (const markedAt of ["2026-10-20T09:00:00.000Z", "2026-10-20T09:00:00Z", "deploy"]) {
      const p = copy();
      Object.assign(first(p), { mark: "redo", markedAt });
      expect(checkPlan(p), markedAt).toEqual([]);
    }
  });

  test("a line of exactly 20 words, 8 steps and 8 expect lines, an href with a query, a notes-only area with no note", () => {
    const p = copy();
    Object.assign(first(p), {
      steps: Array.from({ length: 8 }, (_, i) => `Samm ${i + 1}.`),
      expect: [words(20), ...Array.from({ length: 7 }, (_, i) => `Rida ${i + 1}.`)],
      href: "/koolitused?vorm=e",
    });
    delete p.areas.find((a) => a.checks === false)!.note;
    expect(checkPlan(p)).toEqual([]);
  });

  test("a trailing space after the final full stop is not a missing full stop", () => {
    const p = copy();
    first(p).steps = ["Ava leht. "];
    expect(checkPlan(p)).toEqual([]);
  });
});

describe("checkPlan: a plan that is not a plan", () => {
  test.each([null, undefined, "plan", 5, []])("%j → one problem, no throw", (value) => {
    expect(checkPlan(value)).toEqual(["the plan is not an object"]);
  });

  test("areas or items missing or of the wrong kind: problems, no throw", () => {
    expect(checkPlan({ version: 1, marked: "2026-10-16T00:00:00.000Z" })).toEqual(["areas must be a list with at least one area", "items must be a list"]);
    expect(checkPlan({ version: 1, marked: "2026-10-16T00:00:00.000Z", areas: [null], items: [5] })).toEqual(["area 1 is not an object", "item 1 is not an object"]);
  });
});

// The test page shows the checks in file order and Maria and Dim walk them top to bottom (contracts Task 6, review I-1): each contract check sits
// where what it needs exists. Proov 1 registers and gets an account in `registreerimine-grupp`; Maria's ask on that registration is opened by
// `registreerimine-leping-kinnitamiseks` and stays open until `konto-leping-kinnita` answers it, so the plain contract line of that card can only be
// read after it; Proov 7 registers and signs in at `konto-arve-maksa` and is cancelled at `konto-arve-tuhistatud`, so the Russian contract check
// (which asks again and confirms) sits between them; Proov 5's free access is opened by `ekursus-ligipaas-ava` before its terms gate.
describe("the contract checks sit where their preconditions exist", () => {
  const order = plan.items.map((i) => i.id);
  const at = (id: string): number => {
    const n = order.indexOf(id);
    expect(n, id).toBeGreaterThanOrEqual(0);
    return n;
  };
  const item = (id: string) => plan.items[at(id)];
  const expectText = (id: string) => item(id).expect.join("\n");

  test("the card's plain contract line is read only after the ask on Proov 1 has been answered", () => {
    expect(at("registreerimine-grupp")).toBeLessThan(at("registreerimine-leping-kinnitamiseks"));
    expect(at("registreerimine-leping-kinnitamiseks")).toBeLessThan(at("konto-leping-kinnita"));
    expect(at("konto-leping-kinnita")).toBeLessThan(at("konto-leping-kaardil"));
    expect(expectText("konto-leping-kaardil")).toContain("tänase kuupäevaga");
  });

  test("a check that sits while the ask is open names „Kinnita leping“ as the other thing the card may show", () => {
    expect(at("konto-minu-koolitused")).toBeGreaterThan(at("registreerimine-leping-kinnitamiseks"));
    expect(at("konto-minu-koolitused")).toBeLessThan(at("konto-leping-kinnita"));
    const line = item("konto-minu-koolitused").expect.find((l) => l.includes("Leping · kinnitatud"));
    expect(line, "the contract line of konto-minu-koolitused").toBeDefined();
    expect(line).toContain("Kinnita leping");
  });

  test("nothing is superseded yet where the copy check sits: its line about a replaced contract is conditional", () => {
    expect(at("registreerimine-leping-koopia")).toBeLessThan(at("konto-leping-kinnita"));
    const line = item("registreerimine-leping-koopia").expect.find((l) => l.includes("Asendatud"));
    expect(line).toContain("kui paneelis on selline");
  });

  test("the Russian check uses Proov 7 between its registration and its cancellation", () => {
    expect(at("konto-arve-maksa")).toBeLessThan(at("konto-leping-vene-keeles"));
    expect(at("konto-leping-vene-keeles")).toBeLessThan(at("konto-arve-tuhistatud"));
    const ru = item("konto-leping-vene-keeles");
    expect(ru.steps.join("\n")).toContain("Proov 7");
    expect(ru.steps.join("\n")).not.toContain("Proov 8");
    expect(item("konto-arve-maksa").steps.join("\n")).toContain("Proov 7");
  });

  test("the sign-in each one needs is earlier: the first Proov 1 login, and Proov 5's access before its gate", () => {
    expect(at("konto-kood")).toBeLessThan(at("konto-minu-koolitused"));
    expect(at("konto-kood")).toBeLessThan(at("konto-leping-kinnita"));
    expect(at("ekursus-ligipaas-ava")).toBeLessThan(at("ekursus-tingimused-leping"));
    expect(at("ekursus-ost")).toBeLessThan(at("ekursus-tingimused"));
  });

  test("the transient sentence after „Kinnitan“ is worded as seen for a moment, then the line the card goes to", () => {
    for (const id of ["konto-leping-kinnita", "konto-leping-vene-keeles"]) {
      const line = item(id).expect.find((l) => l.includes("kinnitatud.“") || l.includes("подтверждён.“"));
      expect(line, id).toContain("hetkeks");
      expect(line, id).toContain("siis rida");
    }
  });

  test("the new checks keep their marks: new, from the deploy", () => {
    for (const id of ["konto-leping-kaardil", "konto-leping-kinnita", "konto-leping-vene-keeles"]) expect([item(id).mark, item(id).markedAt], id).toEqual(["new", "deploy"]);
  });
});
