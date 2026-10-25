"use client";

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import {
  answerOf, checkState, NOTE_MAX, planCounts,
  type AnswersDoc, type CheckState, type Status, type StoredAnswer, type Tester, type TestItem, type TestPlan as Plan, type Who,
} from "@/domain/testplan";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDayMonth, formatTime } from "@/i18n/format";
import type { PageAnswer } from "@/server/testplan"; // (a type only: erased by the build)
import { createOutbox, type Outbox, type OutboxStatus } from "./testplan-outbox";
import ui from "./ui.module.css";
import styles from "./TestPlan.module.css";

// The test page (phase 4, piece 1, spec §4, §7): the plan's checks, each answered OK, Viga or Jäta vahele with a note (its box is open under every
// answer, Dim 22.10), the answers of both admins together. The plan comes with the page (the bundle's own file: it is there when the database is
// not); the answers come with the page and are read again on every load and on "Värskenda". What the tester presses or types is the outbox's
// (testplan-outbox.ts): it shows over the server's answers until a save has carried it, so a press is never taken back by a read, a slow save or
// a lost connection.
// Dim 25.10: a third tester, „Automaattest“, answers apart. Maria's and Dim's page shows each of its answers as one quiet line under the check
// ("Automaattest: OK · dd.mm HH:MM", its note under it), never as their answer and never in their counts, and the „Kes“ choice „Automaattest“
// shows the checks it answered. Automaattest's own page sees every check and shows its answers as the checks' answers (the server sends them so).
// This file runs on old iPads and phones: no lookbehind here, no Object.hasOwn (an answer is read off its own keys: domain/testplan.ts answerOf).

const API = "/api/admin/testplan";
/** The tester's last choice of filters, kept on the device (spec §4). */
const VIEW_KEY = "mslab-testplan-view";
/** An answer not sent yet counts as the newest there is: a redo's instant is judged against the server's clock, never the device's. */
const UNSENT_AT = "9999-12-31T23:59:59.999Z";

type Filter = "all" | "open" | "bad" | "changed";
/** The „Kes“ choice: everybody's, a tester's own and the shared ones, the shared ones alone, or (Dim 25.10) the checks Automaattest answered. */
type WhoChoice = "all" | Who | "auto";
type View = { filter: Filter; who: WhoChoice };

const FILTERS: readonly Filter[] = ["all", "open", "bad", "changed"];
const WHOS: readonly WhoChoice[] = ["all", "maria", "dim", "koos", "auto"];
const STATUSES: readonly Status[] = ["ok", "bad", "skip"];

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
/** The stored choice; anything that is not one is the default. */
function parseView(raw: string | null, who: WhoChoice): View {
  const view: View = { filter: "all", who };
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
 * GET /api/admin/testplan: the answers by check and Automaattest's apart (none when the body has no `auto` object), or null when the server
 * cannot give them. Anything but a good answer is the same as the database being down: a 503, a 500 page (the session lookup failed), a 401,
 * no connection.
 */
async function readServer(): Promise<Read | null> {
  try {
    const res = await fetch(API, { cache: "no-store", headers: { accept: "application/json" } });
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
 * Does a check belong to the "Kes" choice: everybody's, or the tester's own and the shared ones ("Koos" alone: the shared ones), or
 * „Automaattest“: one Automaattest has answered (`autoIds`).
 */
const forWho = (who: WhoChoice, item: TestItem, autoIds: ReadonlySet<string>): boolean =>
  who === "all" || (who === "auto" ? autoIds.has(item.id) : item.who === who || item.who === "koos");
const passes = (filter: Filter, item: TestItem, st: CheckState | undefined): boolean =>
  filter === "all" || (filter === "open" && st?.state === "open") || (filter === "bad" && st?.state === "failed") || (filter === "changed" && item.mark !== undefined);

/** The server's answers as the rules read them (the answerer's name stands where the e-mail address is in a stored answer). */
function docOf(answers: Record<string, PageAnswer> | null, unsent: ReadonlyMap<string, { status: Status; note: string }>): AnswersDoc {
  const entries: [string, StoredAnswer][] = Object.entries(answers ?? {}).map(([id, a]) => [id, { status: a.status, note: a.note, at: a.at, by: a.byName }]);
  for (const [id, a] of unsent) entries.push([id, { status: a.status, note: a.note, at: UNSENT_AT, by: "" }]);
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

type Texts = typeof adminEt.testplan;
const statusText = (t: Texts, status: Status): string => t[status];

export type TestPlanProps = {
  plan: Plan;
  /** The answers when the page was made, or null when they could not be read (the database is down). Automaattest's own, for its session. */
  initial: Record<string, PageAnswer> | null;
  /** Automaattest's answers when the page was made, apart (Dim 25.10): a quiet line under each check, and the „Kes“ choice „Automaattest“. */
  auto?: Record<string, PageAnswer> | null;
  /** The signed-in admin: the first name for "Sina: …", and the tester ("maria" or "dim"; "auto": Automaattest, which sees every check; null: any other admin sees every check). */
  you: { name: string; tester: Tester | null };
  /** What a "deploy" mark of the plan reads as (server/testplan.ts testplanBuildAt). */
  buildAt: string;
};

export function TestPlan({ plan, initial, auto: initialAuto, you, buildAt }: TestPlanProps) {
  const t = adminEt.testplan;
  const uid = useId();
  const [answers, setAnswers] = useState(initial);
  /** Automaattest's answers as last read (never written by this page: its own session's are `answers`). */
  const [auto, setAuto] = useState<Record<string, PageAnswer>>(initialAuto ?? {});
  /** This is Automaattest's own session: its answers are `answers`, and no quiet line repeats them. */
  const own = you.tester === "auto";
  /** The server's answers could not be read (or the last read failed): the page says so, and the answers stay on the device. */
  const [down, setDown] = useState(initial === null);
  const [reading, setReading] = useState(false);
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

  const storedView = useSyncExternalStore(subscribeNothing, readView, () => null);
  const hash = useSyncExternalStore(subscribeNothing, readHash, () => "");
  // (Maria and Dim start on their own checks; Automaattest and any other admin on every check)
  const defaultWho: WhoChoice = you.tester === "maria" || you.tester === "dim" ? you.tester : "all";
  const view = useMemo(() => picked ?? parseView(storedView, defaultWho), [picked, storedView, defaultWho]);
  const choose = (next: View) => {
    setPicked(next);
    try {
      window.localStorage.setItem(VIEW_KEY, JSON.stringify(next));
    } catch {
      // storage full or blocked: the choice holds for this visit
    }
  };

  /**
   * What a read made of: the server's answers (a read that began before a save came back is older than that save and is not taken), or the
   * database is down. Automaattest's answers are always taken: no save of this page changes them.
   */
  const apply = useCallback((fresh: Read | null, before: number) => {
    if (fresh === null) {
      setDown(true);
      return;
    }
    if (writes.current === before) setAnswers(fresh.answers);
    setAuto(fresh.auto);
    setDown(false);
  }, []);
  /** "Värskenda": reads again, with the button saying it is busy. */
  const refresh = async () => {
    setReading(true);
    const before = writes.current;
    apply(await readServer(), before);
    setReading(false);
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
        setDown(false);
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
    const unsent = outbox ? outbox.unsent() : new Map<string, { status: Status; note: string }>();
    return { doc: docOf(answers, unsent), local: new Set(unsent.keys()) };
    // (`version` stands for what the outbox holds now)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, outbox, version]);
  const states = useMemo(() => new Map(plan.items.map((i) => [i.id, checkState(i, answerOf(doc.answers, i.id), plan, buildAt)])), [plan, doc, buildAt]);
  /** Automaattest's answers: its own session's are what it shows (`doc`, its presses included), anybody else's come apart (`auto`). */
  const autoDoc = useMemo(() => (own ? doc : docOf(auto, new Map())), [own, doc, auto]);
  const autoIds = useMemo(() => new Set(Object.keys(autoDoc.answers)), [autoDoc]);
  /** The quiet line under each check Automaattest answered, for Maria's and Dim's page: its answer, and whether a redo has overtaken it. */
  const autoLines = useMemo(() => {
    const lines = new Map<string, AutoLine>();
    if (own) return lines;
    for (const item of plan.items) {
      const stored = answerOf(autoDoc.answers, item.id);
      if (stored) lines.set(item.id, { answer: stored, overtaken: checkState(item, stored, plan, buildAt).overtaken !== null });
    }
    return lines;
  }, [own, plan, autoDoc, buildAt]);
  const byArea = useMemo(() => {
    const map = new Map<string, TestItem[]>();
    for (const item of plan.items) map.set(item.area, [...(map.get(item.area) ?? []), item]);
    return map;
  }, [plan]);
  const counts = useMemo(
    () => planCounts({ ...plan, items: plan.items.filter((i) => forWho(view.who, i, autoIds)) }, doc, buildAt, null),
    [plan, doc, buildAt, view.who, autoIds],
  );
  /** The area that starts open: the first with a check still open when the page was made (it does not move as the tester answers). */
  const firstOpen = useMemo(() => {
    const start = docOf(initial, new Map());
    const startAuto = new Set(Object.keys((own ? initial : initialAuto) ?? {}));
    return plan.items.find((i) => forWho(view.who, i, startAuto) && checkState(i, answerOf(start.answers, i.id), plan, buildAt).state === "open")?.area ?? null;
  }, [plan, initial, initialAuto, own, buildAt, view.who]);
  const hashArea = plan.items.find((i) => i.id === hash)?.area;

  const saveKey: OutboxStatus = outbox ? outbox.status() : "idle";
  // the answers cannot be read (the database is down) and nothing waits: "offline", whose text says the answers are kept on this device; so
  // only on a device that keeps them (with no storage they live in this page only, and a press shows "Salvestan…", then "Salvestamata…")
  const shownKey = saveKey === "idle" && down && (outbox === null || outbox.keeps()) ? "offline" : saveKey;
  const saveText = shownKey === "idle" ? "" : t[shownKey];

  const press = (item: TestItem, status: Status) => {
    const note = typed.get(item.id) ?? states.get(item.id)?.answer?.note ?? "";
    ensureOutbox().answer(item.id, status, note);
    // (the note box is there under every answer; only a Viga takes the focus into it: an OK or a skip must not raise a phone's keyboard)
    if (status === "bad") focusAfterRef.current = item.id;
  };
  const type = (item: TestItem, status: Status, value: string) => {
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
      <div className={styles.head}>
        <p className={styles.progress} data-progress="">
          {fill(t.progress, counts)}
        </p>
        <div className={styles.headRow}>
          {you.tester !== null && you.name !== "" && (
            <p className={`${ui.muted} ${styles.you}`} data-you="">
              {fill(t.you, { name: you.name })}
            </p>
          )}
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} aria-busy={reading} onClick={() => void refresh()} data-refresh="">
            {t.refresh}
          </button>
        </div>
        <p role="status" className={styles.status} data-save-status={shownKey}>
          {saveText}
        </p>
        <div className={styles.filters}>
          {FILTERS.map((f) => (
            <button key={f} type="button" className={`${ui.pill} ${view.filter === f ? styles.on : ""}`} aria-pressed={view.filter === f} onClick={() => choose({ ...view, filter: f })} data-filter={f}>
              {t.filter[f]}
            </button>
          ))}
        </div>
        <div className={styles.filters} role="group" aria-labelledby={`${uid}-who`}>
          <span id={`${uid}-who`} className={ui.filtersLabel}>
            {t.who.label}
          </span>
          {WHOS.map((w) => (
            <button key={w} type="button" className={`${ui.pill} ${view.who === w ? styles.on : ""}`} aria-pressed={view.who === w} onClick={() => choose({ ...view, who: w })} data-who={w}>
              {t.who[w]}
            </button>
          ))}
        </div>
      </div>

      {plan.areas.map((area) => {
        if (area.checks === false) {
          // a notes-only area ("Enne alustamist", "Koristamine"): its words, always in view, with the filter off
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
        const mine = (byArea.get(area.id) ?? []).filter((i) => i.id === hash || forWho(view.who, i, autoIds));
        const shown = mine.filter((i) => i.id === hash || passes(view.filter, i, states.get(i.id)));
        if (shown.length === 0) return null;
        const done = mine.filter((i) => states.get(i.id)?.state === "done").length;
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
                <span className={`${ui.tag} ${styles.count}`}>{fill(t.areaCount, { done, total: mine.length })}</span>
              </button>
            </h2>
            {area.note && <p className={styles.areaNote}>{area.note}</p>}
            {open && (
              <ol id={`${uid}-body-${area.id}`} className={styles.checks}>
                {shown.map((item) => (
                  <Check
                    key={item.id}
                    t={t}
                    item={item}
                    st={states.get(item.id)!}
                    auto={autoLines.get(item.id) ?? null}
                    unsent={local.has(item.id)}
                    typed={typed.get(item.id)}
                    focusAfterRef={focusAfterRef}
                    onPress={(status) => press(item, status)}
                    onType={(status, value) => type(item, status, value)}
                    onLeave={() => leave(item)}
                  />
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Automaattest's answer to a check, for its quiet line (Dim 25.10); `overtaken`: a redo since then has made it one from before the change. */
type AutoLine = { answer: StoredAnswer; overtaken: boolean };

type CheckProps = {
  t: Texts;
  item: TestItem;
  st: CheckState;
  /** Automaattest's answer to this check, shown apart under it (null: none, or this is Automaattest's own page). */
  auto: AutoLine | null;
  /** The shown answer is one not sent yet (no "last answer" line: it is not the server's). */
  unsent: boolean;
  typed: string | undefined;
  /** The check whose note field takes the focus when it appears (set by a "Viga" press). */
  focusAfterRef: MutableRefObject<string | null>;
  onPress(status: Status): void;
  onType(status: Status, value: string): void;
  onLeave(): void;
};

/** An answer's instant as the page shows it: "dd.mm HH:MM", Tallinn time. */
const whenOf = (at: string): string => `${formatDayMonth(new Date(at), "et")} ${formatTime(new Date(at), "et")}`;

/**
 * One check (spec §4): title, chips, "Ava", steps, "Miks", what to see, the three buttons, the note box (under every answer), the last answer and
 * the one a redo has overtaken; and (Dim 25.10) Automaattest's answer apart, one quiet line with its note under it.
 */
function Check({ t, item, st, auto, unsent, typed, focusAfterRef, onPress, onType, onLeave }: CheckProps) {
  const uid = useId();
  const answer = st.answer;
  const noteId = `${uid}-note`;
  const when = answer && !unsent ? whenOf(answer.at) : "";

  return (
    <li id={item.id} className={`${styles.check} ${styles[st.state]}`} data-check={item.id} data-check-state={st.state}>
      <div className={styles.checkHead}>
        <h3 className={styles.checkTitle}>{item.title}</h3>
        <div className={styles.chips}>
          <span className={styles.chip} data-chip="">
            {t.who[item.who]}
          </span>
          {item.device !== "any" && (
            <span className={styles.chip} data-chip="">
              {t.device[item.device]}
            </span>
          )}
          {item.writes && (
            <span className={`${styles.chip} ${styles.writes}`} data-chip="">
              {t.writes}
            </span>
          )}
          {item.mark && (
            <span className={`${styles.chip} ${styles[item.mark]}`} data-mark="">
              {t.mark[item.mark]}
            </span>
          )}
        </div>
        {item.href && (
          <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.open}`} href={item.href} target="_blank" rel="noopener" data-open="">
            {t.open} <span aria-hidden="true">↗</span>
            <span className={ui.sr}> ({adminEt.shell.newWindow})</span>
          </a>
        )}
      </div>

      <ol className={styles.steps}>
        {item.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <details className={styles.why}>
        <summary>{t.why}</summary>
        <p>{item.why}</p>
      </details>
      <p className={styles.expectLabel}>{t.expect}</p>
      <ul className={styles.expect}>
        {item.expect.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>

      <div className={styles.answers}>
        {STATUSES.map((status) => (
          <button key={status} type="button" className={styles.answer} aria-pressed={answer?.status === status} onClick={() => onPress(status)} data-answer={status}>
            {t[status]}
          </button>
        ))}
      </div>

      {answer && (
        // the note: open under every answer (Dim 22.10); a check with no answer has nothing to write a note on. A Viga asks what went wrong, an OK or a skip just says „Märkus“.
        <div className={styles.noteBox}>
          <textarea
            id={noteId}
            ref={(el) => {
              if (el && focusAfterRef.current === item.id) {
                focusAfterRef.current = null;
                el.focus();
              }
            }}
            className={`${ui.textarea} ${styles.note}`}
            aria-label={t.note}
            placeholder={answer.status === "bad" ? t.notePrompt : t.note}
            maxLength={NOTE_MAX}
            value={typed ?? answer.note}
            onChange={(e) => onType(answer.status, e.target.value)}
            onBlur={onLeave}
            data-check-note=""
          />
        </div>
      )}

      {answer && !unsent && (
        <p className={styles.last} data-check-last="">
          {fill(t.last, { name: answer.by, when, status: statusText(t, answer.status) })}
        </p>
      )}
      {st.overtaken && (
        <p className={styles.overtaken} data-overtaken="">
          {fill(t.overtaken, { status: statusText(t, st.overtaken.status) })}
        </p>
      )}
      {auto && (
        // Automaattest's answer: never this tester's, so it fills no button, no note and no count; one from before a redo says so in the page's words
        <div className={styles.auto}>
          <p data-check-auto="">
            {t.who.auto}: {auto.overtaken ? fill(t.overtaken, { status: statusText(t, auto.answer.status) }) : statusText(t, auto.answer.status)} · {whenOf(auto.answer.at)}
          </p>
          {auto.answer.note !== "" && (
            <p className={styles.autoNote} data-check-auto-note="">
              {auto.answer.note}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
