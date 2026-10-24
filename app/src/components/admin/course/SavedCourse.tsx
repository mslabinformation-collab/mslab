"use client";

import { useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SAVE_TIMEOUT_MS } from "@/components/admin/autosave/constants";
import type { AutosaveStatus } from "@/domain/autosave";
import { type EditorPart, type EditorParts, type PartValues } from "@/domain/course-parts";
import { adminEt } from "@/i18n/dict/admin";
import { contentVersion } from "@/lib/version";
import { setCoursePublished, setCourseSample } from "@/server/actions/admin-content";
import type { AdminModule } from "@/server/admin-lessons";
import type { BlockedPart, PublishResult, SwitchResult } from "@/server/course-parts";
import { PublishBar } from "../PublishBar";
import { SaveStatus } from "../SaveStatus";
import ui from "../ui.module.css";
import styles from "../CourseEditor.module.css";
import { combineStatus, publishLabels } from "./course-view";
import { CourseView } from "./CourseView";
import { OutlineTextsContext, type OutlineTextRow, type OutlineTexts } from "./OutlineTexts";
import { usePhoneChip } from "./usePhoneChip";
import { focusPartField, useCoursePart, type SaveAnswer, type SaveEar } from "./useCoursePart";
import type { CourseEditorData, CourseParts, OtherCourse } from "./types";

// A saved course's editor (admin UX pass piece 3a, Task 7; README B2, §1.3, §1.8; rulings R-a…R-d). Every card autosaves its part from the version
// the page read (useCoursePart): a published course's into its draft, with the PublishBar under the H1 naming what waits („Avaldamata muudatused:
// {n} · {labels}. Avalikul lehel on näha eelmine versioon.“), „Eelvaade ↗“ (the public page at the course's LIVE address in draft mode: a drafted
// address is live only after the publish), „Loobu muudatustest“ and „Avalda muudatused“; an unpublished course's straight to the record, with no bar.
//
// The engines start from the versions the page read and keep their own afterwards. After anything that moves versions the engines do not hold — a
// publish, a discard, the „Avalikul lehel“ switch (R-d publishes the drafts first), and on an unpublished course a type the server holds that is
// not the one the page read (its save empties the other type's parts, Task 4) — the page is read again (router.refresh) and the editor starts once
// more from it (a new `generation`): its cards from the new versions and values, the focus back on the control it was on if nothing else has it.
//
// The cards wait (inert and aria-busy, nothing typed taken: a text typed then would be a copy on a version the server is moving, a false „Muudeti
// teises aknas“ after the restart; review I-2, round 2) from the press of „Avalda muudatused“, „Jah, loobu“ or „Avalikul lehel“ through its request
// until the new read, and on an unpublished course while the type's own save is on its way. Every such wait has one bound, SAVE_TIMEOUT_MS from when
// it began (review round 3 ruling): the request is given up then (its abort, and whatever it does after is not waited for), the cards take typing
// again, and since the outcome is unknown the page is read again — never a failure line (as M-2); the next read starts the cards over. A discard's
// cards (their copies gone and their engines muted, review I-1) cannot wait for that read: they start over at the bound from what the discard left,
// the live values at their live versions. The type's save is bounded by its sender (useCoursePart). A failure that is known (a refusal, a server
// error, no connection) lets the cards go at once, with its words; the focus goes back on the control it was on (round 3 NB-3).
//
// A picture whose upload ends while the cards wait is not lost: every card's list change goes through `route`, which looks at the form on screen
// when it is called (an upload's callback comes from the render where the file was picked, review round 3 N-3), and a change that comes while the
// cards wait goes in once they take typing again, on the version they then hold. What is not the engines' (the published flag, the modules and
// their labels) follows every new read of the page, and so does what the bar and the switches have to say (kept here, above the restart).
//
// The modules card (Task 9) is one more card: its adds, moves and deletes are server actions whose answer brings the page's new read, which the
// cards take as any other read — no restart, so a field typed and not yet saved stays as it is — and a module's name autosaves on its own route
// (R-b2) as one of the editor's autosaves (course/OutlineTexts.ts): saved before a publish, a discard or the switch, its copy dropped with a
// discard, its status in the chip and „Kontrolli“ on the map; once a name is stored the page is read again for the bar's labels, unless a press is
// on its way (its own read follows, and a read asked before it must not be the one that starts the cards over).

const t = adminEt.courseEditor;

/** The bound passed: what a request does after it is not waited for. */
const LATE = Symbol("late");

/** `p`, or LATE once `signal` is aborted (the wait's bound), whichever comes first. */
function orLate<T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof LATE> {
  if (signal.aborted) return Promise.resolve(LATE);
  return new Promise((resolve) => {
    const onAbort = () => resolve(LATE);
    signal.addEventListener("abort", onAbort, { once: true });
    void p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? LATE : v);
      },
      () => resolve(LATE),
    );
  });
}

type Posted = { ok: true; body: unknown } | { ok: false; signedOut: boolean } | { late: true };

/** POST to one of the course's routes, given up when `signal` is (the wait's bound): `late`. `signedOut` for withAdmin's 401; not ok for any other refusal or no answer. */
async function post(url: string, signal: AbortSignal): Promise<Posted> {
  const request = (async (): Promise<Posted> => {
    try {
      const res = await fetch(url, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" }, signal });
      if (!res.ok) return { ok: false, signedOut: res.status === 401 };
      return { ok: true, body: await res.json().catch(() => null) };
    } catch {
      return { ok: false, signedOut: false };
    }
  })();
  const answer = await orLate(request, signal);
  return answer === LATE ? { late: true } : answer;
}

/** A publish or a discard that failed (Dim 24.10, D-2): signed out, or its own line. */
const failedLine = (action: "publish" | "discard", signedOut: boolean) =>
  signedOut ? adminEt.leave.reasons.signedOut : action === "publish" ? adminEt.publish.publishFailed : adminEt.publish.discardFailed;

/** The PublishBar's blocked list of a publish's answer (S3-P3-b): the missing fields' labels, the labels of the parts changed meanwhile. */
function blockedOf(parts: readonly BlockedPart[] | null): { missing: string[]; changed: string[] } | undefined {
  if (!parts || parts.length === 0) return undefined;
  return { missing: parts.filter((p) => p.reason === "missing").flatMap((p) => p.fields), changed: parts.filter((p) => p.reason === "changed").flatMap((p) => p.fields) };
}

/** What a discard leaves: every part at its live value and live version, "l:<hash>" (server/course-parts.ts partStateOf, the same hash). */
async function liveSeeds(parts: EditorParts): Promise<EditorParts> {
  const entries = await Promise.all(Object.entries(parts).map(async ([part, seed]) => [part, { version: `l:${await contentVersion(seed.live)}`, value: seed.live, live: seed.live }] as const));
  return Object.fromEntries(entries) as unknown as EditorParts;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The type a basics save's answer says the server holds: a 200's, the one it sent (if it did); a conflict's (409), the stored one. */
function storedType(patch: Record<string, unknown>, answer: SaveAnswer): unknown {
  const reply = answer && isRecord(answer.body) ? answer.body : null;
  if (answer?.status === 200 && reply?.ok === true) return patch.type;
  if (answer?.status === 409 && reply?.error === "conflict" && isRecord(reply.value)) return reply.value.type;
  return undefined;
}

/**
 * A selector that finds a control of the editor again once it has started over (its ids are made anew): a type radio by its value, a field by its
 * name, else the control's first data attribute when that is the only one of its kind in the editor („Avalda muudatused“, ET | RU). Null: none.
 */
function focusKey(el: Element | null): string | null {
  if (!(el instanceof HTMLElement)) return null;
  const editor = el.closest("[data-course-editor]");
  if (!editor) return null;
  if (el instanceof HTMLInputElement && el.type === "radio" && el.closest("[data-type-switch]")) return `[data-type-switch] input[value="${el.value}"]`;
  const field = el.getAttribute("data-field") ?? el.getAttribute("data-i18n");
  if (field) return `[data-course-editor] [data-field="${field}"], [data-course-editor] [data-i18n="${field}"]`;
  const hook = Array.from(el.attributes).find((a) => a.name.startsWith("data-"));
  if (!hook) return null;
  const key = `[data-course-editor] [${hook.name}="${hook.value.replace(/["\\]/g, "")}"]`;
  return editor.ownerDocument.querySelectorAll(key).length === 1 ? key : null;
}

type Shared = {
  data: CourseEditorData;
  others: OtherCourse[];
  next: { startsAt: string; city: string } | null;
  created: boolean;
  modules: AdminModule[];
};

/**
 * The parts the last publish (or the R-d switch) could not publish, with each card's count of saves then (`generation`: the editor they were counted
 * in; after a restart every card counts from 0): a part leaves the list with its next save (review M-3).
 */
type Blocked = { parts: BlockedPart[]; generation: number; saves: Partial<Record<string, number>> };

/** What the bar and the switches say and show; it stays when the editor starts over (a publish that held some parts lists them after the read). */
type Said = {
  blocked: Blocked | null;
  barError: string | null;
  switchError: string | null;
  priceRefused: boolean;
  /** The switches' boxes show what was asked until the server's new state arrives, the switch is refused, or SAVE_TIMEOUT_MS has gone by. */
  asked: { published?: boolean; sample?: boolean };
  /** When „Avalda muudatused“ last went through: the chip's „Salvestatud {HH:MM}“ after it (piece3-texts §4), the cards having started over. */
  publishedAt: Date | null;
};
const QUIET: Said = { blocked: null, barError: null, switchError: null, priceRefused: false, asked: {}, publishedAt: null };

/** A part's change worked out from the field when it lands (a gallery upload's): `route` takes it to the form on screen, or keeps it while the cards wait. */
type Change = { part: EditorPart; name: string; fn: (current: unknown) => unknown };
/** A part's `update`, whatever the part. */
type LooseUpdate = (name: string, fn: (current: unknown) => unknown) => void;
/** The form on screen, as `route` sees it. */
type OnScreen = { frozen: boolean; apply: (change: Change) => void };
/** A wait of the cards: from the press (or the type's confirmation) until the restart; aborted at its bound. */
type Hold = { abort: AbortController };

/** What the editor shell gives the form for the waits (kept above the restart). */
type Waits = {
  /** The cards wait (from now, or as they already do); the wait's signal is aborted at its bound. */
  hold: () => AbortSignal;
  /** A refusal or a failure: the cards take typing again, nothing is read. */
  release: () => void;
  /** The page is read again and the cards start over from it, waiting meanwhile; `live`: after a discard, the seeds to start over from at the bound. */
  reload: (live?: EditorParts) => void;
  /** The page is read again and the cards start over from it; nothing waits meanwhile (an outcome unknown after the bound). */
  reread: () => void;
  /** The page is read again for what only the server says (the modules' labels), starting no card over; nothing while a press or a switch is on its way. */
  readLabels: () => void;
  /** A change of a part for the form on screen (now, or once its cards take typing again). */
  route: (change: Change) => void;
  /** The form on screen tells how a change goes in and whether its cards wait (null: it is gone). */
  onScreen: (form: OnScreen | null) => void;
  /** The changes that came while the cards waited, and a tick that tells the form there is one. */
  late: { take: () => Change[]; tick: number };
};

export function SavedCourse(props: Shared) {
  const { data } = props;
  const router = useRouter();
  const [seen, setSeen] = useState(data);
  const [seeds, setSeeds] = useState(data.parts);
  const [generation, setGeneration] = useState(0);
  /** The page's new read was asked for: the next one starts the cards over. */
  const [awaiting, setAwaiting] = useState(false);
  /** The cards wait (a press through its request and the read). */
  const [hold, setHold] = useState<Hold | null>(null);
  const [said, setSaid] = useState<Said>(QUIET);
  // the hold as the handlers see it now (set with the state, so two handlers of one turn share it), and a discard's seeds for the bound
  const holding = useRef<Hold | null>(null);
  const discarded = useRef<EditorParts | null>(null);
  useLayoutEffect(() => {
    holding.current = hold;
  }, [hold]);
  useEffect(() => {
    discarded.current = null;
  }, [generation]);
  // the changes that came while the cards waited (an upload that ended meanwhile), and the form that is on screen
  const late = useRef<Change[]>([]);
  const [lateTick, setLateTick] = useState(0);
  const form = useRef<OnScreen | null>(null);
  const onScreen = useCallback((now: OnScreen | null) => {
    form.current = now;
  }, []);
  const route = useCallback((change: Change) => {
    const now = form.current;
    if (now && !now.frozen) return now.apply(change);
    late.current.push(change);
    setLateTick((n) => n + 1);
  }, []);
  const takeLate = useCallback(() => late.current.splice(0), []);
  // a switch's answer is awaited (its box shows what was asked until the next read): a read for the labels would show the stored state before it
  const switching = useRef(false);
  useLayoutEffect(() => {
    switching.current = said.asked.published !== undefined || said.asked.sample !== undefined;
  });
  // the reads for the labels asked and not come yet: a wait that begins meanwhile lets those pass (they may be from before the press; the router runs
  // one read after another, so the wait's own comes after them) and starts the cards over from the one after them
  const [labelsAsked, setLabelsAsked] = useState(0);
  const labelsOnTheWay = useRef(0);
  useLayoutEffect(() => {
    labelsOnTheWay.current = labelsAsked;
  });
  const [passReads, setPassReads] = useState(0);
  const readLabels = useCallback(() => {
    if (holding.current || switching.current) return;
    setLabelsAsked((n) => n + 1);
    startTransition(() => router.refresh());
  }, [router]);
  // the control of the editor the focus was last on (kept above the restart): a restart or a release puts it back there — the control she pressed,
  // or the one she moved to while the cards waited, never one she has left (inert cards drop the focus to <body>, which is no control)
  const lastFocus = useRef<string | null>(null);
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      lastFocus.current = focusKey(e.target instanceof Element ? e.target : null);
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);
  if (data !== seen) {
    setSeen(data);
    setSaid((s) => ({ ...s, asked: {} }));
    if (labelsAsked > 0) setLabelsAsked(labelsAsked - 1);
    if (awaiting && passReads > 0) setPassReads(passReads - 1);
    else if (awaiting) {
      setSeeds(data.parts);
      setGeneration((g) => g + 1);
      setAwaiting(false);
      setHold(null);
    }
  }
  const beginHold = useCallback(() => {
    const h = holding.current ?? { abort: new AbortController() };
    holding.current = h;
    setHold(h);
    return h.abort.signal;
  }, []);
  const release = useCallback(() => {
    holding.current = null;
    setHold(null);
  }, []);
  const reread = useCallback(() => {
    setPassReads(labelsOnTheWay.current);
    setAwaiting(true);
    startTransition(() => router.refresh());
  }, [router]);
  const reload = useCallback(
    (live?: EditorParts) => {
      beginHold();
      if (live) discarded.current = live;
      reread();
    },
    [beginHold, reread],
  );
  // the wait's bound: SAVE_TIMEOUT_MS from when it began, whatever it waits for — the request given up, the cards take typing (a discard's from what
  // it left), the outcome unknown: the page is read again, and the next read starts the cards over
  useEffect(() => {
    if (!hold) return;
    const timer = setTimeout(() => {
      if (holding.current !== hold) return;
      hold.abort.abort();
      const live = discarded.current;
      discarded.current = null;
      void (live ? liveSeeds(live) : Promise.resolve(null)).then((restart) => {
        if (holding.current !== hold) return; // a read came meanwhile
        holding.current = null;
        setHold(null);
        setSaid((s) => ({ ...s, asked: {} }));
        if (restart) {
          setSeeds(restart);
          setGeneration((g) => g + 1);
        }
        reread();
      });
    }, SAVE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [hold, reread]);
  // a switch that holds no card („Näidissisu“) has the same bound: its box shows the stored state again and the page is read
  const asking = said.asked.published !== undefined || said.asked.sample !== undefined;
  useEffect(() => {
    if (!asking || hold) return;
    const timer = setTimeout(() => {
      setSaid((s) => ({ ...s, asked: {} }));
      startTransition(() => router.refresh());
    }, SAVE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [asking, hold, router]);
  /** The focus back on the control she was last on, when it is there and nothing else has it, else the H1 (its bar's button is gone after a publish). */
  const refocus = useCallback(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const key = lastFocus.current;
    (document.querySelector<HTMLElement>(key ?? "[data-course-title]") ?? document.querySelector<HTMLElement>("[data-course-title]"))?.focus();
  }, []);
  return (
    <SavedForm
      key={generation}
      {...props}
      seeds={seeds}
      generation={generation}
      waiting={hold !== null}
      waits={{ hold: beginHold, release, reload, reread, readLabels, route, onScreen, late: { take: takeLate, tick: lateTick } }}
      refocus={refocus}
      said={said}
      setSaid={setSaid}
    />
  );
}

function SavedForm({
  data,
  others,
  next,
  created,
  modules,
  seeds,
  generation,
  waiting,
  waits,
  refocus,
  said,
  setSaid,
}: Shared & {
  seeds: EditorParts;
  generation: number;
  /** A publish, a discard or the switch, or the page's new read, is on its way: the cards wait for it. */
  waiting: boolean;
  waits: Waits;
  /** Puts the focus back on the control she was last on (only while nothing has it). */
  refocus: () => void;
  said: Said;
  setSaid: (update: (s: Said) => Said) => void;
}) {
  const { id, published, liveType } = data;
  const { hold, release, reload, reread, readLabels, route, onScreen, late } = waits;
  const common = { courseId: id, published, liveType };
  // an unpublished course's „Põhiinfo“ saves are heard (its type)
  const ear = useRef<SaveEar | null>(null);
  const hooks = {
    basics: useCoursePart({ ...common, part: "basics", seed: seeds.basics, ear }),
    price: useCoursePart({ ...common, part: "price", seed: seeds.price }),
    outcomes: useCoursePart({ ...common, part: "outcomes", seed: seeds.outcomes }),
    includes: useCoursePart({ ...common, part: "includes", seed: seeds.includes }),
    protocolStages: useCoursePart({ ...common, part: "protocolStages", seed: seeds.protocolStages }),
    test: useCoursePart({ ...common, part: "test", seed: seeds.test }),
    certificate: useCoursePart({ ...common, part: "certificate", seed: seeds.certificate }),
    gallery: useCoursePart({ ...common, part: "gallery", seed: seeds.gallery }),
    recommendations: useCoursePart({ ...common, part: "recommendations", seed: seeds.recommendations }),
    badge: useCoursePart({ ...common, part: "badge", seed: seeds.badge }),
  };
  const order = Object.keys(hooks) as EditorPart[];
  const type = hooks.basics.api.fields.type;

  // An unpublished course's type changed: its save empties the other type's parts on the server (new versions). The cards wait while „Põhiinfo“'s
  // save of a type other than the page read is on its way — from the moment it goes (a part in conflict or gone sends nothing, so nothing waits:
  // review round 3 NB-1) until it ends, whatever its end: a refusal, an error, no connection let them go at once, and that type's retries never
  // hold them again (round 2 N-2); none in SAVE_TIMEOUT_MS (the sender's bound) lets them go and has the page read again, its outcome unknown. Any
  // answer of „Põhiinfo“ that says the server holds another type than the page read — a 200 that sent it, or a conflict's stored value, as a lost
  // answer's retry meets it (round 3 NB-2) — has the page read again, the cards waiting from that moment.
  const typeSave = useRef<{ waiting: boolean; type: unknown; ended: unknown[] }>({ waiting: false, type: undefined, ended: [] });
  /** The page's read asked for by this form for another stored type (once: the cards wait for it). */
  const reloaded = useRef(false);
  const [typeSaving, setTypeSaving] = useState(false);
  useLayoutEffect(() => {
    const read = seeds.basics.value.type;
    ear.current = published
      ? null
      : {
          sent: (patch) => {
            const s = typeSave.current;
            if (s.waiting || !("type" in patch) || patch.type === read || s.ended.includes(patch.type)) return;
            typeSave.current = { ...s, waiting: true, type: patch.type };
            setTypeSaving(true);
          },
          ended: (patch, answer, isLate) => {
            const s = typeSave.current;
            const held = s.waiting && "type" in patch && patch.type === s.type;
            if (held) {
              typeSave.current = { waiting: false, type: undefined, ended: [...s.ended, s.type] };
              setTypeSaving(false);
            }
            const stored = storedType(patch, answer);
            if (stored !== undefined && stored !== read) {
              if (!reloaded.current) {
                reloaded.current = true;
                reload();
              }
            } else if (held && isLate) reread();
          },
        };
  });
  const frozen = waiting || typeSaving;
  // the modules card's names (course/OutlineTexts.ts): each row's autosave joins the editor's, and says its status
  const textRows = useRef(new Set<OutlineTextRow>());
  const [textStatus, setTextStatus] = useState<Record<string, AutosaveStatus>>({});
  const joinText = useCallback((row: OutlineTextRow) => {
    textRows.current.add(row);
    return () => void textRows.current.delete(row);
  }, []);
  const reportText = useCallback((key: string, status: AutosaveStatus | null) => {
    setTextStatus((all) => {
      if (status === null) {
        if (!(key in all)) return all;
        const rest = { ...all };
        delete rest[key];
        return rest;
      }
      return all[key] === status ? all : { ...all, [key]: status };
    });
  }, []);
  const outlineTexts = useMemo<OutlineTexts>(
    () => ({ join: joinText, report: reportText, stored: published ? readLabels : () => {}, frozen }),
    [joinText, reportText, published, readLabels, frozen],
  );
  const textStatuses = Object.values(textStatus);
  const textAttention = textStatuses.some((x) => x.kind === "invalid" || x.kind === "conflict" || x.kind === "gone");
  // the form on screen, for `route` (a card's list change, whenever it comes)
  useLayoutEffect(() => {
    onScreen({ frozen, apply: (change) => (hooks[change.part].api.update as unknown as LooseUpdate)(change.name, change.fn) });
    return () => onScreen(null);
  });
  const parts = Object.fromEntries(
    order.map((part) => {
      const api = hooks[part].api as CourseParts[EditorPart];
      const update = ((name: string, fn: (current: unknown) => unknown) => route({ part, name, fn })) as unknown as typeof api.update;
      // nothing typed is taken while the cards wait; a list change (a picture's upload that ends) goes in once they take typing again (`route`)
      return [part, frozen ? { ...api, set: () => {}, commit: () => {}, update } : { ...api, update }];
    }),
  ) as CourseParts;

  // the changes that came while the cards waited go in once they take typing again (after the restart, a refusal or the bound)
  const applyLate = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    applyLate.current = () => {
      for (const change of late.take()) (hooks[change.part].api.update as unknown as LooseUpdate)(change.name, change.fn);
    };
  });
  useEffect(() => {
    if (!frozen) applyLate.current();
  }, [frozen, late.tick]);
  // the cards let go without a restart (a refusal, a failure, the bound): the focus back where it was (inert cards dropped it; review round 3 NB-3)
  const wasFrozen = useRef(false);
  useEffect(() => {
    if (frozen) wasFrozen.current = true;
    else if (wasFrozen.current) {
      wasFrozen.current = false;
      refocus();
    }
  }, [frozen, refocus]);
  // the editor started over (after a publish, a discard, a switch, a type change, the bound): the focus back on the control she was last on, or the H1
  useLayoutEffect(() => {
    if (generation > 0) refocus();
  }, [generation, refocus]);

  const phone = usePhoneChip();
  const { asked } = said;
  // the parts the publish held, until each one's next save
  const blocked = (said.blocked?.parts ?? []).filter((b) => {
    const hook = order.includes(b.part as EditorPart) ? hooks[b.part as EditorPart] : null;
    const before = said.blocked?.generation === generation ? (said.blocked.saves[b.part] ?? 0) : 0;
    return !hook || hook.saves <= before;
  });
  const savesNow = () => Object.fromEntries(order.map((part) => [part, hooks[part].saves]));

  /** Every card's waiting save (the modules' names too), sent now and waited for: a publish, a discard or the switch work on what is saved. */
  const flushAll = () => Promise.all([...order.map((part) => hooks[part].flushNow()), ...Array.from(textRows.current, (row) => row.flush())]);

  const publish = async () => {
    setSaid((s) => ({ ...s, barError: null }));
    const signal = hold();
    if ((await orLate(flushAll(), signal)) === LATE) return;
    const answer = await post(`/api/admin/koolitus/${id}/avalda`, signal);
    if ("late" in answer) return; // (the bound: the cards take typing, the page is read)
    if (!answer.ok) {
      release();
      return setSaid((s) => ({ ...s, barError: failedLine("publish", answer.signedOut) }));
    }
    const result = answer.body as PublishResult | null;
    const held = Array.isArray(result?.blocked) && result.blocked.length > 0 ? result.blocked : null;
    const done = Array.isArray(result?.published) && result.published.length > 0;
    setSaid((s) => ({ ...s, blocked: held ? { parts: held, generation, saves: savesNow() } : null, publishedAt: done ? new Date() : s.publishedAt }));
    // something went live, or nothing was there to go (another tab published or threw it away meanwhile, or an answer that cannot be read): the
    // page is read again (review M-2)
    if (done || !held) reload();
    else release();
  };

  const discard = async () => {
    setSaid((s) => ({ ...s, barError: null }));
    const signal = hold();
    if ((await orLate(flushAll(), signal)) === LATE) return;
    const answer = await post(`/api/admin/koolitus/${id}/loobu`, signal);
    if ("late" in answer) return;
    if (!answer.ok) {
      release();
      setSaid((s) => ({ ...s, barError: failedLine("discard", answer.signedOut) }));
      throw new Error("discard failed"); // (the question stays open)
    }
    // what was thrown away must not come back: every part's copy in this browser goes before the cards start over (review I-1); muted, they start
    // over from the read, or at the bound from the live values the discard left (round 2 N-1, round 3)
    for (const part of order) hooks[part].discardCopy();
    for (const row of textRows.current) row.discardCopy();
    setSaid((s) => ({ ...s, blocked: null }));
    reload(seeds);
  };

  const switchPublished = async (on: boolean) => {
    if (asked.published !== undefined || asked.sample !== undefined) return;
    setSaid((s) => ({ ...s, switchError: null, asked: { published: on } }));
    const signal = hold();
    // switched off, the drafts are published first (R-d): they get what is typed
    if (!on && (await orLate(flushAll(), signal)) === LATE) return;
    const action = (async (): Promise<SwitchResult> => {
      try {
        return await setCoursePublished({ id, on });
      } catch {
        return { ok: false, error: "server" };
      }
    })();
    const result = await orLate(action, signal);
    if (result === LATE) return;
    if (result.ok) {
      setSaid((s) => ({ ...s, blocked: null, priceRefused: false }));
      return reload();
    }
    release();
    setSaid((s) => {
      const quiet = { ...s, asked: {} };
      if (result.error === "blocked") return { ...quiet, blocked: { parts: result.blocked, generation, saves: savesNow() } };
      if (result.error === "invalid" && Object.values(result.fields ?? {}).includes("priceRequired")) return { ...quiet, priceRefused: true, switchError: t.errors.priceRequired };
      return { ...quiet, switchError: adminEt.common.saveError };
    });
  };

  const switchSample = async (on: boolean) => {
    if (asked.published !== undefined || asked.sample !== undefined) return;
    setSaid((s) => ({ ...s, switchError: null, asked: { sample: on } }));
    let result: SwitchResult;
    try {
      result = await setCourseSample({ id, on });
    } catch {
      result = { ok: false, error: "server" };
    }
    // done: the action has the page read again (its refresh), and the box shows the stored state then; refused, unless the bound came first
    if (!result.ok) setSaid((s) => (s.asked.sample === on ? { ...s, asked: {}, switchError: adminEt.common.saveError } : s));
  };

  // the price a published course must have: missing at the publish (S3-P3-b), or the switch on refused for it; gone once a price is typed
  const price = parts.price.fields;
  const missing = blocked.some((b) => b.reason === "missing") || said.priceRefused;
  const hasPrice = type === "e_learning" ? price.price.trim() !== "" : price.priceGroup.trim() !== "" || price.priceIndividual.trim() !== "";
  const combined = combineStatus([...order.map((part) => hooks[part].status), ...textStatuses]);
  // after a publish the cards start over with no save of their own yet: the chip keeps the publish's time
  const status = combined.kind === "saved" && combined.at === null && said.publishedAt ? { kind: "saved" as const, at: said.publishedAt } : combined;
  const compared = Object.fromEntries(order.map((part) => [part, { value: parts[part].fields, live: seeds[part].live }])) as { [P in EditorPart]: { value: PartValues[P]; live: PartValues[P] } };
  const changed = published ? publishLabels(type, compared, data.outline) : [];
  /** SaveStatus's „Näita“: the first field held back, in screen order. */
  const showInvalid = () => {
    for (const part of order) {
      const why = hooks[part].unconfirmed();
      if (why?.reason === "invalid" && why.field) return focusPartField(part, why.field);
    }
    // (a module's name held back)
    document.querySelector<HTMLElement>("[data-lessons-editor] [data-module-name] [aria-invalid='true']")?.focus();
  };

  const mapBlocked = blocked.map((b) => b.part);

  return (
    <OutlineTextsContext.Provider value={outlineTexts}>
      <CourseView
        title={parts.basics.fields.title.et.trim() || t.newTitle}
        published={published}
        sample={asked.sample ?? data.isSample}
        // the draft's words („Mustand salvestatud“) while something waits for „Avalda muudatused“; after the publish „Salvestatud {HH:MM}“ (§4)
        status={
          <span className={styles.statusSlot}>
            <SaveStatus status={status} draft={published && changed.length > 0} compact={phone} thing={t.thing} onShowInvalid={showInvalid} />
          </span>
        }
        publicHref={published ? `/koolitused/${data.slug}` : null}
        notice={
          created ? (
            <p className={ui.notice} role="status">
              {t.created}
            </p>
          ) : undefined
        }
        bar={
          published ? (
            <PublishBar
              changed={changed}
              previewHref={`/api/admin/eelvaade?tee=${encodeURIComponent(`/koolitused/${data.slug}`)}`}
              // (nothing left to publish: no bar, never „Avaldamata muudatused: 0“; review M-3)
              blocked={changed.length > 0 ? blockedOf(blocked) : undefined}
              error={said.barError}
              onDiscard={discard}
              onPublish={publish}
            />
          ) : undefined
        }
        parts={parts}
        courseId={id}
        modules={modules}
        others={others}
        next={next}
        locked={data.typeLocked}
        liveType={liveType}
        priceMissing={missing && !hasPrice}
        // (a module's name held back, in conflict or gone: the modules' map entry says „Kontrolli“ too)
        blocked={textAttention ? [...mapBlocked, "outline"] : mapBlocked}
        frozen={frozen}
        switches={{
          published: asked.published ?? published,
          sample: asked.sample ?? data.isSample,
          onPublished: (on) => void switchPublished(on),
          onSample: (on) => void switchSample(on),
          busy: asked.published !== undefined || asked.sample !== undefined,
          error: said.switchError,
        }}
      />
    </OutlineTextsContext.Provider>
  );
}
