import { eq } from "drizzle-orm";
import { readSetting } from "@/db/queries/public";
import type { Db } from "@/db/client";
import { settings } from "@/db/schema";
import planFile from "@/data/testplan.json";
import {
  answerOf, answersIn, markPinged, mergeAnswers, ownFaults, pingsFor, planCounts, readAnswersDoc, sideOf, testerOf,
  type AnswersDoc, type IncomingAnswer, type Ping, type Status, type Tester, type TestPlan,
} from "@/domain/testplan";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { adminFirstName } from "./auth";

// The test page's server side (phase 4, piece 1, spec D4, D6, D10, §5): the answers are ONE `settings` row (key testplan_answers, no migration),
// merged under the row's lock; a failure ("Viga") and the first note on any answer earn their Telegram texts. The rules themselves (the merge, the pings, the counts) are the
// pure domain/testplan.ts. The admin session is checked by the callers (app/api/admin/testplan withAdmin, the admin pages).
// Dim 25.10: the automatic tester „Automaattest“ (its name in ADMIN_NAMES) answers into the same row's own map `auto`, never into `answers`:
// Maria and Dim see its answers apart, and its answers never count as theirs.
// Logs carry counts and ids only: never a note, an e-mail address or a name.

/** The `settings` key of the answers. */
const KEY = "testplan_answers";
/** The row's value before the first save. */
const EMPTY: AnswersDoc = { v: 1, answers: {} };
/** At most this many checks in one save (the plan is about 140 checks: this leaves room for a long offline outbox, and no more). */
const MAX_IDS = 300;
/** A Telegram message holds at most this many characters (code points) of the note. */
const PING_NOTE_MAX = 300;
const STATUSES: readonly string[] = ["ok", "bad", "skip"];

/** The plan, from the committed file (spec D3): its shape is src/data/testplan.json's, which tests/unit/testplan-file.test.ts holds to checkPlan. */
export const testPlan = planFile as unknown as TestPlan;

/**
 * The instant of the running build (spec §6): what a "markedAt": "deploy" of the plan reads as when tools/testplan-stamp.mjs was skipped.
 * next.config.ts inlines TESTPLAN_BUILD_AT into dev and production builds; only the tests lack it, and they get the epoch (every deploy mark is
 * then in the past: nothing reopens). The page and the API use this one value, so their counts agree.
 */
export function testplanBuildAt(): string {
  return process.env.TESTPLAN_BUILD_AT ?? new Date(0).toISOString();
}

/** What the browser gets of an answer: the answerer's first name, never `by` (the session's e-mail address) nor the ping bookkeeping. */
export type PageAnswer = { status: Status; note: string; at: string; byName: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The first word of the admin's name in ADMIN_NAMES, or "" when the address is not listed. */
const firstName = (email: string, names: string | undefined): string => adminFirstName(email, names).split(/\s+/)[0];
/** Who answered, for a person to read: the first name, or "admin". */
const answererName = (email: string, names: string | undefined): string => firstName(email, names) || "admin";

/**
 * Who the signed-in admin is for the page (spec D10): the first name and the tester ("maria" or "dim"; "auto" for Automaattest, Dim 25.10, which
 * sees every check and answers into its own map; null: any other admin sees every check as "Kõik").
 */
export function testplanYou(email: string, names: string | undefined): { name: string; tester: Tester | null } {
  return { name: firstName(email, names), tester: testerOf(email, names) };
}

/** The stored answers (the empty doc when nothing was saved yet: reading creates no row). */
export async function readAnswers(db: Db): Promise<AnswersDoc> {
  return readAnswersDoc(await readSetting(db, KEY));
}

/** The answers of the plan's checks as the browser gets them (an answer kept for an id the plan no longer has is not sent). */
export function toPageAnswers(doc: AnswersDoc, plan: TestPlan, names: string | undefined): Record<string, PageAnswer> {
  const entries: [string, PageAnswer][] = [];
  for (const { id } of plan.items) {
    const stored = answerOf(doc.answers, id);
    if (stored) entries.push([id, { status: stored.status, note: stored.note, at: stored.at, byName: answererName(stored.by, names) }]);
  }
  return Object.fromEntries(entries);
}

/**
 * The answers the page of `tester` gets (Dim 25.10): `answers`, the ones it shows as the checks' answers and edits (Automaattest's own `auto` for
 * Automaattest; the shared `answers` for Maria, Dim and any other admin), and `auto`, Automaattest's, which Maria's and Dim's page shows as a
 * quiet line under each check and its „Kes“ choice „Automaattest“ filters by. Both in the page's form (toPageAnswers).
 */
export function pageView(doc: AnswersDoc, plan: TestPlan, names: string | undefined, tester: Tester | null): { answers: Record<string, PageAnswer>; auto: Record<string, PageAnswer> } {
  const auto = toPageAnswers({ v: 1, answers: answersIn(doc, "auto") }, plan, names);
  return { answers: tester === "auto" ? auto : toPageAnswers(doc, plan, names), auto };
}

/**
 * A request body as the answers it asks to save, or null when it is not one: an object whose `answers` is an object of at most MAX_IDS
 * `{ status: ok | bad | skip, note: text }` (one bad answer refuses the whole save). Only those two fields are taken over: `clientAt` (the
 * device's own press order, used in the browser only) and anything else a body carries are dropped here.
 */
function parseBody(body: unknown): Record<string, IncomingAnswer> | null {
  if (!isObject(body) || !isObject(body.answers)) return null;
  const sent = Object.entries(body.answers);
  if (sent.length > MAX_IDS) return null;
  const answers: [string, IncomingAnswer][] = [];
  for (const [id, raw] of sent) {
    if (!isObject(raw) || typeof raw.status !== "string" || !STATUSES.includes(raw.status) || typeof raw.note !== "string") return null;
    answers.push([id, { status: raw.status as Status, note: raw.note }]);
  }
  return Object.fromEntries(answers);
}

/**
 * Saves answers (spec D4, §5; `incoming` is the parsed request body, `{ answers: { <id>: { status, note } } }`, checked here before anything
 * is touched). One transaction: the row is inserted when missing (on conflict do nothing), then locked (select … for update), so two saves at
 * once take turns and each merges into what the other wrote; the stored answers are read, the save merged in (`by` the session's e-mail, `at`
 * `now`), the Telegram messages it earns worked out and recorded as sent, and the row written back. The messages are returned, not sent: the caller
 * sends them once the transaction has committed, and a failed send never changes the answer.
 * `names` is ADMIN_NAMES (Dim 25.10): the session's admin named „Automaattest…“ there saves into the row's `auto`, never into `answers`; every
 * other admin's save goes into `answers` and leaves `auto` as it is.
 */
export async function saveAnswers(
  db: Db,
  email: string,
  incoming: unknown,
  now: Date,
  names: string | undefined,
): Promise<{ ok: true; doc: AnswersDoc; pings: Ping[] } | { ok: false; error: "invalid" }> {
  const answers = parseBody(incoming);
  if (!answers) return { ok: false, error: "invalid" };
  const buildAt = testplanBuildAt();
  const side = sideOf(testerOf(email, names));
  const saved = await db.transaction(async (tx) => {
    await tx.insert(settings).values({ key: KEY, value: EMPTY }).onConflictDoNothing();
    const [row] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY)).for("update");
    const stored = readAnswersDoc(row?.value);
    const { doc: merged, changed } = mergeAnswers(stored, answers, testPlan, email, now, buildAt, side);
    const pings = pingsFor(stored, merged, changed, testPlan, buildAt, side);
    const doc = markPinged(merged, pings, now);
    await tx.update(settings).set({ value: doc }).where(eq(settings.key, KEY));
    return { doc, pings, saved: changed.length };
  });
  console.info(`[testplan] saved ${saved.saved} answers, ${saved.pings.length} messages`);
  return { ok: true, doc: saved.doc, pings: saved.pings };
}

/**
 * The Telegram text of a ping (spec D6): `tg.bad` for a new failure, `tg.note` for the first note of an answer (Dim 22.10: of any answer, with the
 * answer shown in the button's words: Viga or Läbitud since admin UX pass piece 4c, R-i; an answer stored as Jäta vahele before that button went
 * keeps its word). The check's title, the answerer's first name (from ADMIN_NAMES, else "admin";
 * never the address), the note's first PING_NOTE_MAX characters (or `tg.noNote`, also for a failure whose note is the answer before it's:
 * `oldNote`) and the link to the check, `<base>/admin/testimine#<id>`. A ping marked `auto` is of Automaattest's answer, read from the doc's
 * `auto` (Dim 25.10): its name in ADMIN_NAMES, „Automaattest“, is the name in the text.
 */
export function pingText(ping: Ping, plan: TestPlan, doc: AnswersDoc, names: string | undefined, base: string): string {
  const t = adminEt.testplan;
  const item = plan.items.find((i) => i.id === ping.id);
  const stored = answerOf(answersIn(doc, ping.auto ? "auto" : "answers"), ping.id);
  const note = ping.oldNote ? "" : Array.from(stored?.note ?? "").slice(0, PING_NOTE_MAX).join("");
  // (an id the doc does not hold has no answer to show: the message goes without the " · {status}" part)
  const template = ping.kind === "bad" ? t.tg.bad : stored ? t.tg.note : t.tg.note.replace(" · {status}", "");
  return fill(template, {
    title: item?.title ?? ping.id,
    name: answererName(stored?.by ?? "", names),
    status: stored ? t[stored.status] : "",
    note: note === "" ? t.tg.noNote : note,
    url: `${base}/admin/testimine#${ping.id}`,
  });
}

/**
 * The Avaleht card's numbers (spec §5): the open and failed checks of the signed-in admin's own tester (Maria: hers and the shared ones; Dim:
 * his and the shared ones; any other admin: all), or null when none is open or failed (the card is then not shown). Maria's, Dim's and any
 * other admin's count the shared answers only; Automaattest's (Dim 25.10) counts its own answers over the whole plan.
 */
export async function testplanCard(db: Db, email: string, names: string | undefined): Promise<{ open: number; bad: number } | null> {
  const tester = testerOf(email, names);
  const doc = await readAnswers(db);
  const { open, bad } =
    tester === "auto"
      ? planCounts(testPlan, { v: 1, answers: answersIn(doc, "auto") }, testplanBuildAt(), null)
      : planCounts(testPlan, doc, testplanBuildAt(), tester);
  return open + bad === 0 ? null : { open, bad };
}

/**
 * The number on Testimine's menu badge (admin UX pass B6): how many „Viga“ answers the signed-in admin has standing (domain/testplan.ts ownFaults).
 * One read of the answers row. (queries/admin.ts adminCounts calls it with the other menu numbers.)
 */
export async function ownFaultCount(db: Db, email: string): Promise<number> {
  return ownFaults(testPlan, await readAnswers(db), testplanBuildAt(), email);
}
