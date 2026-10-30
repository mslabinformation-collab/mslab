"use client";

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import {
  answerOf, checkState, cleanNote, NOTE_MAX, planCounts, stateIn,
  type AnswersDoc, type CheckState, type Status, type StoredAnswer, type StoredStatus, type Tester, type TestItem, type TestPlan as Plan,
} from "@/domain/testplan";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import type { PageAnswer } from "@/server/testplan"; // (a type only: erased by the build)
import { usePhoneChip } from "./course/usePhoneChip";
import { ListEmpty } from "./ListStates";
import { SaveStatus } from "./SaveStatus";
import { createOutbox, type Outbox, type OutboxStatus, type UnsentAnswer } from "./testplan-outbox";
import { TestplanCheck, type AutoAnswer } from "./TestplanCheck";
import ui from "./ui.module.css";
import styles from "./TestPlan.module.css";

// The test page (phase 4, piece 1, spec §4, §7): the plan's checks, each answered with a note (its box is open under every check, Dim 30.10), the
// answers of both admins together. The plan comes with the page (the bundle's own file: it is there when the database is not); the answers come
// with the page and are read again on every load and on „Värskenda“. What the tester presses or types is the outbox's (testplan-outbox.ts): it
// shows over the server's answers until a save has carried it, so a press is never taken back by a read, a slow save or a lost connection.
// Dim 25.10: a third tester, „Automaattest“, answers apart, and the „Kes“ choice „Automaattest“ shows the checks it answered. Automaattest's own page
// sees every check and shows its answers as the checks' answers (the server sends them so). Admin polish Part A (Dim 29.10, reversing D10's "never
// counts"): on Maria's and Dim's page its answer is a check's state where no person's answer stands (domain/testplan.ts sharedState), in the marker,
// the line, the „Olek“ pills and the area bars, though never their answer (no half pressed, its note not in their box); its result is a chip in the row.
// Admin polish Part A besides: a check answered here (or taken back) keeps its row, in place and with its new state, until the „Olek“ or „Kes“ choice
// is made again, „Värskenda“ is pressed or the page is loaded again (`kept`); the counts and the area bars follow at once.
// Dim 30.10: a note box under every check. A note typed where she has no answer is a note on its own (outbox `note(…, "note")`, the debounce and the
// flush of any note): it changes no state and so moves no row; the box emptied is the clear. Automaattest's note alone lists no check under „Kes:
// Automaattest“ (`autoIds`: the checks it gave a result).
// Admin UX pass piece 4c (C7, README §4; the Part 4 frame „C7 Testimine“; piece4-texts S4-42…S4-46, §4, §5; R-i): the header is the eyebrow, the
// H1, the line „{n} kontrolli · {k} läbitud · {v} viga“, one SaveStatus in place of the outbox line and „Värskenda“; one filter row of two
// labelled groups, „Olek“ (Kõik / Avatud n / Viga n / Läbitud n, counted under the „Kes“ choice) and „Kes“ (Mina / Kõik / Automaattest); area
// cards with their progress, which fold together with their notes; the check rows (TestplanCheck.tsx); „Selle valikuga kontrolle pole.“ for an
// empty selection. „Muudetud“, „Jäta vahele“, the marks' chips and „Sina: …“ went (spec §10); the answers, `auto`, the marks and the pings are
// kept as stored.
// This file runs on old iPads and phones: no lookbehind here, no Object.hasOwn (an answer is read off its own keys: domain/testplan.ts answerOf).

const API = "/api/admin/testplan";
/** The tester's last choice of filters, kept on the device (spec §4). */
const VIEW_KEY = "mslab-testplan-view";
/** An answer not sent yet counts as the newest there is: a redo's instant is judged against the server's clock, never the device's. */
const UNSENT_AT = "9999-12-31T23:59:59.999Z";

/** The „Olek“ choice: every check, or the open, the failed or the passed ones (S4-44). */
type Filter = "all" | "open" | "bad" | "done";
/**
 * The „Kes“ choice (R-i): „Mina“, the signed-in tester's checks and the shared ones (an admin who is no tester, and Automaattest's own session,
 * see every check); „Kõik“; „Automaattest“, the checks Automaattest answered (Dim 25.10).
 */
type WhoChoice = "mina" | "all" | "auto";
type View = { filter: Filter; who: WhoChoice };

const FILTERS: readonly Filter[] = ["all", "open", "bad", "done"];
const WHOS: readonly WhoChoice[] = ["mina", "all", "auto"];
/** The check state each counted „Olek“ pill keeps. */
const STATE_OF: Record<Exclude<Filter, "all">, CheckState["state"]> = { open: "open", bad: "failed", done: "done" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Nothing changes behind the page's back for the values it reads once (the stored view, the address's #): there is nothing to subscribe to. */
const subscribeNothing = (): (() => void) => () => {};

function readView(): string | null {
  try {
    return window.localStorage.getItem(VIEW_KEY);
  } catch {
    return null; // blocked storage
  }
}
/** The stored choice; anything that is not one is the default (the page before piece 4c kept „Muudetud“ and the testers' names: the default too). */
function parseView(raw: string | null): View {
  const view: View = { filter: "all", who: "mina" };
  if (raw === null) return view;
  try {
    const stored: unknown = JSON.parse(raw);
    if (isObject(stored)) {
      if (FILTERS.includes(stored.filter as Filter)) view.filter = stored.filter as Filter;
      if (WHOS.includes(stored.who as WhoChoice)) view.who = stored.who as WhoChoice;
    }
  } catch {
    // rubbish: the default
  }
  return view;
}
function readHash(): string {
  try {
    return decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return "";
  }
}
type Read = { answers: Record<string, PageAnswer>; auto: Record<string, PageAnswer> };
/**
 * GET /api/admin/testplan: the answers by check and Automaattest's apart (none when the body has no `auto` object); "signedOut" for a 401 (the
 * session ended, R-i); or null when the server cannot give them: a 503, a 500 page (the session lookup failed), no connection.
 */
async function readServer(): Promise<Read | "signedOut" | null> {
  try {
    const res = await fetch(API, { cache: "no-store", headers: { accept: "application/json" } });
    if (res.status === 401) return "signedOut";
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok || !isObject(body) || body.ok !== true || !isObject(body.answers)) return null;
    return { answers: body.answers as Record<string, PageAnswer>, auto: isObject(body.auto) ? (body.auto as Record<string, PageAnswer>) : {} };
  } catch {
    return null;
  }
}
function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Does a check belong to the „Kes“ choice: „Kõik“; „Mina“, the tester's own and the shared ones (`mine` null: every check, for an admin who is
 * no tester and for Automaattest's own session); „Automaattest“, one Automaattest has answered (`autoIds`, resultIds: its note alone is no answer).
 */
const forWho = (who: WhoChoice, item: TestItem, mine: "maria" | "dim" | null, autoIds: ReadonlySet<string>): boolean =>
  who === "all" || (who === "auto" ? autoIds.has(item.id) : mine === null || item.who === mine || item.who === "koos");
const passes = (filter: Filter, st: CheckState | undefined): boolean => filter === "all" || st?.state === STATE_OF[filter];
/** The checks' states as the counts read them (Dim 29.10, domain/testplan.ts stateIn): a person's answer, else Automaattest's (none on its own page). */
const statesOf = (plan: Plan, doc: AnswersDoc, buildAt: string): Map<string, CheckState> => new Map(plan.items.map((i) => [i.id, stateIn(doc, i, plan, buildAt)]));
/** The checks a map gives a result (ok, bad, skip): what „Kes: Automaattest“ lists. A note on its own (Dim 30.10) lists none. */
const resultIds = (answers: Record<string, { status: StoredStatus }>): Set<string> =>
  new Set(Object.entries(answers).filter(([, a]) => a.status !== "note").map(([id]) => id));

/**
 * The server's answers as the rules read them (the answerer's name stands where the e-mail address is in a stored answer), the unsent ones over
 * them. An unsent "clear" (Dim 29.10, an answer taken back) takes the check's answer out until the server has said so, and so does an unsent note
 * on its own of no text (Dim 30.10: the box emptied, which the server takes as the clear).
 */
function docOf(answers: Record<string, PageAnswer> | null, unsent: ReadonlyMap<string, UnsentAnswer>): AnswersDoc {
  const entries = new Map<string, StoredAnswer>(Object.entries(answers ?? {}).map(([id, a]) => [id, { status: a.status, note: a.note, at: a.at, by: a.byName }]));
  for (const [id, a] of unsent) {
    if (a.status === "clear" || (a.status === "note" && cleanNote(a.note) === "")) entries.delete(id);
    else entries.set(id, { status: a.status, note: a.note, at: UNSENT_AT, by: "" });
  }
  return { v: 1, answers: Object.fromEntries(entries) };
}

/** A map with one entry changed (state is never edited in place). */
const withEntry = <V,>(map: ReadonlyMap<string, V>, id: string, value: V): ReadonlyMap<string, V> => new Map(map).set(id, value);
const withoutEntry = <V,>(map: ReadonlyMap<string, V>, id: string): ReadonlyMap<string, V> => {
  const next = new Map(map);
  next.delete(id);
  return next;
};
const clip = (text: string): string => Array.from(text).slice(0, NOTE_MAX).join("");

/**
 * The page's one SaveStatus (README §1.4, C7; R-i): „Kontrollin salvestatud teksti…“ while „Värskenda“ reads; „Salvestamata — logi uuesti
 * sisse“ when a save or a read was refused with 401 and nothing has gone through since; else the outbox's saving, retry and saved (with the time
 * of the last save). With nothing sent, „Salvestatud“ (the shared engine starts so too; the chip is there from the start, so the page does not
 * jump and its first change is spoken) — but none while the answers cannot be read (`unread`): the page's own line says so then (Dim 29.10).
 */
function chipOf(outbox: OutboxStatus, reading: boolean, readSignedOut: boolean, savedAt: Date | null, unread: boolean): AutosaveStatus | null {
  if (reading) return { kind: "checking" };
  if (outbox === "signedOut" || readSignedOut) return { kind: "signedOut" };
  if (outbox === "retrying") return { kind: "retry" };
  if (outbox === "saving") return { kind: "saving" };
  if (outbox === "saved") return { kind: "saved", at: savedAt };
  return unread ? null : { kind: "saved", at: null };
}

export type TestPlanProps = {
  plan: Plan;
  /** The answers when the page was made, or null when they could not be read (the database is down). Automaattest's own, for its session. */
  initial: Record<string, PageAnswer> | null;
  /** Automaattest's answers when the page was made, apart (Dim 25.10): a chip in each check's row (Dim 29.10), and the „Kes“ choice „Automaattest“. */
  auto?: Record<string, PageAnswer> | null;
  /** The signed-in admin: the tester („Mina“ is Maria's or Dim's checks; "auto", Automaattest, and null, any other admin, see every check). */
  you: { name: string; tester: Tester | null };
  /** What a "deploy" mark of the plan reads as (server/testplan.ts testplanBuildAt). */
  buildAt: string;
};

export function TestPlan({ plan, initial, auto: initialAuto, you, buildAt }: TestPlanProps) {
  const t = adminEt.testplan;
  const uid = useId();
  const phone = usePhoneChip();
  const [answers, setAnswers] = useState(initial);
  /** Automaattest's answers as last read (never written by this page: its own session's are `answers`). */
  const [auto, setAuto] = useState<Record<string, PageAnswer>>(initialAuto ?? {});
  /** This is Automaattest's own session: its answers are `answers` (the halves, the counts), and no chip repeats them. */
  const own = you.tester === "auto";
  const mine = you.tester === "maria" || you.tester === "dim" ? you.tester : null;
  const [reading, setReading] = useState(false);
  /**
   * The answers cannot be read (Dim 29.10, review Q1): the page could not read them, or the last read failed other than with a 401. The page then
   * says so in place of its numbers, and shows none (every check would read „Avatud“) until a read goes through or a save brings every answer.
   */
  const [unread, setUnread] = useState(initial === null);
  /** The last read was refused with 401 (the session ended) and none has gone through since. */
  const [readSignedOut, setReadSignedOut] = useState(false);
  /** When the last save came back ok (the chip's „Salvestatud HH:MM“). */
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  /** The outbox as this render shows it (null until it is made). The handlers use `ensureOutbox` instead. */
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  const outboxRef = useRef<Outbox | null>(null);
  const [version, changed] = useReducer((n: number) => n + 1, 0);
  /** Saves that came back: a read that began before one is older than it and is not taken. */
  const writes = useRef(0);
  const focusAfterRef = useRef<string | null>(null);
  const [picked, setPicked] = useState<View | null>(null);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [typed, setTyped] = useState<ReadonlyMap<string, string>>(() => new Map());
  /**
   * The checks answered (or taken back) on this page since the „Olek“ or „Kes“ choice was last made and „Värskenda“ last pressed (Dim 29.10): each
   * keeps its row, in place and with its new state, whatever the choice says, so a press never makes the row under her finger jump away.
   */
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const keep = (id: string) => setKept((s) => (s.has(id) ? s : new Set(s).add(id)));

  const storedView = useSyncExternalStore(subscribeNothing, readView, () => null);
  const hash = useSyncExternalStore(subscribeNothing, readHash, () => "");
  const view = useMemo(() => picked ?? parseView(storedView), [picked, storedView]);
  /** A pill of „Olek“ or „Kes“ pressed (the one already chosen too: the choice made again lets the rows kept go). */
  const choose = (next: View) => {
    setKept(new Set());
    setPicked(next);
    try {
      window.localStorage.setItem(VIEW_KEY, JSON.stringify(next));
    } catch {
      // storage full or blocked: the choice holds for this visit
    }
  };

  /**
   * What a read made of: the server's answers (a read that began before a save came back is older than that save and is not taken), the session
   * ended (the chip says so), or nothing could be read (what was read before stays on the page, without its numbers). Automaattest's answers are
   * always taken: no save of this page changes them.
   */
  const apply = useCallback((fresh: Read | "signedOut" | null, before: number) => {
    if (fresh === null) {
      // (a read that began before a save came back is older than that save, which brought every answer: its failure tells nothing; re-review Minor 2)
      if (writes.current === before) setUnread(true);
      return;
    }
    if (fresh === "signedOut") {
      // (`unread` stays as it is: a page that could not read its answers and is now signed out says both — the line and the signed-out chip —
      // because both are true, and clearing the line would show counts of answers never read; re-review Minor 3)
      setReadSignedOut(true);
      return;
    }
    setReadSignedOut(false);
    setUnread(false);
    if (writes.current === before) setAnswers(fresh.answers);
    setAuto(fresh.auto);
  }, []);
  /**
   * „Värskenda“: reads again, with the button and the chip saying it is busy. A read that went through sends what waits here too (she may have
   * signed in again meanwhile: the presses kept while she was signed out go, and the chip stops asking her to sign in; review M-2). The rows kept
   * by her presses go at once (Dim 29.10): the list is the „Olek“ and „Kes“ choice's again.
   */
  const refresh = async () => {
    setKept(new Set());
    setReading(true);
    const before = writes.current;
    const fresh = await readServer();
    apply(fresh, before);
    setReading(false);
    // (the outbox is made when the page mounts; before that nothing can wait in it)
    if (fresh !== null && fresh !== "signedOut") void outboxRef.current?.flush();
  };

  /**
   * The outbox, made on first use: by the effect below, or by a press that comes before it. A tap while the page is still loading is run by
   * React against the first render's handlers (it hydrates the page, then replays the tap), and that render had no outbox yet: the handlers take
   * it from here, never from their render, so such a press is queued like any other. (Once stopped it says nothing more, so there is no
   * listener to take off.)
   */
  const ensureOutbox = useCallback((): Outbox => {
    if (outboxRef.current) return outboxRef.current;
    const made = createOutbox({
      storage: browserStorage(),
      put: (body) => fetch(API, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      onAnswers: (fresh) => {
        writes.current += 1;
        setAnswers(fresh);
        setUnread(false); // (a save's answer is every answer there is)
        setSavedAt(new Date());
        setReadSignedOut(false);
      },
    });
    made.onChange(changed);
    outboxRef.current = made;
    setOutbox(made);
    return made;
  }, []);

  useEffect(() => {
    const made = ensureOutbox();
    return () => {
      made.stop();
      if (outboxRef.current === made) outboxRef.current = null;
    };
  }, [ensureOutbox]);

  // every load reads the answers again (the page was made a moment ago, or is the browser's copy of an earlier visit)
  useEffect(() => {
    const before = writes.current;
    void readServer().then((fresh) => apply(fresh, before));
  }, [apply]);

  // a link to a check (the Telegram message's): scrolled to once its area is open
  useEffect(() => {
    if (hash) document.getElementById(hash)?.scrollIntoView?.();
  }, [hash]);

  // what is shown: the server's answers, the unsent ones over them
  const { doc, local } = useMemo(() => {
    const unsent = outbox ? outbox.unsent() : new Map<string, UnsentAnswer>();
    return { doc: docOf(answers, unsent), local: new Set(unsent.keys()) };
    // (`version` stands for what the outbox holds now)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, outbox, version]);
  /** Automaattest's answers: its own session's are what it shows (`doc`, its presses included), anybody else's come apart (`auto`). */
  const autoDoc = useMemo(() => (own ? doc : docOf(auto, new Map())), [own, doc, auto]);
  const autoIds = useMemo(() => resultIds(autoDoc.answers), [autoDoc]);
  /** What the states and the counts read (Dim 29.10): the person's answers, and Automaattest's under them; its own page, its own answers only. */
  const counted = useMemo<AnswersDoc>(() => (own ? doc : { ...doc, auto: autoDoc.answers }), [own, doc, autoDoc]);
  const states = useMemo(() => statesOf(plan, counted, buildAt), [plan, counted, buildAt]);
  /**
   * Automaattest's answer to each check it answered, for its chip and its note line on Maria's and Dim's page: the answer, and whether a redo has
   * overtaken it (its note on its own, Dim 30.10, is here for the line; TestplanCheck draws it no chip).
   */
  const autoAnswers = useMemo(() => {
    const chips = new Map<string, AutoAnswer>();
    if (own) return chips;
    for (const item of plan.items) {
      const stored = answerOf(autoDoc.answers, item.id);
      if (stored) chips.set(item.id, { answer: stored, overtaken: checkState(item, stored, plan, buildAt).overtaken !== null });
    }
    return chips;
  }, [own, plan, autoDoc, buildAt]);
  const byArea = useMemo(() => {
    const map = new Map<string, TestItem[]>();
    for (const item of plan.items) map.set(item.area, [...(map.get(item.area) ?? []), item]);
    return map;
  }, [plan]);
  /** The line under the H1 and the „Olek“ pills (S4-43, S4-44): the checks of the „Kes“ choice. */
  const counts = useMemo(
    () => planCounts({ ...plan, items: plan.items.filter((i) => forWho(view.who, i, mine, autoIds)) }, counted, buildAt, null),
    [plan, counted, buildAt, view.who, mine, autoIds],
  );
  /** The area that starts open: the first with a check still open when the page was made (it does not move as the tester answers). */
  const firstOpen = useMemo(() => {
    const start = docOf(initial, new Map());
    const startStates = statesOf(plan, own ? start : { ...start, auto: docOf(initialAuto ?? null, new Map()).answers }, buildAt);
    const startIds = resultIds((own ? initial : initialAuto) ?? {});
    return plan.items.find((i) => forWho(view.who, i, mine, startIds) && startStates.get(i.id)?.state === "open")?.area ?? null;
  }, [plan, initial, initialAuto, own, buildAt, view.who, mine]);
  const hashArea = plan.items.find((i) => i.id === hash)?.area;

  /**
   * Each area that takes checks, with the checks of the „Kes“ choice (`ofWho`, which its progress counts) and those shown (`shown`): the ones the
   * „Olek“ choice keeps, the ones kept by a press on this page (Dim 29.10), and a check linked to (#id) always.
   */
  const sections = plan.areas
    .filter((area) => area.checks !== false)
    .map((area) => {
      const items = byArea.get(area.id) ?? [];
      const ofWho = items.filter((i) => i.id === hash || forWho(view.who, i, mine, autoIds));
      const shown = items.filter((i) => i.id === hash || kept.has(i.id) || (forWho(view.who, i, mine, autoIds) && passes(view.filter, states.get(i.id))));
      return { area, ofWho, shown };
    });
  const empty = sections.every((s) => s.shown.length === 0);
  const sectionOf = new Map(sections.map((s) => [s.area.id, s]));

  const chip = chipOf(outbox ? outbox.status() : "idle", reading, readSignedOut, savedAt, unread);
  const line = fill(counts.total === 1 ? t.progress.one : t.progress.many, { n: counts.total, done: counts.done, bad: counts.bad });

  const press = (item: TestItem, status: Status) => {
    // (her note on its own, Dim 30.10, becomes the note of the answer pressed)
    const note = typed.get(item.id) ?? states.get(item.id)?.answer?.note ?? "";
    ensureOutbox().answer(item.id, status, note);
    keep(item.id);
    // (the note box is there under every check; only a Viga takes the focus into it: a pass must not raise a phone's keyboard)
    if (status === "bad") focusAfterRef.current = item.id;
  };
  /**
   * An answer taken back (Dim 29.10; outbox `clear`, Task 4): the check is as one never answered here (or Automaattest's again), and its note goes
   * with it: what she typed is dropped, and the box stays, empty (Dim 30.10). A note typed in it next is a note on its own, which replaces the
   * clear still waiting (the server's note entry replaces the answer the same way).
   */
  const takeBack = (item: TestItem) => {
    setTyped((m) => withoutEntry(m, item.id));
    if (focusAfterRef.current === item.id) focusAfterRef.current = null;
    ensureOutbox().clear(item.id);
    keep(item.id);
  };
  /** A note typed: on her answer's status, or (Dim 30.10) "note", a note on its own, where she has none or on her note. */
  const type = (item: TestItem, status: StoredStatus, value: string) => {
    const text = clip(value);
    setTyped((m) => withEntry(m, item.id, text));
    ensureOutbox().note(item.id, text, status);
  };
  const leave = (item: TestItem) => {
    setTyped((m) => withoutEntry(m, item.id));
    void ensureOutbox().flush();
  };

  return (
    <div className={styles.root} data-testplan="">
      <div className={`${ui.heading} ${styles.heading}`}>
        <div className={styles.titles}>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={`${ui.h1} ${styles.h1}`}>{t.title}</h1>
          {!unread && (
            <p className={`${ui.muted} ${styles.line}`} data-progress="">
              {line}
            </p>
          )}
          {/* the answers cannot be read (Dim 29.10): always there, so the change is spoken; empty (no height) while they can */}
          <p role="status" className={styles.unread} data-unread="">
            {unread ? fill(t.unread, { refresh: t.refresh }) : ""}
          </p>
        </div>
        <div className={ui.headAside}>
          {chip && <SaveStatus status={chip} compact={phone} />}
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} aria-busy={reading} onClick={() => void refresh()} data-refresh="">
            {t.refresh}
          </button>
        </div>
      </div>

      <div className={styles.filters}>
        <div className={styles.group} role="group" aria-labelledby={`${uid}-olek`} data-filter-group="olek">
          <span id={`${uid}-olek`} className={styles.groupLabel}>
            {t.filter.label}
          </span>
          <div className={styles.pills}>
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={`${ui.pill} ${styles.pill} ${view.filter === f ? styles.on : ""}`}
                aria-pressed={view.filter === f}
                onClick={() => choose({ ...view, filter: f })}
                data-filter={f}
              >
                {/* (no number while the answers cannot be read: the pill's word alone) */}
                {f === "all" ? t.filter.all : unread ? t.filter[f].replace(" {n}", "") : fill(t.filter[f], { n: counts[f] })}
              </button>
            ))}
          </div>
        </div>
        <span className={styles.divider} aria-hidden="true" />
        <div className={styles.group} role="group" aria-labelledby={`${uid}-kes`} data-filter-group="kes">
          <span id={`${uid}-kes`} className={styles.groupLabel}>
            {t.who.label}
          </span>
          <div className={styles.pills}>
            {WHOS.map((w) => (
              <button
                key={w}
                type="button"
                className={`${ui.pill} ${styles.pill} ${view.who === w ? styles.on : ""}`}
                aria-pressed={view.who === w}
                onClick={() => choose({ ...view, who: w })}
                data-who={w}
              >
                {t.who[w]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {empty ? (
        // S4-46: no clear button (there is no search, and „Kõik“ resets); the notes-only areas go with the checks
        <div className={`${ui.card} ${styles.emptyCard}`}>
          <ListEmpty things={t.things} filtered />
        </div>
      ) : (
        plan.areas.map((area) => {
          if (area.checks === false) {
            // a notes-only area (`checks: false`, today „Enne alustamist“): its words, always in view, with the „Olek“ choice off
            if (view.filter !== "all") return null;
            return (
              <section key={area.id} className={`${ui.card} ${styles.notes}`} aria-labelledby={`${uid}-area-${area.id}`} data-area={area.id}>
                <h2 id={`${uid}-area-${area.id}`} className={styles.areaTitle}>
                  {area.name}
                </h2>
                {area.note && <p className={styles.areaNote}>{area.note}</p>}
              </section>
            );
          }
          const { ofWho, shown } = sectionOf.get(area.id)!;
          if (shown.length === 0) return null;
          const done = ofWho.filter((i) => states.get(i.id)?.state === "done").length;
          const width = `${ofWho.length === 0 ? 0 : Math.round((done / ofWho.length) * 100)}%`;
          const open = toggled.get(area.id) ?? (view.filter !== "all" || area.id === firstOpen || area.id === hashArea);
          return (
            <section key={area.id} className={`${ui.card} ${styles.area}`} aria-labelledby={`${uid}-area-${area.id}`} data-area={area.id}>
              <h2 className={styles.areaHead}>
                <button
                  type="button"
                  className={styles.areaToggle}
                  aria-expanded={open}
                  aria-controls={`${uid}-body-${area.id}`}
                  onClick={() => setToggled((m) => withEntry(m, area.id, !open))}
                  data-area-toggle=""
                >
                  <span id={`${uid}-area-${area.id}`} className={styles.areaName}>
                    {area.name}
                  </span>
                  <span className={styles.progress}>
                    {!unread && (
                      <>
                        <span data-area-count="">{fill(t.areaCount, { done, total: ofWho.length })}</span>
                        <span className={styles.bar} aria-hidden="true">
                          <span className={styles.barFill} style={{ width }} data-area-bar="" />
                        </span>
                      </>
                    )}
                    <span className={styles.caret} aria-hidden="true">
                      ▾
                    </span>
                  </span>
                </button>
              </h2>
              {open && (
                // the area's note folds with it (C7)
                <div id={`${uid}-body-${area.id}`} className={styles.body}>
                  {area.note && (
                    <p className={styles.areaNote} data-area-note="">
                      {area.note}
                    </p>
                  )}
                  <ol className={styles.checks}>
                    {shown.map((item) => (
                      <TestplanCheck
                        key={item.id}
                        t={t}
                        item={item}
                        st={states.get(item.id)!}
                        auto={autoAnswers.get(item.id) ?? null}
                        unsent={local.has(item.id)}
                        typed={typed.get(item.id)}
                        focusAfterRef={focusAfterRef}
                        onPress={(status) => press(item, status)}
                        onTakeBack={() => takeBack(item)}
                        onType={(status, value) => type(item, status, value)}
                        onLeave={() => leave(item)}
                      />
                    ))}
                  </ol>
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
