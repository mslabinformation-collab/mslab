import { describe, expect, test } from "vitest";
import plan from "@/data/testplan.json";
import { CAMPAIGN_DAILY_ROOM, CAMPAIGN_ROOM_KEY } from "@/domain/newsletter-campaign";
import { paidMethodText } from "@/domain/invoice";
import { paymentMethodLabel } from "@/domain/payments";
import { appliesAt, checkPlan, type TestItem, type TestPlan } from "@/domain/testplan";
import { adminEt } from "@/i18n/dict/admin";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";
import { fill } from "@/i18n/format";
import { paymentAlertSummary } from "@/server/messages";

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
// A mark set on a branch reads "deploy" until the push stamps it with the push instant (tools/testplan-stamp.mjs): a guard pins the mark, and
// accepts either form of its time.
const markedSince = (markedAt: unknown) => markedAt === "deploy" || (typeof markedAt === "string" && !Number.isNaN(Date.parse(markedAt)));

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

// The test page shows the checks in file order and Maria and Dim walk them top to bottom (contracts Task 6, review I-1 and N-1): each contract check
// sits where what it needs exists. A student has NO account until somebody signs her in or Maria adds her („Lisa õpilane e-posti järgi“): the
// registration form's „Loo mulle kohe konto“ only mails a code, so a registration is not linked (no ask button, no „Õpilased“ panel) before that.
// Proov 1 registers in `registreerimine-grupp`; the first check that needs her linked, `registreerimine-leping-plokk`, adds her first. Maria's ask
// on that registration is opened by `registreerimine-leping-kinnitamiseks` and stays open until `konto-leping-kinnita` answers it, so the plain
// contract line of that card can only be read after it; Proov 7 registers and signs in (which links her) at `konto-arve-maksa` and is cancelled at
// `konto-arve-tuhistatud`, so the Russian contract check (which asks again and confirms) sits between them; Proov 5's free access is opened by
// Maria adding her in `ekursus-ligipaas-ava` before her terms gate.
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

  /** The first step, in file order, that contains all of `needles`: where it is (the check, the step's place). */
  const firstStep = (...needles: string[]) => {
    for (const id of order) {
      const n = item(id).steps.findIndex((s) => needles.every((needle) => s.includes(needle)));
      if (n >= 0) return { id, n };
    }
    return null;
  };

  test("Proov 1 has no account until Maria adds her, as the FIRST step of the first check that needs her registration linked (the ask button, her „Õpilased“ panel)", () => {
    // the form's box only mails a code: no client is made until somebody signs in or Maria adds her
    expect(item("registreerimine-grupp").expect.join("\n")).toContain("koodiga");
    const add = firstStep("Lisa õpilane e-posti järgi", "+proov1");
    expect(add).toEqual({ id: "registreerimine-leping-plokk", n: 0 });
    expect(item("registreerimine-leping-plokk").steps[1]).toContain("Vajuta „Lisa õpilane“");
    // nothing that needs her linked sits before it, and the first Proov 1 sign-in (konto-kood) is later still
    for (const id of ["registreerimine-leping-plokk", "registreerimine-leping-kinnitamiseks", "konto-minu-koolitused", "konto-leping-kinnita", "konto-leping-kaardil"]) {
      expect(at(id), id).toBeGreaterThanOrEqual(at(add!.id));
    }
    // the ask button and the „Õpilased“ panel are read after the step that adds her, within the same check
    expect(item("registreerimine-leping-plokk").steps.findIndex((s) => s.includes("Saada leping kinnitamiseks") || s.includes("voldirida „Lepingud“"))).toBeGreaterThan(0);
    expect(at("konto-kood")).toBeLessThan(at("konto-minu-koolitused"));
    expect(at("konto-kood")).toBeLessThan(at("konto-leping-kinnita"));
    expect(at("konto-kood")).toBeLessThan(at("konto-leping-kaardil"));
    // the mail's button of the ask opens the sign-in page for a device nobody has signed in on yet
    expect(expectText("registreerimine-leping-kinnitamiseks")).toContain("muidu sisselogimise lehe");
  });

  test("Proov 7 is linked by her first sign-in in konto-arve-maksa, before the Russian check; Proov 5 by Maria adding her before her gate; Proov 1's e-course is bought before its page", () => {
    const register = firstStep("Registreeri samale kuupäevale", "Proov 7");
    const signIn = firstStep("Logi sisse kui Proov 7");
    expect(register).toEqual({ id: "konto-arve-maksa", n: 0 });
    expect(signIn?.id).toBe("konto-arve-maksa");
    expect(at("konto-arve-maksa")).toBeLessThan(at("konto-leping-vene-keeles"));
    expect(firstStep("Lisa õpilane e-posti järgi", "+proov5")?.id).toBe("ekursus-ligipaas-ava");
    expect(at("ekursus-ligipaas-ava")).toBeLessThan(at("ekursus-tingimused-leping"));
    expect(at("ekursus-ost")).toBeLessThan(at("ekursus-tingimused"));
  });

  test("rulings R18, R19: Proov 5 is added by her address only, so her gate asks her name — the check says so, writes it, and expects the filled text", () => {
    // nothing before her gate gives Proov 5 a name: she is never registered nor named, only added by address and signed in
    const before = order.slice(0, at("ekursus-tingimused-leping"));
    for (const id of before) for (const step of item(id).steps) if (step.includes("Proov 5") || step.includes("+proov5")) expect(step, id).not.toMatch(/Nimi|nimi|Registreeri/);
    const gate = item("ekursus-tingimused-leping");
    const named = gate.steps.findIndex((s) => s.includes("Kirjuta „Nimi“: Proov 5"));
    expect(named, "the step that writes her name").toBeGreaterThan(0);
    // a press without the name comes before the name is written, and the start after it
    expect(gate.steps.findIndex((s) => s.includes("enne kui nime kirjutad"))).toBeLessThan(named);
    expect(gate.steps.map((s) => s === "Vajuta „Alusta koolitust“.").lastIndexOf(true)).toBeGreaterThan(named);
    for (const words of ["lepingu pealkirja", "väli „Nimi“", "„Kirjuta oma nimi.“", "{nimi} kohale", "{koolitus} asemel"]) expect(expectText("ekursus-tingimused-leping"), words).toContain(words);
    // (new when it was added; reworded since A5 folded the drawer's „Lepingud“ into a row — a reworded check never reopens an answer)
    expect(gate.mark).toBe("reworded");
    expect(markedSince(gate.markedAt), "its markedAt").toBe(true);
  });

  test("a download link whose text another row of the card repeats is named by its row (Proov 7 and Proov 1 have invoice rows with „Laadi alla (PDF)“)", () => {
    expect(item("konto-leping-vene-keeles").steps.find((s) => s.includes("Скачать (PDF)"))).toContain("Договор · подтверждён");
    expect(item("konto-leping-kaardil").steps.find((s) => s.includes("Laadi alla (PDF)"))).toContain("rea „Leping“ juures");
  });

  test("by the time Proov 1 has two mails „MS LAB leping“ (the copy, then the one from „Kinnitan“), the checks name the newest", () => {
    expect(at("registreerimine-leping-koopia")).toBeLessThan(at("konto-leping-kinnita"));
    expect(item("konto-leping-kinnita").steps.find((s) => s.includes("„MS LAB leping“"))).toContain("uusim kiri");
    expect(item("konto-leping-kinnita").expect.find((l) => l.includes("„MS LAB leping“"))).toContain("Uusim kiri");
    expect(expectText("konto-leping-kaardil")).toContain("uusimas kirjas „MS LAB leping“");
  });

  test("admin UX pass piece 3b, Task 5: the legal texts are published, never saved — the checks press „Avalda uus leping“ / „Avalda uus tekst“, and their marks say what changed", () => {
    expect(item("haldus-seaded-lepingud")).toMatchObject({ mark: "redo", title: "Seaded: kontaktkoolituse leping" });
    expect(item("haldus-seaded-tingimused")).toMatchObject({ mark: "redo", title: "Seaded: e-koolituse leping" });
    expect(item("haldus-seaded-naidisleping").mark).toBe("redo"); // (a reload shows the draft now: its last expectation changed)
    for (const id of ["ekursus-tingimused-leping", "registreerimine-leping-muutunud"]) expect(item(id).mark, id).toBe("reworded");
    for (const id of ["haldus-seaded-lepingud", "haldus-seaded-tingimused", "haldus-seaded-naidisleping", "ekursus-tingimused-leping", "registreerimine-leping-muutunud", "haldus-seaded-privaatsus-avalda"])
      expect(markedSince(item(id).markedAt), id).toBe(true);
    expect(item("registreerimine-leping-muutunud").steps.join("\n")).toContain("„Avalda uus leping“");
    expect(item("haldus-seaded-lepingud").steps.join("\n")).toContain("„Avalda uus leping“");
    expect(item("haldus-seaded-tingimused").steps.join("\n")).toContain("„Jah, avalda“");
    // the new check: the privacy text on a phone, „Muuda teksti“, published with „Avalda uus tekst“
    const privacy = item("haldus-seaded-privaatsus-avalda");
    expect(privacy).toMatchObject({ area: "haldus", who: "maria", device: "telefon", mark: "new", href: "/admin/seaded" });
    for (const words of ["„Muuda teksti“", "„Avalda uus tekst“", "„Jah, avalda“", "/privaatsus"]) expect(privacy.steps.join("\n"), words).toContain(words);
    for (const words of ["„Pikk tekst avaneb täisekraanil.“", "„Avaldamata“", "„Uus tekst on avaldatud.“"]) expect(privacy.expect.join("\n"), words).toContain(words);
    // the old words of the legal texts' save are gone from every check
    const all = plan.items.flatMap((i) => [i.title, ...i.steps, ...i.expect]);
    for (const old of ["„Salvesta lepingud“", "„Lepingud on salvestatud.“", "„E-koolituse leping (tingimused)“", "kaardini „Lepingud“", "kaardil „Lepingud“"])
      expect(all.filter((line) => line.includes(old)), old).toEqual([]);
    // and no check of a legal text tells her to save it
    for (const id of ["haldus-seaded-lepingud", "haldus-seaded-tingimused", "haldus-seaded-naidisleping", "registreerimine-leping-muutunud", "haldus-seaded-privaatsus-avalda"])
      expect(item(id).steps.filter((step) => /salvesta/i.test(step)), id).toEqual([]);
  });

  test("the transient sentence after „Kinnitan“ is worded as seen for a moment, then the line the card goes to", () => {
    for (const id of ["konto-leping-kinnita", "konto-leping-vene-keeles"]) {
      const line = item(id).expect.find((l) => l.includes("kinnitatud.“") || l.includes("подтверждён.“"));
      expect(line, id).toContain("hetkeks");
      expect(line, id).toContain("siis rida");
    }
  });

  test("the new checks keep their mark new, from the deploy or its stamp", () => {
    for (const id of ["konto-leping-kaardil", "konto-leping-kinnita", "konto-leping-vene-keeles"]) {
      expect(item(id).mark, id).toBe("new");
      expect(markedSince(item(id).markedAt), id).toBe(true);
    }
  });
});

// The student reviews' checks (student reviews, Task 4; ruling R5): Proov 1's contact review exists only once `kontakt-tagasiside` has sent her form with
// the tick, so Maria's checks of it come after, and Proov 1's e-course review (sent by `ekursus-tagasiside`) is withdrawn by `ekursus-luba-tagasi`, whose
// own steps open the „Arvustused“ view and the „Vastused“ list. The decisions run in the order the review passes through: waiting, published, on the home
// page (Task 5's checks of the public blocks sit between „Avalehel“ and „Peida“), hidden; „Lisa arvustus“ adds and deletes its own review, last. Admin
// UX pass piece 4c, Task 2: the stars and „Võta tagasi“ come before „Avalda“, on the waiting review, which they leave waiting; „Kustuta“ asks nothing
// (its „Võta tagasi“ replaced „Jah, kustuta“).
describe("the review checks sit where Proov 1's reviews exist", () => {
  const order = plan.items.map((i) => i.id);
  const at = (id: string): number => {
    const n = order.indexOf(id);
    expect(n, id).toBeGreaterThanOrEqual(0);
    return n;
  };
  const item = (id: string) => plan.items[at(id)];
  const CONTACT = ["kontakt-arvustus-toend", "kontakt-arvustus-tagasi", "kontakt-arvustus-avalda", "kontakt-arvustus-avalehel", "kontakt-arvustus-peida", "kontakt-arvustus-lisa"];

  test("Proov 1's contact review is made (with the tick) before Maria decides it; the decisions come in the order a review passes through", () => {
    expect(item("kontakt-tagasiside").steps.join("\n")).toContain("Luban seda vastust avaldada");
    for (const id of CONTACT) expect(at(id), id).toBeGreaterThan(at("kontakt-tagasiside"));
    for (const [first, second] of [["kontakt-tagasiside-haldus", "kontakt-arvustus-toend"], ...CONTACT.slice(1).map((id, i) => [CONTACT[i], id])]) expect(at(first), `${first} < ${second}`).toBeLessThan(at(second));
    // her review is hidden, shown again and deleted by Maria's own: nothing is left between them for a public block to count wrongly
    expect(item("kontakt-arvustus-peida").expect.join("\n")).toContain("Pärast „Avalda“");
    expect(item("kontakt-arvustus-lisa").steps.join("\n")).toContain("„Kustuta“, siis ribal „Võta tagasi“");
    // the undo check leaves Proov 1's review waiting for „Avalda“, as it found it
    expect(item("kontakt-arvustus-tagasi").expect.join("\n")).toContain("olek jälle „Ootab kinnitust“");
    for (const id of CONTACT) expect(text(id), id).not.toContain("Jah, kustuta");
  });

  test("the e-course review is made before the check that withdraws it, whose steps open „Arvustused“ and „Vastused“ (both exist where it sits)", () => {
    expect(at("ekursus-tagasiside")).toBeLessThan(at("ekursus-luba-tagasi"));
    const steps = item("ekursus-luba-tagasi").steps.join("\n");
    expect(steps.indexOf("„Arvustused“")).toBeGreaterThan(-1);
    expect(steps.indexOf("„Vastused“")).toBeGreaterThan(steps.indexOf("Võta luba tagasi"));
    expect(item("ekursus-luba-tagasi").expect.join("\n")).toContain("ootab Proov 1 e-koolituse arvustus kinnitust");
    // Maria's page, opened before the withdrawal and not refreshed, is pressed after it: „Seda arvustust enam pole — õpilane võttis loa tagasi.“ (reviews.spec.ts, step 5)
    const stale = steps.indexOf("seda ei ole värskendatud");
    expect(stale).toBeGreaterThan(steps.indexOf("Võta luba tagasi"));
    expect(stale).toBeLessThan(steps.indexOf("„Vastused“"));
    expect(item("ekursus-luba-tagasi").expect.join("\n")).toContain("Seda arvustust enam pole — õpilane võttis loa tagasi.");
    // the e-course card's own question, not the contact card's (Proov 1's contact card may still be there)
    expect(item("ekursus-tagasiside").expect.at(-1)).toMatch(/^E-koolituse kaardilt on „Kuidas koolitus läks\?“ kadunud/);
  });

  // Task 5: the public blocks. Proov 1's review is published and featured only between „Avalehel“ and „Peida“ (the latter ends by publishing it again), so
  // the checks that read the blocks sit there; the empty state hides it again, after „Peida“ and before „Lisa arvustus“ adds its own.
  const PUBLIC = ["kontakt-arvustus-plokk", "kontakt-arvustus-naita-koiki", "kontakt-arvustus-avaleht", "kontakt-arvustus-vene-keeles"];
  const text = (id: string) => [...item(id).steps, ...item(id).expect].join("\n");

  test("the checks of the public blocks sit between „Avalehel“ and „Peida“, where Proov 1's review is published and featured; the empty state is after „Peida“ and before „Lisa arvustus“", () => {
    for (const id of PUBLIC) {
      expect(at(id), id).toBeGreaterThan(at("kontakt-arvustus-avalehel"));
      expect(at(id), id).toBeLessThan(at("kontakt-arvustus-peida"));
    }
    expect(at("kontakt-arvustus-tyhi")).toBeGreaterThan(at("kontakt-arvustus-peida"));
    expect(at("kontakt-arvustus-tyhi")).toBeLessThan(at("kontakt-arvustus-lisa"));
    // Proov 1's review alone is on the course page for the first check (no „Näita kõiki“ yet); the second adds six and deletes them, before the others read the blocks
    expect(item("kontakt-arvustus-plokk").expect.join("\n")).toContain("Nuppu „Näita kõiki“ ei ole");
    expect(at("kontakt-arvustus-plokk")).toBeLessThan(at("kontakt-arvustus-naita-koiki"));
    expect(at("kontakt-arvustus-naita-koiki")).toBeLessThan(at("kontakt-arvustus-avaleht"));
    expect(at("kontakt-arvustus-naita-koiki")).toBeLessThan(at("kontakt-arvustus-vene-keeles"));
    const steps = item("kontakt-arvustus-naita-koiki").steps;
    const add = steps.findIndex((s) => s.startsWith("Lisa kuus arvustust"));
    const open = steps.findIndex((s) => s.includes("„Näita kõiki“ on valitud"));
    const remove = steps.findIndex((s) => s.startsWith("Kustuta halduses kõik kuus"));
    expect(add).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(add);
    expect(remove).toBeGreaterThan(open);
    expect(steps[add]).toContain("1 kuni 6"); // six, so that with Proov 1's own there are seven
    expect(text("kontakt-arvustus-naita-koiki")).toContain("„Näita kõiki (1)“");
  });

  test("ruling R9: the check that adds six reviews and presses Tab and Enter is Dim's, on a computer; the others of the public blocks are Maria's", () => {
    expect(item("kontakt-arvustus-naita-koiki").who).toBe("dim");
    expect(item("kontakt-arvustus-naita-koiki").device).toBe("arvuti");
    for (const id of ["kontakt-arvustus-plokk", "kontakt-arvustus-avaleht", "kontakt-arvustus-vene-keeles", "kontakt-arvustus-tyhi"]) expect(item(id).who, id).toBe("maria");
  });

  test("the empty state hides Proov 1's review again and leaves it hidden for what follows", () => {
    expect(item("kontakt-arvustus-tyhi").steps[0]).toContain("„Peida“");
    expect(item("kontakt-arvustus-tyhi").expect.at(-1)).toContain("„Peidetud“");
    for (const words of ["pealkirja „Õpilaste tagasiside“", "märkust", "tühja kasti", "„Õpilaste kogemused“"]) expect(text("kontakt-arvustus-tyhi"), words).toContain(words);
  });

  test("the plan quotes the dictionary's headings, notice and button, in each language", () => {
    expect(text("kontakt-arvustus-plokk")).toContain(`„${et.reviews.courseTitle}“`);
    expect(text("kontakt-arvustus-plokk")).toContain(et.reviews.notice);
    expect(text("kontakt-arvustus-avaleht")).toContain(`„${et.reviews.homeTitle}“`);
    expect(text("kontakt-arvustus-naita-koiki")).toContain(`„${et.reviews.showAll} (1)“`);
    expect(text("kontakt-arvustus-vene-keeles")).toContain(`„${ru.reviews.homeTitle}“`);
    expect(text("kontakt-arvustus-vene-keeles")).toContain(`„${ru.reviews.courseTitle}“`);
    expect(ru.reviews.notice).toContain("Отзывы оставляют ученики");
    expect(text("kontakt-arvustus-vene-keeles")).toContain("„Отзывы оставляют ученики“");
  });

  test("the public blocks' checks carry the mark new, from the deploy or its stamp; „Näita kõiki“ is reworded (piece 4c: „Kustuta“ asks nothing)", () => {
    for (const id of [...PUBLIC, "kontakt-arvustus-tyhi"]) {
      expect(item(id).mark, id).toBe(id === "kontakt-arvustus-naita-koiki" ? "reworded" : "new");
      expect(markedSince(item(id).markedAt), id).toBe(true);
    }
  });

  test("the review checks and the redone ones carry their marks, from the deploy or its stamp (piece 4c: the cards, the bars, the drawers)", () => {
    const marks: Record<string, string> = {
      "kontakt-arvustus-toend": "new",
      "kontakt-arvustus-tagasi": "new",
      "kontakt-arvustus-avalda": "redo",
      "kontakt-arvustus-avalehel": "redo",
      "kontakt-arvustus-peida": "redo",
      "kontakt-arvustus-lisa": "redo",
      "kontakt-tagasiside-haldus": "redo",
      "kirjad-maria-tagasiside": "redo",
    };
    for (const [id, mark] of Object.entries(marks)) {
      expect(item(id).mark, id).toBe(mark);
      expect(markedSince(item(id).markedAt), id).toBe(true);
    }
    for (const id of ["kontakt-arvustus-tagasi", "kontakt-arvustus-avalda", "kontakt-arvustus-avalehel", "kontakt-arvustus-peida", "kontakt-arvustus-lisa", "kontakt-tagasiside-haldus", "kontakt-arvustus-naita-koiki"]) {
      expect(item(id).markedAt, id).toBe("deploy");
    }
  });

  test("piece 4c: the plan quotes the screen's words — the bars, „Lisa arvustus +“ and its drawer, the stars — and no text that left", () => {
    const t = adminEt.reviews;
    expect(text("kontakt-arvustus-avalda")).toContain(`„${t.bar.published}“`);
    expect(text("kontakt-arvustus-tagasi")).toContain(`„${t.bar.published}“`);
    expect(text("kontakt-arvustus-tagasi")).toContain(`„${t.bar.hidden}“`);
    expect(text("kontakt-arvustus-peida")).toContain(`„${t.bar.hidden}“`);
    expect(text("kontakt-arvustus-lisa")).toContain(`„${t.bar.removed}“`);
    expect(text("kontakt-arvustus-lisa")).toContain(`„${t.add}“`);
    expect(text("kontakt-arvustus-lisa")).toContain(`„${t.form.newTitle}“`);
    expect(text("kontakt-arvustus-lisa")).toContain(`„${t.form.create}“`);
    expect(text("kontakt-arvustus-lisa")).toContain(`„${adminEt.common.cancel}“`);
    expect(text("kontakt-arvustus-tagasi")).toContain("viis tähte");
    // (S4-Q5's split, domain/review.ts starsOf: a score of 0 is one star too, not none)
    expect(text("kontakt-arvustus-tagasi")).toContain("3–4 kaks, 0–2 üks.");
    const all = plan.items.map((i) => [...i.steps, ...i.expect].join("\n")).join("\n");
    for (const gone of ["Arvustusi ootab kinnitust", "Selles vaates arvustusi pole.", "Arvustus on kustutatud."]) expect(all, gone).not.toContain(gone);
  });

  test("piece 4c Task 3: the answers' check quotes the course select, the search's empty line and the drawer's three links, and no text that left", () => {
    const t = adminEt.feedback;
    const check = text("kontakt-tagasiside-haldus");
    for (const word of [t.filterLabel, t.all, t.toReview, t.toStudent, t.toRegistration, adminEt.lists.clearAll]) expect(check, word).toContain(`„${word}“`);
    expect(check).toContain("järgi vastuseid ei leitud");
    // (the course buttons of before, and the two links' old words)
    for (const gone of ["Nuppude reas", "Õpilase juurde", "Registreeringu juurde", "Selle koolituse kohta pole tagasisidet."]) expect(plan.items.map((i) => [...i.steps, ...i.expect].join("\n")).join("\n"), gone).not.toContain(gone);
  });
});

// The newsletter's checks (newsletter campaigns, Task 4, then the 20.10 simplification: docs/superpowers/specs/2026-10-20-newsletter-simple-design.md §6):
// the list and the CSV where the Resend sync was, writing a campaign with the preview, „Saada proov“, „Saada kõigile“ (the first batch and the progress
// line), the received mail's unsubscribe, „Kopeeri“, then three checks that need a campaign larger than the day's room (Dim lowers the room by hand with the
// settings row newsletter_daily_room and deletes it after): the campaign that goes on the next day, „Peata saatmine“ and the mail program's own unsubscribe
// button — in the order a campaign lives, right after the sign-up check that makes Proov 3 a subscriber (the file is walked top to bottom). The checks that
// send are Dim's (test addresses only); the others are Maria's. Nothing in them names a list kept in Resend, a segment, a contact, a sync or a blocked mark.
describe("the newsletter checks follow the simple flow, in the order a campaign lives", () => {
  const order = plan.items.map((i) => i.id);
  const at = (id: string): number => {
    const n = order.indexOf(id);
    expect(n, id).toBeGreaterThanOrEqual(0);
    return n;
  };
  const IDS = [
    "avalik-uudiskiri-resend",
    "avalik-uudiskiri-kampaania",
    "avalik-uudiskiri-kampaania-proov",
    "avalik-uudiskiri-kampaania-muudetud",
    "avalik-uudiskiri-kampaania-saada",
    "avalik-uudiskiri-kampaania-loobu",
    "avalik-uudiskiri-kampaania-kopeeri",
    "avalik-uudiskiri-kustuta",
    "avalik-uudiskiri-kampaania-jatkub",
    "avalik-uudiskiri-kampaania-peata",
    "avalik-uudiskiri-kampaania-ykslink",
    "avalik-uudiskiri-blokeeritud-opilane",
  ];
  const item = (id: string) => {
    const found = plan.items.find((i) => i.id === id);
    expect(found, id).toBeDefined();
    return found!;
  };
  const text = (id: string) => [...item(id).steps, ...item(id).expect].join("\n");
  const t = adminEt.newsletter.campaigns;

  test("right after the sign-up check, one after another, in its area; Proov 3 is a subscriber by then", () => {
    expect(IDS.map((id) => at(id))).toEqual(IDS.map((_, n) => at("avalik-uudiskiri") + 1 + n));
    expect(item("avalik-uudiskiri").steps.join("\n")).toContain("+proov3");
    for (const id of IDS) expect(item(id).area, id).toBe(item("avalik-uudiskiri").area);
  });

  test("the ids kept their place; the checks whose meaning changed are a redo, the ones only reworded are `reworded`, the new ones `new`; a redo never weakens", () => {
    // a `redo` reopens an answer given to the check before (appliesAt). The 20.10 ones (the final review's M2): „Sünkrooni Resendiga“ became the list and
    // the CSV, the Resend blocked mark the drawer's newsletter line (both kept as they were: a mark weaker than `redo` would let an answer of the 18.10
    // version stand). Piece 3b Task 6 (README B5): writing the letter (it autosaves, „Uus kiri +“ makes the draft, the preview follows „Sisu keel“),
    // „Saada proov“ (the select, the flush before it), the edit in another tab (no „Salvesta“) and „Saada kõigile“ (its panel, the count on the button)
    // changed what is checked: redo from the deploy. „Kampaania“ → „kiri“ (P-12) and the stop's split panel are other words of the same checks.
    const redone = [
      "avalik-uudiskiri-resend",
      "avalik-uudiskiri-kampaania",
      "avalik-uudiskiri-kampaania-proov",
      "avalik-uudiskiri-kampaania-muudetud",
      "avalik-uudiskiri-kampaania-saada",
      "avalik-uudiskiri-blokeeritud-opilane",
    ];
    const reworded = ["avalik-uudiskiri-kampaania-loobu", "avalik-uudiskiri-kampaania-kopeeri", "avalik-uudiskiri-kampaania-jatkub", "avalik-uudiskiri-kampaania-peata"];
    const fresh = ["avalik-uudiskiri-kustuta", "avalik-uudiskiri-kampaania-ykslink"];
    expect([...redone, ...reworded, ...fresh].sort()).toEqual([...IDS].sort());
    for (const id of redone) {
      const check = item(id);
      expect(check.mark, id).toBe("redo");
      expect(markedSince(check.markedAt), id).toBe(true);
      expect(appliesAt(check as unknown as TestItem, plan as unknown as TestPlan, "2026-10-21T00:00:00.000Z"), id).not.toBeNull();
    }
    // Piece 3b Task 7 (README B5, Tellijad): the list check gained the search of an address, the pills „Kinnitatud“ / „Ootab kinnitust“ with their counts and
    // one „Laadi alla (CSV)“ of the current filter in place of the two fixed buttons: still a `redo` (a `reworded` would be weaker, and let an answer to
    // the old page stand), now from the deploy ("deploy" on the branch, the push instant of 26.10 once stamped).
    const atPiece3b = (markedAt: unknown) => markedAt === "deploy" || (typeof markedAt === "string" && Date.parse(markedAt) >= Date.parse("2026-10-26T00:00:00.000Z"));
    for (const id of ["avalik-uudiskiri-resend", "avalik-uudiskiri-kampaania", "avalik-uudiskiri-kampaania-proov", "avalik-uudiskiri-kampaania-muudetud", "avalik-uudiskiri-kampaania-saada"]) expect(atPiece3b(item(id).markedAt), id).toBe(true);
    for (const id of reworded) {
      expect(item(id).mark, id).toBe("reworded");
      expect(atPiece3b(item(id).markedAt), id).toBe(true);
    }
    expect(item("avalik-uudiskiri-kustuta").mark).toBe("new");
    expect(atPiece3b(item("avalik-uudiskiri-kustuta").markedAt)).toBe(true);
    expect(item("avalik-uudiskiri-kampaania-ykslink").mark).toBe("new");
    expect(text("avalik-uudiskiri-kampaania")).toContain("„Sisu keel“");
  });

  test("the confirmation of „Saada kõigile“ and the result of „Saada proov“ name the gate notice in the page's words (the final review's I1)", () => {
    expect(text("avalik-uudiskiri-kampaania-saada")).toContain(`„${t.gateNotice}“`);
    expect(text("avalik-uudiskiri-kampaania-proov")).toContain(`„${t.gateNotice}“`);
  });

  test("the sends and the mail's headers are Dim's; the list, writing, the unsubscribe from Proov 3's mailbox, „Kopeeri“ and the drawer are Maria's", () => {
    expect(IDS.map((id) => item(id).who)).toEqual(["maria", "maria", "dim", "dim", "dim", "maria", "maria", "maria", "dim", "dim", "dim", "maria"]);
    // the send goes to test addresses only: Dim stops when the list holds any other
    for (const id of ["avalik-uudiskiri-kampaania-muudetud", "avalik-uudiskiri-kampaania-saada", "avalik-uudiskiri-kampaania-jatkub", "avalik-uudiskiri-kampaania-peata"]) {
      expect(text(id), id).toContain("+proov");
      expect(text(id), id).toContain("ära jätka");
    }
    // what only reads writes nothing; what sends or saves does
    expect(IDS.map((id) => item(id).writes)).toEqual([false, true, true, true, true, true, true, true, true, true, true, false]);
  });

  test("the list check quotes the page's words: the tab, the search, the two pills, the count line, the one CSV button and the other view", () => {
    const n = adminEt.newsletter;
    expect(item("avalik-uudiskiri-resend").title).toBe("Tellijate loend ja CSV");
    expect(text("avalik-uudiskiri-resend")).toContain(`„${n.csvDownload}“`);
    expect(text("avalik-uudiskiri-resend")).toContain(`„${n.searchPlaceholder}“`);
    expect(text("avalik-uudiskiri-resend")).toContain(`„${n.col.confirmed}“`);
    expect(text("avalik-uudiskiri-resend")).toContain(`„${n.pending}“`);
    expect(text("avalik-uudiskiri-resend")).toContain(`„${n.count.replace("{n}", "…").replace("{confirmed}", "…")}“`);
    expect(text("avalik-uudiskiri-resend")).toContain(`„${n.views.subscribers}“`);
    expect(text("avalik-uudiskiri-resend")).toContain(`„${n.views.campaigns}“`);
    // the two fixed buttons of the old page are gone from the words (piece 3b Task 7): one button, named for the filter it takes
    expect(text("avalik-uudiskiri-resend")).not.toMatch(/Lae alla|kaks allalaadimise nuppu/);
  });

  test("they quote the page's and the mail's words: the editor, the buttons, the confirmation, the sent line, the test page and the footer", () => {
    const n = adminEt.newsletter;
    expect(adminEt.newsletter.views.campaigns).toBe("Kirjad");
    expect(text("avalik-uudiskiri-kampaania")).toContain(`„${n.views.campaigns}“`);
    expect(text("avalik-uudiskiri-kampaania")).toContain(`„${t.new} +“`);
    expect(text("avalik-uudiskiri-kampaania")).toContain(`„${t.newTitle}“`);
    expect(text("avalik-uudiskiri-kampaania")).toContain(`„${t.name}“`);
    expect(text("avalik-uudiskiri-kampaania")).toContain(`„${adminEt.autosave.saved.replace("{time}", "…")}“`);
    expect(text("avalik-uudiskiri-kampaania")).toContain(`„${t.row.draft.replace("{date}", "…")}“`);
    expect(item("avalik-uudiskiri-kampaania-proov").title).toBe("Saada proov"); // (the spec's)
    expect(text("avalik-uudiskiri-kampaania-proov")).toContain(`„${t.testPage}“`);
    expect(text("avalik-uudiskiri-kampaania-proov")).toContain("„[Proov] Proov 3 pakkumine“");
    expect(text("avalik-uudiskiri-kampaania-proov")).toContain(`„${ru.mail.campaign.unsubscribe}“`);
    // the send check is "the first batch and the progress line" (spec §6); „Saada kõigile“ (the spec's) is its start
    expect(item("avalik-uudiskiri-kampaania-saada").title).toBe("Saada kõigile: esimene partii ja edenemise rida");
    expect(text("avalik-uudiskiri-kampaania-saada")).toContain(`„${t.all.button.replace("{n}", "…")}“`);
    expect(text("avalik-uudiskiri-kampaania-saada")).toContain(`„${t.all.yes.replace("{n}", "…")}“`);
    expect(text("avalik-uudiskiri-kampaania-saada")).toContain(`„${t.progress.replace("{sent}", "…").replace("{n}", "…").replace("{left}", "…")}“`);
    expect(text("avalik-uudiskiri-kampaania-saada")).toContain(`„${t.stop.button}“`);
    expect(text("avalik-uudiskiri-kampaania-saada")).toContain(`„${t.all.question.replace("{name}", "Proov 3 kiri")}“`); // (P-13)
    expect(text("avalik-uudiskiri-kampaania-saada")).toContain("@example.test"); // (B9: the count leaves the sample addresses out)
    expect(text("avalik-uudiskiri-kampaania-saada")).toContain(`„${t.sentLine.replace("{date}", "…").replace("{n}", "…")}“`);
    expect(text("avalik-uudiskiri-kampaania-saada")).toContain(`„${t.errorsOf.sent}“`);
    expect(text("avalik-uudiskiri-kampaania-saada")).toContain("„Proov 3 pakkumine“");
    expect(text("avalik-uudiskiri-kampaania-saada")).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click"); // the mail program's own button
    expect(text("avalik-uudiskiri-kampaania-loobu")).toContain(`„${et.mail.campaign.reason}“`);
    expect(text("avalik-uudiskiri-kampaania-loobu")).toContain(`„${et.mail.campaign.unsubscribe}“`);
    expect(text("avalik-uudiskiri-kampaania-loobu")).toContain(`„${et.newsletter.unsubscribePage.heading}“`);
    expect(item("avalik-uudiskiri-kampaania-kopeeri").title).toBe(t.copy);
    expect(text("avalik-uudiskiri-kampaania-kopeeri")).toContain(`„Proov 3 kiri${t.copySuffix}“`);
    expect(text("avalik-uudiskiri-kampaania-proov")).toContain(`„… · ${t.test.optionLang.et}“`);
    expect(text("avalik-uudiskiri-kampaania-proov")).toContain(`„… · ${t.test.optionLang.ru}“`);
  });

  test("„Kustuta mustand“ (B17): Maria's, after „Kopeeri“, in the words of S3-P3-f; a sent letter has no such button", () => {
    const id = "avalik-uudiskiri-kustuta";
    expect(item(id)).toMatchObject({ area: "avalik", who: "maria", device: "arvuti", writes: true, risk: "low", href: "/admin/uudiskiri?vaade=kampaaniad", title: t.remove.button });
    expect(at(id)).toBe(at("avalik-uudiskiri-kampaania-kopeeri") + 1);
    expect(text(id)).toContain(`„${t.remove.question.replace("{name}", "Proov 3 kustuta")}“`);
    for (const word of [t.remove.line, t.remove.yes, adminEt.common.cancel, t.remove.done, `${t.new} +`]) expect(text(id), word).toContain(`„${word}“`);
    // its own draft, so the copy the next checks send is never the one deleted
    expect(text(id)).not.toContain("koopia");
    expect(item(id).expect.at(-1)).toContain(`„${t.remove.button}“ pole`);
  });

  /** The row Dim sets and deletes by hand, as the check says it (the statement names the real key). */
  const lowers = (id: string, room: number) =>
    item(id).steps.some((s) => s.includes(`insert into settings (key, value) values ('${CAMPAIGN_ROOM_KEY}', '${room}')`) && s.includes("on conflict (key) do update set value = excluded.value"));
  const unlowers = (id: string) => item(id).steps.some((s) => s.includes(`delete from settings where key = '${CAMPAIGN_ROOM_KEY}'`));
  const NEXT = "avalik-uudiskiri-kampaania-jatkub";
  const STOP = "avalik-uudiskiri-kampaania-peata";
  const ONE_CLICK = "avalik-uudiskiri-kampaania-ykslink";

  test("a campaign larger than the day's room continues the next day: Dim lowers the room to 2 by hand, three subscribers, then deletes the row and runs the daily job", () => {
    expect(item(NEXT)).toMatchObject({ area: "avalik", who: "dim", writes: true, mark: "reworded", href: "/admin/uudiskiri?vaade=kampaaniad" });
    expect(markedSince(item(NEXT).markedAt)).toBe(true);
    // the room is the settings row the engine reads, set to 2 and deleted afterwards (never left behind), and lower than the day's room
    expect(lowers(NEXT, 2)).toBe(true);
    expect(unlowers(NEXT)).toBe(true);
    expect(2).toBeLessThan(CAMPAIGN_DAILY_ROOM);
    const steps = item(NEXT).steps;
    const press = steps.findIndex((s) => s.includes(`„${t.all.yes.replace("{n}", "…")}“`));
    expect(press).toBeGreaterThanOrEqual(0);
    expect(steps.findIndex((s) => s.includes("insert into settings"))).toBeLessThan(press);
    expect(press).toBeLessThan(steps.findIndex((s) => s.includes("delete from settings")));
    expect(steps.findIndex((s) => s.includes("delete from settings"))).toBeLessThan(steps.findIndex((s) => s.includes("/api/cron/uudiskiri")));
    // three subscribers of his own (Proov 3 left the list in the unsubscribe check), the daily job's address and its secret
    for (const address of ["+proov3,", "+proov3b", "+proov3c"]) expect(steps.join("\n"), address).toContain(address);
    // the daily job is run so that Dim can follow it exactly: Vercel's own button first (it sends the secret itself), else one curl line with the
    // header, the host and where the secret is found; the answer is told
    const cron = steps.filter((s) => s.includes("/api/cron/uudiskiri"));
    expect(cron).toHaveLength(2);
    expect(cron[0]).toContain("Vercelis");
    expect(cron[0]).toContain("Settings → Cron Jobs");
    expect(cron[0]).toContain("„Run“");
    expect(cron[1]).toContain('curl -H "Authorization: Bearer <CRON_SECRET Verceli keskkonnamuutujatest>" https://mslab.ee/api/cron/uudiskiri');
    expect(item(NEXT).expect.join(" ")).toContain("200");
    expect(item(NEXT).expect.join(" ")).toContain("401");
    // the SQL says where it runs: Railway's Postgres, the way docs/deploy.md §6 connects, the address in the shell only
    expect(steps.some((s) => s.includes("Railway Postgresiga") && s.includes("docs/deploy.md peatükis 6") && s.includes("ainult kestas"))).toBe(true);
    expect(steps.findIndex((s) => s.includes("Railway Postgresiga"))).toBeLessThan(steps.findIndex((s) => s.includes("insert into settings")));
    // and the row goes even if the check is stopped half way (a row left behind throttles every campaign to that many a day)
    expect(steps.find((s) => s.includes("delete from settings"))).toContain("ka kontrolli katkestades");
    // what he sees: two of three went and the rest waits (the progress line), the campaign is going out, then the third goes and it is sent
    expect(text(NEXT)).toContain(`„${t.progress.replace("{sent}", "2").replace("{n}", "…").replace("{left}", "…")}“`);
    expect(text(NEXT)).toContain(`„${t.row.sending.replace("{sent}", "2").replace("{n}", "…")}“`);
    expect(text(NEXT)).toContain(`„${t.stop.button}“`);
    expect(text(NEXT)).toContain(`„${t.sentLine.replace("{date}", "…").replace("{n}", "3")}“`);
    // it sends the draft that "Kopeeri" left (subject „Proov 3 koopia“), so it sits after that check
    expect(text("avalik-uudiskiri-kampaania-kopeeri")).toContain("Proov 3 koopia");
    expect(text(NEXT)).toContain(`„Proov 3 kiri${t.copySuffix}“`);
    expect(text(NEXT)).toContain("„Proov 3 koopia“");
    expect(at("avalik-uudiskiri-kampaania-kopeeri")).toBeLessThan(at(NEXT));
    expect(item(NEXT).risk).toBe("med");
  });

  test("„Peata saatmine“: the room lowered to 1, the question with the number that will not go, „Ei“ then „Jah, peata“, the row deleted", () => {
    expect(item(STOP)).toMatchObject({ area: "avalik", who: "dim", writes: true, mark: "reworded", title: t.stop.button });
    expect(markedSince(item(STOP).markedAt)).toBe(true);
    expect(lowers(STOP, 1)).toBe(true);
    expect(unlowers(STOP)).toBe(true);
    // the same Railway database, the same deletion even when stopped; and one campaign at a time: the check before must be finished first
    expect(item(STOP).steps.some((s) => s.includes("Railway Postgresiga") && s.includes("docs/deploy.md peatükis 6") && s.includes("ainult kestas"))).toBe(true);
    expect(item(STOP).steps.find((s) => s.includes("delete from settings"))).toContain("ka kontrolli katkestades");
    const before = item(STOP).steps.findIndex((s) => s.includes("eelmise kontrolli kiri") && s.includes("lõpeta see enne"));
    expect(before).toBeGreaterThanOrEqual(0);
    expect(item(STOP).steps[before]).toContain(`„${t.row.sending.split(" · ")[0]}“`);
    expect(before).toBeLessThan(item(STOP).steps.findIndex((s) => s.includes(`„${t.all.button.replace("{n}", "…")}“`)));
    // the ConfirmPanel's question and its line (P-13's split), and its „Katkesta“
    expect(text(STOP)).toContain(`„${t.stop.question}“`);
    expect(text(STOP)).toContain(`„${t.stop.left.replace("{n}", "…")}“`);
    for (const word of [t.stop.button, t.stop.yes, adminEt.common.cancel, t.copy]) expect(text(STOP), word).toContain(`„${word}“`);
    expect(text(STOP)).toContain(`„${t.row.sending.replace("{sent}", "1").replace("{n}", "…")}“`);
    expect(text(STOP)).toContain(`„${t.progress.replace("{sent}", "1").replace("{n}", "…").replace("{left}", "…")}“`);
    expect(text(STOP)).toContain(`„${t.sentLine.replace("{date}", "…").replace("{n}", "1")}“`);
    // it copies the campaign of the check before (sent by then) and presses the copy: it follows that check
    expect(at(NEXT)).toBeLessThan(at(STOP));
    expect(item(STOP).steps.join("\n")).toContain(`„Proov 3 kiri${t.copySuffix}“`);
  });

  test("the mail program's own unsubscribe button: on a mail of the campaign that went out, it removes the address from the list; the others leave by the link", () => {
    expect(item(ONE_CLICK)).toMatchObject({ area: "avalik", who: "dim", writes: true, mark: "new", href: "/admin/uudiskiri" });
    expect(markedSince(item(ONE_CLICK).markedAt)).toBe(true);
    expect(text(ONE_CLICK)).toContain("List-Unsubscribe-Post");
    expect(text(ONE_CLICK)).toContain(`„${et.mail.campaign.unsubscribe}“`);
    expect(text(ONE_CLICK)).toContain("+proov3b");
    expect(text(ONE_CLICK)).toContain("„Proov 3 koopia“");
    expect(at(STOP)).toBeLessThan(at(ONE_CLICK));
    // it leaves the three test subscribers gone, so the list is as it was before the three checks
    expect(item(ONE_CLICK).expect.join("\n")).toContain("Loendis pole ühtegi kolmest +proov3 aadressist.");
  });

  test("the checks that need three subscribers do not touch Proov 1, whose account and subscription come later", () => {
    for (const id of [NEXT, STOP, ONE_CLICK]) expect(text(id), id).not.toMatch(/Proov 1(?!\d)/);
    for (const id of [NEXT, STOP, ONE_CLICK]) expect(at(id), id).toBeLessThan(at("registreerimine-leping-plokk"));
  });

  test("the edit in another tab changes only the preview line, so the send's check after it still finds its subject", () => {
    expect(at("avalik-uudiskiri-kampaania-muudetud")).toBeLessThan(at("avalik-uudiskiri-kampaania-saada"));
    expect(text("avalik-uudiskiri-kampaania-muudetud")).toContain("„Eelvaate rida“");
    expect(text("avalik-uudiskiri-kampaania-muudetud")).toContain(`„${t.all.button.replace("{n}", "…")}“`);
    expect(text("avalik-uudiskiri-kampaania-muudetud")).toContain("midagi ei saadetud");
  });

  test("the student's drawer check reads her newsletter line and nothing about a blocked address", () => {
    const line = adminEt.clients.drawer.newsletter.replace(": {state}", "");
    expect(item("avalik-uudiskiri-blokeeritud-opilane")).toMatchObject({ area: "avalik", who: "maria", writes: false, href: "/admin/opilased" });
    expect(text("avalik-uudiskiri-blokeeritud-opilane")).toContain(`„${line}: …“`);
    // it sits at 24, long before Proov 1 has an account (registreerimine-leping-plokk): it asks for any student, and skips when there is none
    expect(order.indexOf("avalik-uudiskiri-blokeeritud-opilane")).toBeLessThan(order.indexOf("registreerimine-leping-plokk"));
    expect(text("avalik-uudiskiri-blokeeritud-opilane")).not.toContain("Proov 1");
    expect(item("avalik-uudiskiri-blokeeritud-opilane").steps.join("\n")).toContain("jäta kontroll vahele");
    for (const state of Object.values(adminEt.clients.drawer.newsletterStates)) expect(text("avalik-uudiskiri-blokeeritud-opilane")).toContain(`„${state}“`);
  });

  test("no newsletter check names a list kept in Resend, a segment, a contact, a sync, a blocked mark, „Märgi saatmata“ or „Saada puuduv keel“", () => {
    for (const id of IDS) {
      const all = [item(id).title, ...item(id).steps, ...item(id).expect, item(id).why].join("\n");
      expect(all, id).not.toMatch(/Resend|segment|kontakt|Sünkroon|sünkroon|blokeeri|Märgi saatmata|Saada puuduv keel/);
    }
  });

  test("the welcome mail's unsubscribe still has a subscriber to remove: Proov 1, subscribed by „Minu andmed“ before it; Proov 3 is gone by then (review M9)", () => {
    const welcome = item("kirjad-tervituskiri");
    expect(welcome.steps[0]).toContain("Proov 1");
    expect(welcome.expect.join("\n")).toContain("pole Proov 1 aadressi");
    // admin UX pass piece 4b (S4-Q3 A): the mail says how long the code is valid, when Hüpikaken has the days — to be checked again
    expect(welcome.expect.join("\n")).toContain("„Kood kehtib … päeva.“");
    expect(welcome.mark).toBe("redo");
    expect(markedSince(welcome.markedAt)).toBe(true);
    // Proov 3 unsubscribes in the campaign check, before the welcome mail's; Proov 1 subscribes in konto-andmed, between the two
    expect(at("avalik-uudiskiri-kampaania-loobu")).toBeLessThan(at("konto-andmed"));
    expect(at("konto-andmed")).toBeLessThan(at("kirjad-tervituskiri"));
    expect(item("konto-andmed").steps.join("\n")).toContain("„Saada mulle uudiskirja“");
    // and nothing between them takes Proov 1 off the list
    for (const id of order.slice(at("konto-andmed") + 1, at("kirjad-tervituskiri"))) expect(text(id), id).not.toMatch(/Loobu uudiskirjast|uudiskirja(st)? (välja|loobu)/);
  });
});

describe("the page's language switch (admin UX pass, Task 12)", () => {
  const find = (id: string) => {
    const found = plan.items.find((i) => i.id === id);
    expect(found, id).toBeDefined();
    return found!;
  };
  const whole = (id: string) => [...find(id).steps, ...find(id).expect].join("\n");
  const t = adminEt.i18n;

  test("„Sisu keel lehe päises“ is a check in Haldus (reworded in piece 4a: Avaleht's answers fold), quoting the switch's words as the page shows them", () => {
    const check = find("haldus-keel-lehel");
    expect(check).toMatchObject({ area: "haldus", who: "maria", writes: false, mark: "reworded", href: "/admin/avaleht" });
    expect(markedSince(check.markedAt)).toBe(true); // "deploy" on the branch, the push instant once stamped
    for (const word of [t.contentLang, t.lang.et, t.lang.ru, t.next, t.copyFromEt, t.missing, t.etTag]) expect(whole("haldus-keel-lehel"), word).toContain(`„${word}“`);
    expect(whole("haldus-keel-lehel")).toContain(`„${t.ruMissing.replace("{n} ", "… ")}“`);
  });

  test("it makes its own gap: two Russian texts are emptied (into Avaleht's draft) and thrown away at the end, so the count, „Järgmine →“ and the copy show whatever the data is; it says the line counts closed slides and folded answers", () => {
    const steps = find("haldus-keel-lehel").steps;
    const all = steps.join("\n");
    // (piece 4a, Task 6: a FAQ answer is folded behind ▸, and what is typed waits in the draft; „Loobu muudatustest“ leaves the site as it was)
    expect(all).toContain("Vajuta esimese küsimuse real ▸, tühjenda küsimuse ja vastuse vene tekst ja vajuta uuesti ▸.");
    expect(all.indexOf("tühjenda")).toBeLessThan(all.indexOf(`„${t.next}“`));
    expect(all.indexOf("tühjenda")).toBeLessThan(all.indexOf(`„${t.copyFromEt}“`));
    expect(steps.at(-1)).toBe(`Vajuta ribal „${adminEt.publish.discard}“ ja kinnita.`);
    expect(find("haldus-keel-lehel").writes).toBe(false);
    expect(find("haldus-keel-lehel").expect.join("\n")).toContain("kinniste slaidide ja kokkuvolditud vastuste väljad");
  });

  test("a check that goes to RU ends with „ET“ under „Sisu keel“: the device keeps the language, and the next check starts in Estonian", () => {
    for (const id of ["haldus-ru-tekst", "haldus-seaded-lepingud", "haldus-seaded-naidisleping", "avalik-uudiskiri-kampaania", "haldus-keel-lehel"]) {
      const mentions = find(id).steps.filter((s) => s.includes(`„${t.contentLang}“`));
      const last = mentions[mentions.length - 1];
      expect(last, id).toContain(`„${t.lang.et}“`);
      expect(last, id).not.toContain(t.lang.ru);
    }
    // what comes right after the campaign check edits the copy's Estonian „Teema“: nothing between puts it back in Russian
    const order = plan.items.map((i) => i.id);
    expect(order.indexOf("avalik-uudiskiri-kampaania-kopeeri")).toBeGreaterThan(order.indexOf("avalik-uudiskiri-kampaania"));
  });

  test("„Venekeelne tekst“ is reworded, not extended: its expectations are the ones it had", () => {
    expect(find("haldus-ru-tekst").expect).toEqual([
      "Tühja vene välja juures on märge „tõlge tulekul“.",
      "Vene lehel on siis näha eestikeelne tekst.",
      "Täidetud vene tekst on vene lehel näha.",
    ]);
  });

  test("the checks that switched a field's language by its own pills name the page's „Sisu keel“ now, and are reworded (no answer reopens)", () => {
    for (const id of ["haldus-ru-tekst"]) {
      const check = find(id);
      expect(check.mark, id).toBe("reworded");
      expect(markedSince(check.markedAt), id).toBe(true);
      expect(find(id).steps.join("\n"), id).toContain(`„${t.contentLang}“`);
      expect(appliesAt(check as unknown as TestItem, plan as unknown as TestPlan, "2026-10-21T00:00:00.000Z"), id).toBeNull();
    }
    // checks rewritten since, still with „Sisu keel“: the two contract cards' (admin UX pass piece 3b, Task 5: drafts and „Avalda uus leping“) and
    // writing a letter (Task 6: it autosaves, „Uus kiri +“ makes the draft, the preview follows the switch): redo
    for (const id of ["haldus-seaded-lepingud", "haldus-seaded-naidisleping", "avalik-uudiskiri-kampaania"]) {
      expect(find(id).mark, id).toBe("redo");
      expect(find(id).steps.join("\n"), id).toContain(`„${t.contentLang}“`);
    }
    // no check sends her to a switch on a field any more
    expect(plan.items.flatMap((i) => i.steps).filter((s) => /välja „[^“]+“ juures „RU“/.test(s))).toEqual([]);
  });
});

describe("the instalments checks (instalments, Task 8)", () => {
  const order = plan.items.map((i) => i.id);
  const at = (id: string): number => {
    const n = order.indexOf(id);
    expect(n, id).toBeGreaterThanOrEqual(0);
    return n;
  };
  const item = (id: string) => plan.items[at(id)];
  const text = (id: string) => [item(id).title, ...item(id).steps, ...item(id).expect].join("\n");
  const area = (id: string) => plan.areas.find((a) => a.id === id)!;

  // the new checks and where they sit. `haldus-maksed-jarelmaks` keeps the id the brief gave it and sits in „Registreerimine ja maksmine“, after the
  // registrations (Proov 9 and Proov 10) whose payments it reads.
  const NEW: Record<string, { area: string; who: string; writes: boolean }> = {
    "haldus-seaded-jarelmaks": { area: "haldus", who: "dim", writes: false },
    "avalik-kursus-jarelmaks-rida": { area: "avalik", who: "maria", writes: false },
    "registreerimine-jarelmaks-kinnitatud": { area: "registreerimine", who: "dim", writes: true },
    "registreerimine-jarelmaks-keeldus": { area: "registreerimine", who: "dim", writes: true },
    "registreerimine-jarelmaks-nupud": { area: "registreerimine", who: "maria", writes: true },
    "registreerimine-jarelmaks-vahepeal-valja": { area: "registreerimine", who: "dim", writes: true },
    "registreerimine-jarelmaks-hiline": { area: "registreerimine", who: "dim", writes: true },
    "haldus-maksed-jarelmaks": { area: "registreerimine", who: "dim", writes: false },
    "ekursus-jarelmaks": { area: "ekursus", who: "dim", writes: true },
  };

  // B22 (admin UX pass, piece 2: one open order per registration) changed what four of them see: they are to be run again (below)
  const REDONE_BY_B22 = new Set(["registreerimine-jarelmaks-keeldus", "registreerimine-jarelmaks-vahepeal-valja", "registreerimine-jarelmaks-hiline", "haldus-maksed-jarelmaks"]);
  // the two that say what a student sees when the toggle is switched off meanwhile: reworded in the follow-up (financing texts, 22.10) after the first
  // deploy, from the range sentence to the switched-off one. What they expect changed, so they are redo since that deploy.
  const REDONE = ["registreerimine-jarelmaks-nupud", "registreerimine-jarelmaks-vahepeal-valja"];
  // admin UX pass piece 3b, Task 4: the toggle autosaves (no „Salvesta“): its own check is to be run again, and two that switched it and saved it are
  // reworded (they no longer say „salvesta“)
  const REDONE_BY_SEADED = new Set(["haldus-seaded-jarelmaks"]);
  const REWORDED_BY_SEADED = new Set(["avalik-kursus-jarelmaks-rida", "ekursus-jarelmaks"]);

  test("each is a new check marked since the deploy, in its area, run by whom the sandbox or the toggle needs", () => {
    for (const [id, want] of Object.entries(NEW)) {
      if (REDONE.includes(id)) continue;
      const redo = REDONE_BY_B22.has(id) || REDONE_BY_SEADED.has(id);
      expect(item(id), id).toMatchObject({ ...want, mark: redo ? "redo" : REWORDED_BY_SEADED.has(id) ? "reworded" : "new" });
      expect(markedSince(item(id).markedAt), id).toBe(true); // "deploy" on the branch, the push instant once stamped
      // a new or reworded check never reopens an answer
      if (!redo) expect(appliesAt(item(id) as unknown as TestItem, plan as unknown as TestPlan, "2026-10-25T00:00:00.000Z"), id).toBeNull();
    }
  });

  test("the checks that switch the toggle off meanwhile are redo since the follow-up's deploy, in their area, run by whom they were", () => {
    for (const id of REDONE) {
      expect(item(id), id).toMatchObject({ ...NEW[id], mark: "redo" });
      // "deploy" until the stamp, then the deploy instant (section 15 item 3)
      const markedAt = item(id).markedAt;
      expect(markedSince(markedAt), id).toBe(true);
      // an answer given before the follow-up's deploy no longer stands: it was given for the old sentence
      const deployAt = "2026-10-25T00:00:00.000Z";
      expect(appliesAt(item(id) as unknown as TestItem, plan as unknown as TestPlan, deployAt), id).toBe(markedAt === "deploy" ? deployAt : markedAt);
    }
  });

  test("a student whose järelmaks was switched off meanwhile is told it is not available now: the checks say that sentence, never the range", () => {
    for (const id of REDONE) {
      expect(text(id), id).toContain(`„${et.forms.payFinancingOff}“`);
      expect(text(id), id).not.toContain(et.forms.payFinancingRange);
    }
    // (the range sentence is for a price outside 100–5000 €, which no check edits a price to see)
    expect(plan.items.flatMap((c) => [...c.steps, ...c.expect]).filter((l) => l.includes(et.forms.payFinancingRange))).toEqual([]);
  });

  test("Seaded's toggle comes before every check that needs it on; the course-page check, which comes first, switches it on itself", () => {
    const needs = Object.keys(NEW).filter((id) => !["haldus-seaded-jarelmaks", "avalik-kursus-jarelmaks-rida"].includes(id));
    for (const id of needs) expect(at("haldus-seaded-jarelmaks"), id).toBeLessThan(at(id));
    expect(at("avalik-kursus-jarelmaks-rida")).toBeLessThan(at("haldus-seaded-jarelmaks"));
    expect(item("avalik-kursus-jarelmaks-rida").steps[0]).toMatch(/Seaded → „Järelmaks \(Inbank\)“ sisse;/);
    // (the switch saves itself since piece 3b, Task 4: no step of a järelmaks check tells to „salvesta“, whatever it calls the switch — „Järelmaks
    // (Inbank)“, „seade“ — and no check or area note names the cards „Arve andmed“ / „Ettemaksu juhised“ or the old titles of their checks (P-9))
    const financingChecks = plan.items.filter((c) => /järelmaks/i.test([c.title, ...c.steps, ...c.expect].join("\n")));
    expect(financingChecks.flatMap((c) => c.steps.map((l) => `${c.id}: ${l}`)).filter((l) => /\bsalvesta\b/i.test(l))).toEqual([]);
    const OLD_NAMES = /„Arve andmed“|„Ettemaksu juhised“|Seaded → Arve andmed|Seaded: arve andmed|Seaded: ettemaksu juhised/;
    expect(plan.items.flatMap((c) => [c.title, ...c.steps, ...c.expect].filter((l) => OLD_NAMES.test(l)).map((l) => `${c.id}: ${l}`))).toEqual([]);
    expect(plan.areas.filter((a) => OLD_NAMES.test(String(a.note))).map((a) => a.id)).toEqual([]);
    // the Maksed check reads the payments of Proov 9 and Proov 10 and the cancelled bank payment of Proov 2 or Proov 13 (the registration's cancelled
    // payment, or the e-course cart's after Seaded was switched off): all are made before it. Proov 11 is the e-course's, made after it (area ekursus)
    expect(at("registreerimine-jarelmaks-kinnitatud")).toBeLessThan(at("haldus-maksed-jarelmaks"));
    expect(at("registreerimine-jarelmaks-keeldus")).toBeLessThan(at("haldus-maksed-jarelmaks"));
    expect(at("registreerimine-pooleli")).toBeLessThan(at("haldus-maksed-jarelmaks"));
    expect(at("registreerimine-jarelmaks-vahepeal-valja")).toBeLessThan(at("haldus-maksed-jarelmaks"));
    expect(text("registreerimine-pooleli")).toContain("Proov 2");
    expect(text("registreerimine-jarelmaks-vahepeal-valja")).toMatch(/Proov 13(?!\d)[^]*katkesta makse testpangas/);
    expect(text("haldus-maksed-jarelmaks")).not.toMatch(/Proov 11(?!\d)/);
    // a cancel at the sandbox bank may leave the order pending, so the failed row is looked for under both filters; older rows have no method
    expect(text("haldus-maksed-jarelmaks")).toContain("Vajuta filtritel „Ebaõnnestunud“ ja „Pooleli“ ning vaata rida, mille makse katkestati testpangas (Proov 2 või Proov 13).");
    expect(text("haldus-maksed-jarelmaks")).toContain("ükskõik kas pooleli või ebaõnnestunud");
    expect(text("haldus-maksed-jarelmaks")).toContain("varem tehtud ridade summa all pole midagi");
  });

  test("the toggle card's expectation is not „unticked“: the course-page check, which comes first, has ticked and saved it already", () => {
    expect(item("haldus-seaded-jarelmaks").expect[0]).toBe("Kaardil on pealkiri „Järelmaks (Inbank)“ ja ruut „Paku järelmaksu (Inbank)“.");
    expect(text("haldus-seaded-jarelmaks")).not.toContain("enne esimest salvestamist märkimata");
  });

  test("the registration area's note says Inbank should reject 901–1000 €, not that it does (still to be confirmed for Estonia: deploy.md section 21 item 3)", () => {
    expect(String(area("registreerimine").note)).toContain("901–1000 € taotluse peaks Inbank tagasi lükkama.");
    expect(String(area("registreerimine").note)).not.toContain("lükatakse tagasi");
  });

  test("the sandbox checks give Montonio's test person, the SMS code, an Estonian phone and the amounts Inbank decides by", () => {
    for (const id of ["registreerimine-jarelmaks-kinnitatud", "registreerimine-jarelmaks-keeldus", "registreerimine-jarelmaks-hiline", "ekursus-jarelmaks"]) {
      expect(text(id), id).toContain("10101010005");
      expect(text(id), id).toContain("SMS-kood 0000");
    }
    for (const id of ["registreerimine-jarelmaks-kinnitatud", "registreerimine-jarelmaks-keeldus", "registreerimine-jarelmaks-hiline"]) expect(text(id), id).toContain("Eesti");
    expect(text("registreerimine-jarelmaks-kinnitatud")).toContain("100–500 €");
    expect(text("registreerimine-jarelmaks-keeldus")).toContain("901–1000 €");
    expect(text("registreerimine-jarelmaks-hiline")).toContain("501–700 €");
    // the area says all three, once
    for (const amount of ["100–500 €", "501–700 €", "901–1000 €"]) expect(String(area("registreerimine").note), amount).toContain(amount);
    // each Proov is one check's: 9 approved, 10 declined, 11 the cart, 12 the two buttons, 13 switched off meanwhile, 14 the late loan, 15 the
    // replaced loan (B22)
    const proov = {
      "registreerimine-jarelmaks-kinnitatud": 9,
      "registreerimine-jarelmaks-keeldus": 10,
      "ekursus-jarelmaks": 11,
      "registreerimine-jarelmaks-nupud": 12,
      "registreerimine-jarelmaks-vahepeal-valja": 13,
      "registreerimine-jarelmaks-hiline": 14,
      "haldus-maksed-asendatud": 15,
    };
    for (const [id, n] of Object.entries(proov)) {
      expect(text(id), id).toMatch(new RegExp(`Proov ${n}(?!\\d)`));
      expect(text(id), id).toContain(`+proov${n}`);
      for (const other of Object.values(proov).filter((m) => m !== n)) expect(text(id), `${id} vs Proov ${other}`).not.toMatch(new RegExp(`Proov ${other}(?!\\d)`));
    }
    expect(String(area("enne").note)).toContain("Proov 9 kuni Proov 15");
  });

  test("the words the checks quote are the site's own", () => {
    const s = adminEt.financing.settings;
    for (const word of [s.title, s.enabled, s.lead]) expect(text("haldus-seaded-jarelmaks"), word).toContain(`„${word}“`);
    expect(text("avalik-kursus-jarelmaks-rida")).toContain(`„${et.course.financingLine}“`);
    expect(text("avalik-kursus-jarelmaks-rida")).toContain(`„${ru.course.financingLine.replace(/ /g, " ")}“`);
    expect(text("avalik-kursus-jarelmaks-rida")).toContain(`„${ru.forms.payFinancing}“`);
    expect(text("avalik-kursus-jarelmaks-rida")).toContain(`„${et.forms.payFull}“`);
    expect(text("avalik-kursus-jarelmaks-rida")).toContain(`„${et.forms.payHalf}“`);
    expect(text("avalik-kursus-jarelmaks-rida")).toContain(`„${et.course.payNow}“`);
    for (const id of ["registreerimine-jarelmaks-kinnitatud", "registreerimine-jarelmaks-nupud", "ekursus-jarelmaks"]) expect(text(id), id).toContain(`„${et.forms.payFinancing}“`);
    for (const id of ["registreerimine-jarelmaks-nupud", "registreerimine-jarelmaks-vahepeal-valja"]) expect(text(id), id).toContain(`„${et.forms.payFinancingOff}“`);
    expect(text("registreerimine-jarelmaks-kinnitatud")).toContain(`„${et.forms.payFinancingContract}“`);
    expect(text("registreerimine-jarelmaks-keeldus")).toContain(`„${et.payment.result.pendingFinancing}“`);
    for (const id of ["registreerimine-jarelmaks-keeldus", "registreerimine-jarelmaks-nupud"]) expect(text(id), id).toContain(`„${et.payment.payBank}“`);
    expect(text("registreerimine-jarelmaks-nupud")).toContain(`„${et.payment.payFinancing}“`);
    expect(text("registreerimine-jarelmaks-keeldus")).toContain(`„${et.payment.result.retry}“`);
    expect(text("ekursus-jarelmaks")).toContain(`„${et.cart.payBank}“`);
    // the invoice's and the payments list's words
    expect(paidMethodText("financing")).toBe("Järelmaks (Inbank)");
    expect(text("registreerimine-jarelmaks-kinnitatud")).toContain(`„Tasutud … · ${paidMethodText("financing")}“`);
    expect(text("ekursus-jarelmaks")).toContain(`„Tasutud … · ${paidMethodText("financing")}“`);
    expect(paymentMethodLabel("hirePurchase", null)).toBe("Järelmaks (Inbank)");
    expect(paymentMethodLabel("paymentInitiation", "")).toBe("Pangalink");
    for (const word of [adminEt.payments.filter.paid, adminEt.payments.filter.pending, adminEt.payments.filter.failed, adminEt.payments.filter.held, adminEt.payments.online])
      expect(text("haldus-maksed-jarelmaks") + text("registreerimine-jarelmaks-hiline"), word).toContain(`„${word}“`);
  });

  test("Maria's late-loan note, as the check quotes it, is the note the site sends", () => {
    const alert = paymentAlertSummary(
      {
        alert: "double", late: "loan", kind: "prepayment", name: "Proov 14", email: "proov14@example.test", amountCents: 60000, course: "Kulmumeistri baaskoolitus", startsAt: new Date("2026-11-14T08:00:00Z"),
        reference: "MSLAB-M7", providerUuid: "uuid-7", rawStatus: "PAID", paidCents: 60000, currency: "EUR",
      },
      "https://mslab.example/admin",
    );
    expect(alert.subject).toMatch(/^Topeltmakse: Proov 14, /);
    expect(text("registreerimine-jarelmaks-hiline")).toContain("„Topeltmakse: Proov 14, …“");
    for (const sentence of ["Järelmaks (Inbank) laekus, kui koolitus oli juba täies ulatuses tasutud.", "Tagasta see Montonio halduses: täielik tagastus tühistab järelmaksu."]) {
      expect(alert.text, sentence).toContain(sentence);
      expect(text("registreerimine-jarelmaks-hiline"), sentence).toContain(`„${sentence}“`);
    }
  });

  test("the e-course page check is reworded: the grey placeholder is gone, the quiet line replaces it", () => {
    const check = item("avalik-ekursus-leht");
    expect(check.mark).toBe("reworded");
    expect(markedSince(check.markedAt)).toBe(true);
    expect(appliesAt(check as unknown as TestItem, plan as unknown as TestPlan, "2026-10-25T00:00:00.000Z")).toBeNull(); // no answer reopens
    const expectText = check.expect.join("\n");
    expect(expectText).toContain("Hallist valikut „Vormista järelmaks — tulekul“ enam ei ole.");
    expect(expectText).toContain(`„${et.course.financingLine}“`);
    expect(expectText).not.toContain("on hall");
    // no check still sends anyone to a placeholder: a line that names one says it is gone
    for (const line of plan.items.flatMap((c) => c.expect)) if (/Vormista järelmaks — tulekul|See võimalus lisandub hiljem|Järelmaks — tulekul/.test(line)) expect(line).toContain("enam ei ole");
    for (const line of plan.items.flatMap((c) => c.steps)) expect(line).not.toMatch(/järelmaks — tulekul|Järelmaks — tulekul|See võimalus lisandub hiljem/);
  });

  test("the payment checks whose choices changed are redo: the first bank payment and the e-course purchase", () => {
    for (const id of ["registreerimine-montonio-esmane", "ekursus-ost"]) {
      const check = item(id);
      expect(check.mark, id).toBe("redo");
      expect(markedSince(check.markedAt), id).toBe(true);
      expect(appliesAt(check as unknown as TestItem, plan as unknown as TestPlan, "2026-10-25T00:00:00.000Z"), id).not.toBeNull();
      expect(text(id), id).toContain(`„${et.forms.payFinancing}“`);
    }
    expect(item("registreerimine-montonio-esmane").expect.join("\n")).toContain(`„${et.forms.payFull}“`);
    expect(item("ekursus-ost").steps.join("\n")).toContain(`„${et.cart.payBank}“`);
  });

  test("the notes say how to leave the toggle: on for the checks, off again before the site opens, until Montonio is live", () => {
    expect(String(area("koristamine").note)).toContain("Pane Seaded → „Järelmaks (Inbank)“ välja, kuni Montonio on Maria ettevõttele päriselt aktiveeritud");
    expect(String(area("ekursus").note)).toContain("Proov 11");
    expect(item("haldus-seaded-jarelmaks").steps.join("\n")).toContain("jäta see märgituks");
  });
});

describe("B22: one open order per registration (admin UX pass, piece 2, Task 2)", () => {
  const order = plan.items.map((i) => i.id);
  const at = (id: string): number => {
    const n = order.indexOf(id);
    expect(n, id).toBeGreaterThanOrEqual(0);
    return n;
  };
  const item = (id: string) => plan.items[at(id)];
  const text = (id: string) => [item(id).title, ...item(id).steps, ...item(id).expect].join("\n");
  const replaced = adminEt.payments.status.replaced;

  test("the new check: a declined loan left for the bank is „Asendatud“ under „Kõik“, and the drawer shows only the latest order", () => {
    expect(item("haldus-maksed-asendatud")).toMatchObject({ area: "registreerimine", who: "dim", writes: true, mark: "new" });
    expect(markedSince(item("haldus-maksed-asendatud").markedAt)).toBe(true); // "deploy" until the stamp, then the deploy instant
    expect(text("haldus-maksed-asendatud")).toContain(`„${replaced}“`);
    expect(text("haldus-maksed-asendatud")).toContain(`„${et.payment.payBank}“`);
    // the toggle is on by then, and it reads Maksed the way the Maksed check does
    expect(at("haldus-seaded-jarelmaks")).toBeLessThan(at("haldus-maksed-asendatud"));
    expect(at("haldus-maksed-jarelmaks")).toBeLessThan(at("haldus-maksed-asendatud"));
  });

  // Task 2's review (liveAttempt revives a replaced row): loan → bank → loan inside the loan's 60 minutes is ONE Inbank application, so the same
  // check presses the loan once more after it has read the replaced state, and expects no third row (the steps run in order, the expect lines don't)
  test("the same check presses „Maksa järelmaksuga (Inbank)“ again inside 60 minutes and expects two rows, not three", () => {
    const { steps, expect: lines } = item("haldus-maksed-asendatud");
    const press = steps.findIndex((s) => s.includes(`„${et.payment.payFinancing}“`));
    expect(press, "the second loan press").toBeGreaterThan(steps.findIndex((s) => s.includes(`„${et.payment.payBank}“`)));
    expect(press, "after the first reading of the replaced state").toBeGreaterThan(steps.findIndex((s) => s.includes("Ava Proov 15 registreeringu paneel")));
    expect(steps[press]).toContain("60 minuti jooksul");
    expect(steps[steps.length - 1]).toContain("tühista siis Proov 15 registreering"); // the cleanup stays last
    // what the first reading expects is said to be "before" the second press
    expect(lines.some((l) => l.startsWith("Enne järelmaksu uuesti vajutamist"))).toBe(true);
    const after = lines.filter((l) => l.startsWith("Pärast teist järelmaksu vajutust") || l.startsWith("Järelmaksu rida on jälle"));
    expect(after).toHaveLength(2);
    expect(after.join("\n")).toContain("kaks rida, kolmandat pole");
    expect(after.join("\n")).toContain(`„${adminEt.payments.status.pending}“`);
    expect(after.join("\n")).toContain(`„${replaced}“`);
  });

  test("the checks whose rows B22 changed are to be run again, with the words they now see", () => {
    for (const id of ["registreerimine-jarelmaks-keeldus", "registreerimine-jarelmaks-vahepeal-valja", "registreerimine-jarelmaks-hiline", "haldus-maksed-jarelmaks"]) {
      expect(item(id), id).toMatchObject({ mark: "redo" });
      expect(markedSince(item(id).markedAt), id).toBe(true); // "deploy" until the stamp, then the deploy instant
    }
    // Proov 10's loan, declined and then paid by bank, is „Asendatud“: no check expects it under „Pooleli“ any more
    expect(text("registreerimine-jarelmaks-keeldus")).toContain(`„Järelmaks (Inbank)“ staatusega „${replaced}“`);
    expect(text("haldus-maksed-jarelmaks")).toContain(`Vajuta filtril „Kõik“ ja vaata Proov 10 järelmaksu rida, mis on „${replaced}“.`);
    expect(text("haldus-maksed-jarelmaks")).not.toContain("Pooleli järelmaksu real");
    // the late loan is held with its reason
    expect(text("registreerimine-jarelmaks-hiline")).toContain(`„${adminEt.payments.reason.double}“`);
  });
});

// Dim 22.10: every answer on the test page has a note box and its first note pings Telegram; the comment bubble is on every admin page.
describe("the review tools' checks (22.10)", () => {
  const find = (id: string) => {
    const found = plan.items.find((c) => c.id === id);
    expect(found, id).toBeDefined();
    return found!;
  };
  const whole = (id: string) => [find(id).title, ...find(id).steps, ...find(id).expect].join("\n");

  test("the test page's Telegram check is redo, and says the first note of a pass pings too, with the answer at the end", () => {
    const check = find("kirjad-testimine-telegram");
    expect(check.mark).toBe("redo");
    expect(markedSince(check.markedAt)).toBe(true); // "deploy" on the branch, the push instant once stamped
    expect(appliesAt(check as unknown as TestItem, plan as unknown as TestPlan, "2026-10-25T00:00:00.000Z")).not.toBeNull();
    const expectText = check.expect.join("\n");
    expect(expectText).toContain("„Testimine — Märkus: … · Viga“");
    // admin UX pass piece 4c (R-i): the pass is „Läbitud“ on the button and in the message; a redo from that deploy (what the message says changed)
    expect(expectText).toContain(`„Testimine — Märkus: … · ${adminEt.testplan.ok}“`);
    expect(check.steps.join("\n")).toContain(`juures „${adminEt.testplan.ok}“`);
    expect(whole("kirjad-testimine-telegram")).not.toContain("„OK“");
    expect(expectText).toContain("Teine proov");
  });

  test("a check walks the comment bubble: on a Seaded page, sent, in Telegram, on the list as „Haldus“, clear of Avaleht's publish bar", () => {
    const check = find("haldus-kommentaar-nupp");
    // (reworded in admin UX pass piece 3b: Seaded has no save bar since Task 5 — its legal texts are drafts with their own „Avalda …“ —, so the check
    // looked at the save bar of Avaleht; reworded again in piece 4a, Task 6: Avaleht is on the draft layer, so a word typed into „MS LABi lause“ brings
    // its publish bar, whose „Avalda muudatused“ the bubble must leave clear, and the word taken out again takes the bar away: nothing is published)
    expect(check).toMatchObject({ area: "haldus", who: "dim", device: "any", writes: true, mark: "reworded" });
    expect(markedSince(check.markedAt)).toBe(true);
    expect(appliesAt(check as unknown as TestItem, plan as unknown as TestPlan, "2026-10-25T00:00:00.000Z")).toBeNull(); // reworded: it reopens nothing
    expect(check.steps.join(" ")).toContain("Ava halduses „Avaleht“, lisa „MS LABi lause“ lõppu sõna Proov ja vaata ribal nuppu „Avalda muudatused“.");
    expect(check.steps.at(-1)).toBe("Kustuta sõna Proov ja oota, kuni riba kaob.");
    expect(check.steps.join(" ")).not.toContain("„Lepingud ja tingimused“");
    expect(check.steps.join(" ")).not.toContain("Salvesta");
    const text = whole("haldus-kommentaar-nupp");
    for (const word of ["Kommentaar", "Saada", "Haldus", "Näita kohta", adminEt.publish.publish, adminEt.publish.phonePublish, "Telegram", "/guide/tagasiside/", "Proov 1"])
      expect(text, word).toContain(word);
    // the words the bubble itself shows (public/feedback.js)
    expect(text).toContain("Aitäh! Kommentaar on saadetud ✓");
    // fix round 1: the wording, and the claim about covered buttons is about the page the check opens; the login page has no bubble (signed out)
    expect(text).toContain("kirjuta kommentaariks: Proov 1.");
    expect(text).not.toContain("kirjuta kommentaari:");
    expect(text).toContain("ei kata sellel lehel ühtegi nuppu");
    expect(text).not.toContain("sisselogimise lehel");
  });
});

// Dim 25.10: a third tester, „Automaattest“, whose answers stay apart from Maria's and Dim's: Dim sees each as a quiet line under the check.
describe("the Automaattest check (Dim 25.10)", () => {
  const t = adminEt.testplan;

  test("a check of its own: Dim's, on a computer, writing nothing, in Haldus; reworded in piece 4c (the answers' words), so it reopens nothing", () => {
    const check = plan.items.find((c) => c.id === "testimine-automaattest");
    expect(check, "testimine-automaattest").toBeDefined();
    expect(check).toMatchObject({ area: "haldus", who: "dim", device: "arvuti", writes: false, mark: "reworded", href: "/admin/testimine" });
    expect(markedSince(check!.markedAt)).toBe(true); // "deploy" on the branch, the push instant once stamped
    expect(appliesAt(check as unknown as TestItem, plan as unknown as TestPlan, "2026-10-26T00:00:00.000Z")).toBeNull(); // reworded: it reopens nothing
  });

  test("it quotes the page's words: the „Kes“ choice, the quiet line with its status words, the empty selection, the overtaken answer and the own answer's line", () => {
    const check = plan.items.find((c) => c.id === "testimine-automaattest")!;
    const text = [...check.steps, ...check.expect].join("\n");
    const empty = fill(adminEt.lists.emptyFiltered, { asju: t.things });
    for (const word of [`„${t.who.label}“`, `„${t.who.auto}“`, `„${t.who.all}“`, `„${t.who.auto}: ${t.ok} · …“`, `„${t.bad}“`, `„${empty}“`, "„Dim · … · …“"])
      expect(text, word).toContain(word);
    expect(text).toContain(`„${t.who.auto}: ${t.overtaken.replace(" {status}", "")}“`);
  });
});

// Admin UX pass piece 4c, Task 4 (C7): the test page's filter row, the areas' progress, „Sammud ▸“ and the signed-out state get a check of their
// own; the words that left the page („OK“, „Jäta vahele“, the marks' tags, „Muudetud“) leave the plan too.
describe("C7 Testimine (admin UX pass piece 4c, Task 4)", () => {
  const t = adminEt.testplan;
  const find = (id: string) => {
    const found = plan.items.find((c) => c.id === id);
    expect(found, id).toBeDefined();
    return found!;
  };
  const whole = (id: string) => [find(id).title, ...find(id).steps, ...find(id).expect, find(id).why].join("\n");

  test("a new check in Haldus, Dim's, on a computer: the line under the H1, both filter groups, the empty selection, an area's progress, „Sammud ▸“, signed out and back", () => {
    const check = find("testimine-filtrid-valjalogitud");
    expect(check).toMatchObject({ area: "haldus", who: "dim", device: "arvuti", writes: false, mark: "new", href: "/admin/testimine" });
    expect(markedSince(check.markedAt)).toBe(true);
    const text = whole("testimine-filtrid-valjalogitud");
    const empty = fill(adminEt.lists.emptyFiltered, { asju: t.things });
    for (const words of [
      `„${t.eyebrow}“`,
      `„… kontrolli · … läbitud · … viga“`,
      `„${t.filter.label}“`,
      `„${t.who.label}“`,
      `„${t.who.mina}“`,
      `„${t.who.all}“`,
      `„${t.who.auto}“`,
      `„${t.filter.open.replace("{n}", "…")}“`,
      `„${t.filter.bad.replace("{n}", "…")}“`,
      `„${t.filter.done.replace("{n}", "…")}“`,
      `„${empty}“`,
      `„${t.steps} ▸“`,
      `„${t.expect}“`,
      `„${t.why}“`,
      `„${adminEt.autosave.signedOut}“`,
      `„${adminEt.autosave.saved.replace("{time}", "…")}“`,
    ])
      expect(text, words).toContain(words);
    // (it sits right after the Automaattest check, in Haldus)
    const ids = plan.items.map((c) => c.id);
    expect(ids.indexOf("testimine-filtrid-valjalogitud")).toBe(ids.indexOf("testimine-automaattest") + 1);
  });

  test("no check presses „OK“ or „Jäta vahele“ or names the marks' tags or „Muudetud“ on the test page any more; one that cannot be done now is left open", () => {
    const lines = plan.items.flatMap((c) => [c.title, ...c.steps, ...c.expect].map((l) => `${c.id}: ${l}`));
    expect(lines.filter((l) => /„OK“|· OK“|Jäta vahele|„Uuesti testida“|„Sõnastus muutus“|Sina: /.test(l))).toEqual([]);
    for (const id of ["kontakt-tana", "kontakt-protokollid-tana-otse", "registreerimine-ootenimekiri", "registreerimine-arveta-makse-paneelis", "registreerimine-arveta-maksed", "registreerimine-arve-tagastatud", "registreerimine-jarelmaks-hiline", "kirjad-ootenimekiri", "kirjad-maria-ootenimekiri"])
      expect(whole(id), id).toMatch(/jäta (see|ka see|kontroll) avatuks/);
  });

  test("the swept checks are reworded from the deploy, and a redo stays the redo it was (a weaker mark would let an older answer stand)", () => {
    for (const id of ["haldus-menuu-margid", "koristamine-aadressid", "registreerimine-ootenimekiri", "kontakt-protokollid-tana-otse", "kirjad-ootenimekiri", "kirjad-maria-ootenimekiri"]) {
      expect(find(id).mark, id).toBe("reworded");
      expect(find(id).markedAt, id).toBe("deploy");
    }
    for (const id of ["registreerimine-arveta-makse-paneelis", "registreerimine-arveta-maksed", "registreerimine-arve-tagastatud", "registreerimine-jarelmaks-hiline", "kontakt-tana"]) {
      expect(find(id).mark, id).toBe("redo");
      expect(markedSince(find(id).markedAt), id).toBe(true);
    }
    expect(whole("haldus-menuu-margid")).toContain(`juba „${t.ok}“ kontroll tulemusega „${t.bad}“`);
    expect(whole("koristamine-aadressid")).toContain(`vajuta „${t.ok}“.`);
  });
});

// Admin UX pass, piece 3b, Task 8: three checks that the sweep reworded or extended.
describe("piece 3b sweep (Task 8)", () => {
  const item = (id: string) => {
    const found = plan.items.find((c) => c.id === id);
    expect(found, id).toBeDefined();
    return found!;
  };

  test("registreerimine-kohad: the public free seats leave out a seat an unpaid registration holds, so they can be fewer than the admin's capacity less confirmed", () => {
    const check = item("registreerimine-kohad");
    expect(check).toMatchObject({ mark: "reworded" });
    expect(markedSince(check.markedAt)).toBe(true);
    const text = check.expect.join("\n");
    expect(text).toContain("sama palju või vähem");
    expect(text).toContain("tasumata registreering hoiab kohta kinni");
    expect(text).toContain("30 minutit");
    expect(text).not.toContain("sama palju, kui halduse real on teine arv miinus esimene");
  });

  test("kirjad-halduse-link: the second open of the link is in a private window (the same window is signed in and lands on „Ülevaade“), marked reworded", () => {
    const check = item("kirjad-halduse-link");
    expect(check).toMatchObject({ mark: "reworded" });
    expect(markedSince(check.markedAt)).toBe(true);
    const last = check.steps[check.steps.length - 1];
    expect(last).toContain("privaatses aknas");
    expect(last).toContain("„Ülevaatesse“");
    expect(last).not.toBe("Vajuta sama linki teist korda.");
    expect(check.expect.at(-1)).toContain("Privaatses aknas ütleb leht „See sisselogimislink on aegunud või juba kasutatud. Telli uus link.“");
  });

  test("the phone check of the legal texts also covers a contract text: tap into it, „+ nimi“ … „+ ettemaks“ stay above the keyboard; it stays a new check", () => {
    const check = item("haldus-seaded-privaatsus-avalda");
    expect(check).toMatchObject({ device: "telefon", mark: "new" });
    expect(markedSince(check.markedAt)).toBe(true);
    const step = check.steps.find((s) => s.includes("„Kontaktkoolituse leping“"));
    expect(step).toMatch(/^Vajuta kaardil „Kontaktkoolituse leping“ nuppu „Muuda teksti“/); // (the form of step 2, not „Ava kaart“)
    expect(step).toContain("klaviatuur");
    expect(step ? /salvesta/i.test(step) : true).toBe(false);
    const line = check.expect.find((l) => l.includes("klaviatuuri kohale"));
    expect(line).toContain("„+ nimi“");
    expect(line).toContain("„+ ettemaks“");
    expect(line).toContain("on nähtaval");
    expect(line).not.toContain("saab vajutada"); // (no step presses a chip: a press writes a contract draft that cannot be discarded)
    expect(check.why).toContain("telefonis");
  });
});

describe("C4 Hüpikaken (admin UX pass piece 4b, Task 4)", () => {
  const item = (id: string) => {
    const found = plan.items.find((c) => c.id === id);
    expect(found, id).toBeDefined();
    return found!;
  };
  const whole = (id: string) => [item(id).title, ...item(id).steps, ...item(id).expect, item(id).why].join("\n");
  const t = adminEt.campaign;

  test("haldus-hupikaken (redo): the instant switch with its undo, the offer waiting for „Avalda muudatused“, the preview's ET | RU, the home page after 8 s", () => {
    const check = item("haldus-hupikaken");
    expect(check).toMatchObject({ mark: "redo", href: "/admin/kampaania" });
    expect(markedSince(check.markedAt)).toBe(true);
    for (const words of [t.shown, t.shownHint, t.hidden, adminEt.common.undo, t.discount, adminEt.publish.publish, "8 sekundit", "privaatses aknas"]) expect(whole("haldus-hupikaken"), words).toContain(words);
    // the three-way choice and „Salvesta“ are gone, and no admin screen says „kampaania“ (only this check, which asks for it to be missing)
    expect(whole("haldus-hupikaken")).not.toMatch(/Väljas|„Kampaania“|„Uudiskiri“|„Salvesta“ ja|6 sekund/);
    // „Eelvaade ↗“ (ruling c1): the popup at once under the popup's own bar, which counts the two drafted fields
    const preview = check.steps.findIndex((s) => s.includes("„Eelvaade ↗“"));
    expect(preview).toBeGreaterThan(check.steps.findIndex((s) => s.includes("„Soodustus (%)“: 15")));
    expect(preview).toBeLessThan(check.steps.findIndex((s) => s.startsWith("Vajuta „Avalda muudatused“")));
    expect(check.expect.find((l) => l.startsWith("Eelvaates"))).toContain("„Avaldamata 2“");
  });

  test("avalik-hupikaken (redo): 8 s, once in 30 days per browser, the home page only — new visitors in a private window", () => {
    const check = item("avalik-hupikaken");
    expect(check).toMatchObject({ mark: "redo", href: "/" });
    expect(markedSince(check.markedAt)).toBe(true);
    const text = whole("avalik-hupikaken");
    for (const words of ["8 sekundit", "30 päeva", "privaatses aknas", "„Koolitused“", "ainult avalehel"]) expect(text, words).toContain(words);
    expect(text).not.toMatch(/6 sekund|kampaania|Samas vahekaardis/);
    // "home only" can fail (review m1): „Koolitused“ first, in a new private window that has not seen the popup, then the home page in that window
    const courses = check.steps.findIndex((s) => s.includes("„Koolitused“"));
    expect(check.steps[courses]).toMatch(/uues privaatses aknas kõigepealt/);
    expect(check.steps[courses + 1]).toMatch(/^Mine samas aknas avalehele/);
    expect(check.expect[0]).toContain("ainult avalehel");
  });

  test("avalik-uudiskiri (reworded): the footer's button stays „Liitu“; the popup's follows Seaded's code (S4-Q4)", () => {
    const check = item("avalik-uudiskiri");
    expect(check).toMatchObject({ mark: "reworded" });
    expect(markedSince(check.markedAt)).toBe(true);
    const line = check.expect.find((l) => l.includes(`„${et.newsletter.popupSubmitCode}“`));
    expect(line).toContain(`„${et.newsletter.submit}“`);
    expect(line).toContain("„Tervituskood“");
    // a step shows the popup's button (review m2): the home page in a new private window, the site's 8 s
    expect(check.steps[0]).toMatch(/^Ava avaleht uues privaatses aknas, oota 8 sekundit, vaata hüpikakna nuppu/);
  });

  test("haldus-seaded-uudiskiri: the code in capitals is checked after a reload (the save's answer carries no value); still a new check", () => {
    const check = item("haldus-seaded-uudiskiri");
    expect(check).toMatchObject({ mark: "new" });
    expect(markedSince(check.markedAt)).toBe(true);
    const reload = check.steps.findIndex((s) => /^Värskenda lehte/.test(s));
    expect(reload).toBeGreaterThan(check.steps.findIndex((s) => s.includes("proov-1")));
    expect(reload).toBeLessThan(check.steps.findIndex((s) => s.includes("tagasi endiseks")));
    expect(check.expect.find((l) => l.includes("PROOV-1"))).toMatch(/^Pärast värskendamist/);
  });
});
