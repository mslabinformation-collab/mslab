// The test page's pure rules (phase 4, piece 1, spec 2026-10-16-test-page-design): the plan's shape and house style (checkPlan), a check's state
// against its answer and its mark (checkState), the note, the merge of a save into the stored answers, the Telegram pings a save earns, the
// session-to-tester match and the counts. No database, no React: the API route, the page and the Avaleht card share them. It runs in the
// browser too, on iOS Safari before 16.4 as well: no lookbehind here (tests/unit/old-safari.test.ts), and no import of anything server-only.

export type Who = "maria" | "dim" | "koos";
export type Device = "telefon" | "tahvel" | "arvuti" | "any";
export type Mark = "redo" | "reworded" | "new";
/** An area of the plan; `checks: false` is a notes-only area ("Enne alustamist", "Koristamine"): it takes no check. */
export type TestArea = { id: string; name: string; note?: string; checks?: false };
export type TestItem = {
  id: string;
  area: string;
  who: Who;
  device: Device;
  title: string;
  href?: string;
  steps: string[];
  expect: string[];
  why: string;
  risk: "high" | "med" | "low";
  /** Running it creates data (a registration, a student, a mail, a payment). */
  writes: boolean;
  mark?: Mark;
  /** When the check last changed meaning: an ISO instant, or "deploy" (the instant of the deployment that carries it, tools/testplan-stamp.mjs). */
  markedAt?: string;
};
export type TestPlan = { version: 1; marked: string; areas: TestArea[]; items: TestItem[] };
export type Status = "ok" | "bad" | "skip";
/** An answer as stored (the `settings` key testplan_answers). `at` and `pinged` are server instants; `by` is the session's admin e-mail and never leaves the server. */
export type StoredAnswer = { status: Status; note: string; at: string; by: string; pinged?: string; notePinged?: true };
export type AnswersDoc = { v: 1; answers: Record<string, StoredAnswer> };
/** An answer as the device sends it. `clientAt` only orders several unsent presses of one check on the device; the server stamps `at` itself. */
export type IncomingAnswer = { status: Status; note: string; clientAt?: string };
/** `answer` is the check's valid answer; `overtaken` is the answer a redo has reopened the check over (shown as "Varasem vastus"). Never both: an open check has no valid answer. */
export type CheckState = { state: "open" | "done" | "failed"; answer: StoredAnswer | null; overtaken: StoredAnswer | null };
/** A Telegram message to send: the first for a new failure ("bad"), the second for its first note ("note"). */
export type Ping = { id: string; kind: "bad" | "note" };

/** A note holds at most this many characters, counted in code points after trimming. */
export const NOTE_MAX = 1000;

const WHO: readonly string[] = ["maria", "dim", "koos"];
const DEVICE: readonly string[] = ["telefon", "tahvel", "arvuti", "any"];
const MARK: readonly string[] = ["redo", "reworded", "new"];
const RISK: readonly string[] = ["high", "med", "low"];
const STATUS: readonly string[] = ["ok", "bad", "skip"];

/** House style (spec §3): at most this many steps and expect lines per check, and words per line. */
const MAX_LINES = 8;
const MAX_WORDS = 20;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** An instant as `toISOString` writes it (the milliseconds optional): 2026-10-20T09:00:00.000Z. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** A free-mail address of the public repository's guard (tests/unit/test-addresses.test.ts): never in the plan. */
const FREE_MAIL = /@(?:gmail|googlemail)\.com/i;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInstant = (v: unknown): v is string => typeof v === "string" && INSTANT.test(v) && !Number.isNaN(Date.parse(v));
const isStatus = (v: unknown): v is Status => typeof v === "string" && STATUS.includes(v);
const wordCount = (line: string): number => line.trim().split(/\s+/).length;

/** The problems of one line of a check (a step, an expect line or the "why"): empty, no final full stop, too many words. */
function lineProblems(where: string, line: unknown): string[] {
  if (typeof line !== "string" || line.trim() === "") return [`${where} is empty`];
  const out: string[] = [];
  if (!line.trim().endsWith(".")) out.push(`${where} does not end with a full stop`);
  const words = wordCount(line);
  if (words > MAX_WORDS) out.push(`${where} has ${words} words, at most ${MAX_WORDS}`);
  return out;
}

/** The problems of a list of lines (steps, expect): a list of 1 to MAX_LINES lines, each a line of the house style. */
function listProblems(label: string, field: string, lines: unknown): string[] {
  if (!Array.isArray(lines)) return [`${label}: ${field} must be a list`];
  if (lines.length === 0) return [`${label}: ${field} is empty`];
  const out: string[] = [];
  if (lines.length > MAX_LINES) out.push(`${label}: ${field} has ${lines.length} lines, at most ${MAX_LINES}`);
  lines.forEach((line, i) => out.push(...lineProblems(`${label}: ${field} line ${i + 1}`, line)));
  return out;
}

/**
 * The plan's shape and house style (spec §3): the problems found, [] when it is fine. One problem per fault, each naming the check (or
 * the area) it is in, so a test that breaks one thing expects exactly one line. What it holds:
 * - the version is 1 and `marked` an ISO instant; ids (areas and checks) are kebab-case and unique; every check names an area of the plan,
 *   and never one with `checks: false`;
 * - `who`, `device`, `risk` and `mark` are of their enums, `writes` is true or false, the title is text;
 * - `href`, when given, is a path of this site (starts with a single "/"); `markedAt` only with a `mark`, and then an ISO instant or "deploy"
 *   (a mark without its own `markedAt` falls back to `marked`, which is fine);
 * - steps and expect: 1 to 8 lines each; every step, expect and "why" line is a sentence of at most 20 words ending with a full stop
 *   (titles have no full stop);
 * - no free-mail address anywhere (the repository is public).
 *
 * THE RULE THIS CANNOT CATCH: a check's id never changes once it has an answer. The answers hang on the id, so renaming one loses its answer
 * (and a changed meaning is a `mark`, not a new id). JSON has no comments, so the rule lives here and in docs/deploy.md ("Testimine").
 */
export function checkPlan(plan: unknown): string[] {
  if (!isObject(plan)) return ["the plan is not an object"];
  const problems: string[] = [];
  if (plan.version !== 1) problems.push("version must be 1");
  if (!isInstant(plan.marked)) problems.push(`marked must be an ISO instant like 2026-10-16T00:00:00.000Z, got ${JSON.stringify(plan.marked)}`);

  // areas: id → whether it takes checks
  const areas = new Map<string, boolean>();
  if (!Array.isArray(plan.areas) || plan.areas.length === 0) problems.push("areas must be a list with at least one area");
  else
    plan.areas.forEach((area: unknown, i) => {
      if (!isObject(area)) {
        problems.push(`area ${i + 1} is not an object`);
        return;
      }
      const id = area.id;
      const label = typeof id === "string" ? `area "${id}"` : `area ${i + 1}`;
      if (typeof id !== "string" || !KEBAB.test(id)) problems.push(`${label}: id must be kebab-case`);
      else if (areas.has(id)) problems.push(`duplicate area id "${id}"`);
      else areas.set(id, area.checks !== false);
      if (typeof area.name !== "string" || area.name.trim() === "") problems.push(`${label}: name is empty`);
      if (area.note !== undefined && typeof area.note !== "string") problems.push(`${label}: note must be text`);
      if (area.checks !== undefined && area.checks !== false) problems.push(`${label}: checks may only be false`);
    });

  const ids = new Set<string>();
  if (!Array.isArray(plan.items)) problems.push("items must be a list");
  else
    plan.items.forEach((entry: unknown, i) => {
      if (!isObject(entry)) {
        problems.push(`item ${i + 1} is not an object`);
        return;
      }
      const id = entry.id;
      const label = typeof id === "string" ? id : `item ${i + 1}`;
      if (typeof id !== "string" || !KEBAB.test(id)) problems.push(`${label}: id must be kebab-case`);
      else if (ids.has(id)) problems.push(`duplicate id "${id}"`);
      else ids.add(id);

      if (typeof entry.area !== "string" || !areas.has(entry.area)) problems.push(`${label}: unknown area ${JSON.stringify(entry.area)}`);
      else if (areas.get(entry.area) === false) problems.push(`${label}: area "${entry.area}" takes no checks (checks: false)`);
      if (typeof entry.who !== "string" || !WHO.includes(entry.who)) problems.push(`${label}: who ${JSON.stringify(entry.who)} is not maria, dim or koos`);
      if (typeof entry.device !== "string" || !DEVICE.includes(entry.device)) problems.push(`${label}: device ${JSON.stringify(entry.device)} is not telefon, tahvel, arvuti or any`);
      if (typeof entry.risk !== "string" || !RISK.includes(entry.risk)) problems.push(`${label}: risk ${JSON.stringify(entry.risk)} is not high, med or low`);
      if (typeof entry.writes !== "boolean") problems.push(`${label}: writes must be true or false`);
      if (typeof entry.title !== "string" || entry.title.trim() === "") problems.push(`${label}: title is empty`);

      if (entry.href !== undefined && (typeof entry.href !== "string" || !entry.href.startsWith("/") || entry.href.startsWith("//")))
        problems.push(`${label}: href ${JSON.stringify(entry.href)} must be a path of this site, starting with a single /`);
      if (entry.mark !== undefined && (typeof entry.mark !== "string" || !MARK.includes(entry.mark))) problems.push(`${label}: mark ${JSON.stringify(entry.mark)} is not redo, reworded or new`);
      if (entry.markedAt !== undefined) {
        if (entry.mark === undefined) problems.push(`${label}: markedAt without a mark`);
        else if (entry.markedAt !== "deploy" && !isInstant(entry.markedAt)) problems.push(`${label}: markedAt ${JSON.stringify(entry.markedAt)} is neither an ISO instant nor "deploy"`);
      }

      problems.push(...listProblems(label, "steps", entry.steps));
      problems.push(...listProblems(label, "expect", entry.expect));
      problems.push(...lineProblems(`${label}: why`, entry.why));
    });

  let text = "";
  try {
    text = JSON.stringify(plan) ?? "";
  } catch {
    problems.push("the plan cannot be written as JSON");
  }
  if (FREE_MAIL.test(text)) problems.push("the plan holds a free-mail address (the repository is public): write the test address as a description, not an address");
  return problems;
}

/**
 * The instant a check's answer is judged by (spec §6), or null for a check without a redo: a `redo` with its own `markedAt`, else the plan's
 * `marked`; a `markedAt` of "deploy" reads as `buildAt`, the running deployment's build time (the safety net when the stamp tool was skipped).
 * `reworded` and `new` never reopen an answer.
 */
export function appliesAt(item: TestItem, plan: TestPlan, buildAt: string): string | null {
  if (item.mark !== "redo") return null;
  const at = item.markedAt ?? plan.marked;
  return at === "deploy" ? buildAt : at;
}

/**
 * A check's state (spec §4): no answer, or an answer given before its redo's instant (`appliesAt`; an answer at that very instant stands):
 * open, the old answer in `overtaken` and `answer` null; else Viga is failed, OK and Jäta vahele are done. Instants are compared as instants,
 * not as text ("…:00Z" and "…:00.000Z" are the same moment).
 */
export function checkState(item: TestItem, answer: StoredAnswer | undefined, plan: TestPlan, buildAt: string): CheckState {
  if (!answer) return { state: "open", answer: null, overtaken: null };
  const since = appliesAt(item, plan, buildAt);
  if (since !== null && Date.parse(answer.at) < Date.parse(since)) return { state: "open", answer: null, overtaken: answer };
  return { state: answer.status === "bad" ? "failed" : "done", answer, overtaken: null };
}

/**
 * A note as it is stored (spec §7): trimmed, "" for white space or anything that is not text, cut at NOTE_MAX code points (Array.from, so an
 * emoji is one character), and trimmed again where the cut fell in white space, so cleaning a clean note changes nothing.
 */
export function cleanNote(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return Array.from(raw.trim()).slice(0, NOTE_MAX).join("").trimEnd();
}

/**
 * The stored `testplan_answers` value read defensively (jsonb: anything): a doc of version 1 with its good entries. An entry is kept when it
 * has a status and a valid `at`; its note is cleaned, a missing `by` is "", and a `pinged` that is no instant or a `notePinged` that is not
 * true is left out. Anything else, the whole value of another version included, is an empty doc. Always a copy.
 */
export function readAnswersDoc(value: unknown): AnswersDoc {
  const entries: [string, StoredAnswer][] = [];
  if (isObject(value) && value.v === 1 && isObject(value.answers)) {
    for (const [id, raw] of Object.entries(value.answers)) {
      if (!isObject(raw) || !isStatus(raw.status) || !isInstant(raw.at)) continue;
      const entry: StoredAnswer = { status: raw.status, note: cleanNote(raw.note), at: raw.at, by: typeof raw.by === "string" ? raw.by : "" };
      if (isInstant(raw.pinged)) entry.pinged = raw.pinged;
      if (raw.notePinged === true) entry.notePinged = true;
      entries.push([id, entry]);
    }
  }
  // (fromEntries, not assignment: an id called "__proto__" is an ordinary key)
  return { v: 1, answers: Object.fromEntries(entries) };
}

/**
 * A save merged into the stored answers (spec D4, §5). Each incoming answer of a check in the plan becomes `{ status, note, at, by }` with the
 * note cleaned, `at` the server's `now` and `by` the session's: nothing else of the incoming object is used (not its `by`, not its `at`). An
 * id outside the plan, or a status that is none of ok / bad / skip, is ignored; answers stored for ids outside the plan are kept untouched.
 * `changed` lists the ids written, in the order sent. The stored entry's `pinged` and `notePinged` carry over only while it stays the same
 * failure: it was Viga, it is Viga again, and no redo has overtaken it; otherwise the failure is a new one and earns its own messages (D6).
 * `buildAt` is what a "deploy" mark reads as (appliesAt); without it, `now`: a check marked "deploy" then counts every earlier failure as
 * overtaken, which can only send a message too many and never hide one. Pure: `stored` is not edited.
 */
export function mergeAnswers(
  stored: AnswersDoc,
  incoming: Record<string, IncomingAnswer>,
  plan: TestPlan,
  by: string,
  now: Date,
  buildAt: string = now.toISOString(),
): { doc: AnswersDoc; changed: string[] } {
  const items = new Map(plan.items.map((item) => [item.id, item]));
  const answers = { ...stored.answers };
  const changed: string[] = [];
  const at = now.toISOString();
  for (const [id, raw] of Object.entries(incoming)) {
    const item = items.get(id);
    if (!item || !isObject(raw) || !isStatus(raw.status)) continue;
    const entry: StoredAnswer = { status: raw.status, note: cleanNote(raw.note), at, by };
    const prev = stored.answers[id];
    if (prev && prev.status === "bad" && entry.status === "bad" && checkState(item, prev, plan, buildAt).overtaken === null) {
      if (prev.pinged !== undefined) entry.pinged = prev.pinged;
      if (prev.notePinged) entry.notePinged = true;
    }
    answers[id] = entry;
    changed.push(id);
  }
  return { doc: { v: 1, answers }, changed };
}

/**
 * The Telegram messages a save earns (spec D6), for the ids it changed whose answer is now Viga: the first message when no `pinged` is
 * recorded (the failure is new: mergeAnswers dropped the old one's), the second, once, when the failure has been announced, has no
 * `notePinged` and now has a note. A new Viga that already has a note gets the first message only, which carries the note (markPinged marks
 * the note sent too). Nothing for OK, Jäta vahele, or an id not in the plan; nothing again once both are recorded. `before` and `buildAt` are
 * not read: mergeAnswers already decided which failure is the same one, and `after` carries what it decided.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function pingsFor(_before: AnswersDoc, after: AnswersDoc, changed: string[], plan: TestPlan, _buildAt: string): Ping[] {
  const known = new Set(plan.items.map((item) => item.id));
  const pings: Ping[] = [];
  for (const id of changed) {
    const answer = after.answers[id];
    if (!answer || answer.status !== "bad" || !known.has(id)) continue;
    if (answer.pinged === undefined) pings.push({ id, kind: "bad" });
    else if (!answer.notePinged && answer.note !== "") pings.push({ id, kind: "note" });
  }
  return pings;
}

/**
 * The doc after the pings were sent (record only the ones that went out; a failed send is not recorded and is found again by the next save):
 * the first message sets `pinged` (the instant of the first message, kept if there is one) and, when the answer has a note, `notePinged` too
 * (the first message carried it); the second sets `notePinged`. A copy; an id the doc does not hold is skipped.
 */
export function markPinged(doc: AnswersDoc, pings: Ping[], now: Date): AnswersDoc {
  const answers = { ...doc.answers };
  const at = now.toISOString();
  for (const { id, kind } of pings) {
    const answer = answers[id];
    if (!answer) continue;
    answers[id] =
      kind === "bad"
        ? { ...answer, pinged: answer.pinged ?? at, ...(answer.note !== "" ? { notePinged: true as const } : {}) }
        : { ...answer, notePinged: true };
  }
  return { v: 1, answers };
}

/**
 * Which tester the signed-in admin is (spec D10): the admin's name in ADMIN_NAMES ("<address>=<name>,…", the same parse as
 * server/auth.ts adminFirstName, which this module cannot import: the page loads it), its first word lower-cased, "maria" or "dim".
 * An unlisted address or any other name is null: that admin sees every check as "Kõik".
 */
export function testerOf(email: string, adminNames: string | undefined): Exclude<Who, "koos"> | null {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  for (const entry of (adminNames ?? "").split(",")) {
    const at = entry.lastIndexOf("=");
    if (at > 0 && entry.slice(0, at).trim().toLowerCase() === wanted) {
      const first = entry.slice(at + 1).trim().split(/\s+/)[0].toLowerCase();
      return first === "maria" || first === "dim" ? first : null;
    }
  }
  return null;
}

/**
 * The header's and the Avaleht card's numbers (spec §4, §5) over the plan's own checks (answers to other ids are ignored). `who` narrows them
 * to the checks of that tester and the shared ones ("koos"); null counts all. Each check is exactly one of done (OK or Jäta vahele, still
 * valid), open or bad (a standing Viga), so done + open + bad = total; `redo` is the open ones that carry an overtaken answer.
 */
export function planCounts(
  plan: TestPlan,
  doc: AnswersDoc,
  buildAt: string,
  who: Exclude<Who, "koos"> | null,
): { total: number; done: number; open: number; bad: number; redo: number } {
  const counts = { total: 0, done: 0, open: 0, bad: 0, redo: 0 };
  for (const item of plan.items) {
    if (who !== null && item.who !== who && item.who !== "koos") continue;
    const { state, overtaken } = checkState(item, doc.answers[item.id], plan, buildAt);
    counts.total++;
    if (state === "done") counts.done++;
    else if (state === "failed") counts.bad++;
    else {
      counts.open++;
      if (overtaken) counts.redo++;
    }
  }
  return counts;
}
