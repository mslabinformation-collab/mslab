"use client";

import { useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SAVE_TIMEOUT_MS } from "@/components/admin/autosave/constants";
import { adminEt } from "@/i18n/dict/admin";
import { contentVersion } from "@/lib/version";

// What an editor of several autosaving parts with a PublishBar needs around „Avalda muudatused“ and „Loobu muudatustest“ (admin UX pass): moved out
// of the course editor (piece 3a, course/SavedCourse.tsx, where the reasons and the reviews behind each rule are told) unchanged, so that the site
// editors' shell (piece 4a, site/SiteEditorPage.tsx) works the same way.
//
// - The engines start from the versions the page read and keep their own afterwards. After anything that moves versions the engines do not hold (a
//   publish, a discard) the page is read again (router.refresh) and the editor starts once more from it (a new `generation`: the screen keys its form
//   by it), the focus back on the control it was on if nothing else has it.
// - Which read starts the cards over: every read carries its stamp (server/read-stamp.ts), a press answers with the stamp taken after its commit, and
//   the cards start over only from a read at or past it (`reload(…, from)`); an older read starts nothing. Without a stamp the next read does.
// - The cards wait (the screen makes them inert, nothing typed taken) from the press through its request until that read. Every wait has one bound,
//   SAVE_TIMEOUT_MS from when it began: the request is given up then (`hold()`'s signal is aborted), the cards take typing again and the page is read
//   again, its outcome unknown — never a failure line. A discard's cards start over at the bound from the live values the discard left.
// - A change that lands while the cards wait (a picture's upload that ends) is not lost: it goes through `route`, which hands it to the form on screen
//   when it takes typing, or keeps it until then (useFormOnScreen).
// Old iPads run it: no regex lookbehind, no crypto.randomUUID (tests/unit/old-safari.test.ts walks every "use client" file).

/** The bound passed: what a request does after it is not waited for. */
export const LATE = Symbol("late");

/** `p`, or LATE once `signal` is aborted (the wait's bound), whichever comes first. */
export function orLate<T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof LATE> {
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

export type Posted = { ok: true; body: unknown } | { ok: false; signedOut: boolean } | { late: true };

/** POST to one of the editor's routes, given up when `signal` is (the wait's bound): `late`. `signedOut` for withAdmin's 401; not ok for any other refusal or no answer. */
export async function post(url: string, signal: AbortSignal): Promise<Posted> {
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
export const failedLine = (action: "publish" | "discard", signedOut: boolean) =>
  signedOut ? adminEt.leave.reasons.signedOut : action === "publish" ? adminEt.publish.publishFailed : adminEt.publish.discardFailed;

/** A part „Avalda muudatused“ left in its draft: changed meanwhile, or missing what its strict check asks for; `fields`, the labels. */
export type HeldPart = { part: string; reason: "changed" | "missing"; fields: string[] };

/** The PublishBar's blocked list of a publish's answer (S3-P3-b): the missing fields' labels, the labels of the parts changed meanwhile. */
export function blockedOf(parts: readonly HeldPart[] | null): { missing: string[]; changed: string[] } | undefined {
  if (!parts || parts.length === 0) return undefined;
  return { missing: parts.filter((p) => p.reason === "missing").flatMap((p) => p.fields), changed: parts.filter((p) => p.reason === "changed").flatMap((p) => p.fields) };
}

/** A part's start: its version, its value (the draft's, else live's), live's value. */
type Seed = { version: string; value: unknown; live: unknown };

/** What a discard leaves: every part at its live value and live version, "l:<hash>" (the server's hash of the same value: course-parts.ts, site-drafts.ts). */
export async function liveSeeds<S extends Record<string, Seed>>(parts: S): Promise<S> {
  const entries = await Promise.all(Object.entries(parts).map(async ([part, seed]) => [part, { version: `l:${await contentVersion(seed.live)}`, value: seed.live, live: seed.live }] as const));
  return Object.fromEntries(entries) as unknown as S;
}

const isAnswer = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The stamp an answer of a press carries (server/read-stamp.ts), or null without one. */
export const stampOf = (body: unknown): number | null => (isAnswer(body) && typeof body.stamp === "number" && Number.isFinite(body.stamp) ? body.stamp : null);

/**
 * A selector that finds a control of the editor (`root`, its attribute selector) again once it has started over (its ids are made anew): a type radio
 * by its value, a field by its name, else the control's first data attribute when that is the only one of its kind in the editor („Avalda
 * muudatused“, ET | RU). Null: none.
 */
export function focusKey(el: Element | null, root: string): string | null {
  if (!(el instanceof HTMLElement)) return null;
  const editor = el.closest(root);
  if (!editor) return null;
  if (el instanceof HTMLInputElement && el.type === "radio" && el.closest("[data-type-switch]")) return `[data-type-switch] input[value="${el.value}"]`;
  const field = el.getAttribute("data-field") ?? el.getAttribute("data-i18n");
  if (field) return `${root} [data-field="${field}"], ${root} [data-i18n="${field}"]`;
  const hook = Array.from(el.attributes).find((a) => a.name.startsWith("data-"));
  if (!hook) return null;
  const key = `${root} [${hook.name}="${hook.value.replace(/["\\]/g, "")}"]`;
  return editor.ownerDocument.querySelectorAll(key).length === 1 ? key : null;
}

/** A part's change worked out from the field when it lands (a gallery upload's): `route` takes it to the form on screen, or keeps it while the cards wait. */
export type Change<P extends string = string> = { part: P; name: string; fn: (current: unknown) => unknown };
/** The form on screen, as `route` sees it. */
export type OnScreen<P extends string = string> = { frozen: boolean; apply: (change: Change<P>) => void };
/** A wait of the cards: from the press (or the course type's confirmation) until the restart; aborted at its bound. */
type Hold = { abort: AbortController };

/** What the editor shell gives the form for the waits (kept above the restart). */
export type Waits<S, P extends string = string> = {
  /** The cards wait (from now, or as they already do); the wait's signal is aborted at its bound. */
  hold: () => AbortSignal;
  /** The cards wait now (a press is on its way, or its read): the hold as the handlers see it, set in the same turn as the press. */
  waitingNow: () => boolean;
  /** A refusal or a failure: the cards take typing again, nothing is read. */
  release: () => void;
  /**
   * The page is read again and the cards start over from it, waiting meanwhile; `live`: after a discard, the seeds to start over from at the bound;
   * `from`: the press's answer's stamp, which the read must reach (null: the next read).
   */
  reload: (live?: S, from?: number | null) => void;
  /** The stamp of the read on screen. */
  stampSeen: () => number;
  /** The page is read again and the cards start over from it; nothing waits meanwhile (an outcome unknown after the bound). */
  reread: () => void;
  /** A change of a part for the form on screen (now, or once its cards take typing again). */
  route: (change: Change<P>) => void;
  /** The form on screen tells how a change goes in and whether its cards wait (null: it is gone). */
  onScreen: (form: OnScreen<P> | null) => void;
  /** The changes that came while the cards waited, and a tick that tells the form there is one. */
  late: { take: () => Change<P>[]; tick: number };
};

/**
 * The shell's half (above the form, kept when the form starts over): the seeds the form starts from and its `generation`, the wait of the cards with
 * its bound, the read that starts them over, the late changes, and the focus kept for a restart.
 * - `read`: the page's read as the screen got it — a new object is a new read; `stamp` its stamp, `parts` its seeds.
 * - `root`, `title`: the editor's and its H1's selectors (the focus goes back into the editor, else to the H1).
 * - `onRead(stamp)`: told of every new read, while rendering (the course's switches look at its stamp); `onBound()`: told when a wait's bound passed.
 */
export function useEditorRestarts<S extends Record<string, Seed>, P extends string = string>(o: {
  read: object;
  stamp: number;
  parts: S;
  root: string;
  title: string;
  onRead?: (stamp: number) => void;
  onBound?: () => void;
}): { seeds: S; generation: number; waiting: boolean; waits: Waits<S, P>; refocus: () => void } {
  const { root, title } = o;
  const router = useRouter();
  const [seen, setSeen] = useState({ read: o.read, stamp: o.stamp });
  const [seeds, setSeeds] = useState(o.parts);
  const [generation, setGeneration] = useState(0);
  /** The page's new read was asked for: the next one whose stamp is at or past `from` (null: any) starts the cards over. */
  const [awaiting, setAwaiting] = useState<{ from: number | null } | null>(null);
  /** The cards wait (a press through its request and the read). */
  const [hold, setHold] = useState<Hold | null>(null);
  // the hold as the handlers see it now (set with the state, so two handlers of one turn share it), and a discard's seeds for the bound
  const holding = useRef<Hold | null>(null);
  const discarded = useRef<S | null>(null);
  useLayoutEffect(() => {
    holding.current = hold;
  }, [hold]);
  useEffect(() => {
    discarded.current = null;
  }, [generation]);
  // the changes that came while the cards waited (an upload that ended meanwhile), and the form that is on screen
  const late = useRef<Change<P>[]>([]);
  const [lateTick, setLateTick] = useState(0);
  const form = useRef<OnScreen<P> | null>(null);
  const onScreen = useCallback((now: OnScreen<P> | null) => {
    form.current = now;
  }, []);
  const route = useCallback((change: Change<P>) => {
    const now = form.current;
    if (now && !now.frozen) return now.apply(change);
    late.current.push(change);
    setLateTick((n) => n + 1);
  }, []);
  const takeLate = useCallback(() => late.current.splice(0), []);
  // the stamp of the read on screen, for an answer that comes after its read
  const seenStamp = useRef(o.stamp);
  useLayoutEffect(() => {
    seenStamp.current = seen.stamp;
  });
  const stampSeen = useCallback(() => seenStamp.current, []);
  // the screen's word on a wait's bound, as it is now
  const bound = useRef(o.onBound);
  useLayoutEffect(() => {
    bound.current = o.onBound;
  });
  // the control of the editor the focus was last on (kept above the restart): a restart or a release puts it back there — the control she pressed,
  // or the one she moved to while the cards waited, never one she has left (inert cards drop the focus to <body>, which is no control)
  const lastFocus = useRef<string | null>(null);
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      lastFocus.current = focusKey(e.target instanceof Element ? e.target : null, root);
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [root]);
  if (o.read !== seen.read) {
    setSeen({ read: o.read, stamp: o.stamp });
    o.onRead?.(o.stamp);
    // the read a press asked for, or a later one: the cards start over from it (an older read may be from before the press, it starts nothing)
    if (awaiting && (awaiting.from === null || o.stamp >= awaiting.from)) {
      setSeeds(o.parts);
      setGeneration((g) => g + 1);
      setAwaiting(null);
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
  const waitingNow = useCallback(() => holding.current !== null, []);
  const reread = useCallback(
    (from: number | null = null) => {
      setAwaiting({ from });
      startTransition(() => router.refresh());
    },
    [router],
  );
  const reload = useCallback(
    (live?: S, from: number | null = null) => {
      beginHold();
      if (live) discarded.current = live;
      reread(from);
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
      // (seeds that cannot be worked out — no crypto.subtle on an insecure origin, final review P7-3 — are none: the cards take typing and the next
      // read starts them over, as without a discard)
      void (live ? liveSeeds(live).catch(() => null) : Promise.resolve(null)).then((restart) => {
        if (holding.current !== hold) return; // a read came meanwhile
        holding.current = null;
        setHold(null);
        bound.current?.();
        if (restart) {
          setSeeds(restart);
          setGeneration((g) => g + 1);
        }
        reread();
      });
    }, SAVE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [hold, reread]);
  /** The focus back on the control she was last on, when it is there and nothing else has it, else the H1 (its bar's button is gone after a publish). */
  const refocus = useCallback(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const key = lastFocus.current;
    (document.querySelector<HTMLElement>(key ?? title) ?? document.querySelector<HTMLElement>(title))?.focus();
  }, [title]);
  return {
    seeds,
    generation,
    waiting: hold !== null,
    waits: { hold: beginHold, waitingNow, release, reload, stampSeen, reread, route, onScreen, late: { take: takeLate, tick: lateTick } },
    refocus,
  };
}

/**
 * The form's half (the form on screen, made anew at every restart): it tells `route` how a change goes in (`apply`) and whether its cards wait
 * (`frozen`); the changes that came while they waited go in once they take typing again (after the restart, a refusal or the bound); and the focus
 * goes back where it was when they let go without a restart (inert cards dropped it), or after a restart (`generation` > 0).
 */
export function useFormOnScreen<P extends string>(o: {
  frozen: boolean;
  generation: number;
  waits: { onScreen: (form: OnScreen<P> | null) => void; late: { take: () => Change<P>[]; tick: number } };
  refocus: () => void;
  apply: (change: Change<P>) => void;
}): void {
  const { frozen, generation, refocus, apply } = o;
  const { onScreen, late } = o.waits;
  // the form on screen, for `route` (a card's list change, whenever it comes)
  useLayoutEffect(() => {
    onScreen({ frozen, apply });
    return () => onScreen(null);
  });
  // the changes that came while the cards waited go in once they take typing again (after the restart, a refusal or the bound)
  const applyLate = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    applyLate.current = () => {
      for (const change of late.take()) apply(change);
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
  // the editor started over (after a publish, a discard, the bound): the focus back on the control she was last on, or the H1
  useLayoutEffect(() => {
    if (generation > 0) refocus();
  }, [generation, refocus]);
}
