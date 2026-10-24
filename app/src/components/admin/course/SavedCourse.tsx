"use client";

import { useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type EditorPart, type EditorParts, type PartValues } from "@/domain/course-parts";
import { adminEt } from "@/i18n/dict/admin";
import { setCoursePublished, setCourseSample } from "@/server/actions/admin-content";
import type { AdminModule } from "@/server/admin-lessons";
import type { BlockedPart, PublishResult, SwitchResult } from "@/server/course-parts";
import { PublishBar } from "../PublishBar";
import { SaveStatus } from "../SaveStatus";
import ui from "../ui.module.css";
import styles from "../CourseEditor.module.css";
import { combineStatus, publishLabels } from "./course-view";
import { CourseView } from "./CourseView";
import { usePhoneChip } from "./usePhoneChip";
import { focusPartField, useCoursePart } from "./useCoursePart";
import type { CourseEditorData, CourseParts, OtherCourse } from "./types";

// A saved course's editor (admin UX pass piece 3a, Task 7; README B2, §1.3, §1.8; rulings R-a…R-d). Every card autosaves its part from the version
// the page read (useCoursePart): a published course's into its draft, with the PublishBar under the H1 naming what waits („Avaldamata muudatused:
// {n} · {labels}. Avalikul lehel on näha eelmine versioon.“), „Eelvaade ↗“ (the public page at the course's LIVE address in draft mode: a drafted
// address is live only after the publish), „Loobu muudatustest“ and „Avalda muudatused“; an unpublished course's straight to the record, with no bar.
//
// The engines start from the versions the page read and keep their own afterwards. After anything that moves versions the engines do not hold — a
// publish, a discard, the „Avalikul lehel“ switch (R-d publishes the drafts first), and on an unpublished course a type change, which empties the
// other type's parts on the server (Task 4) — the page is read again (router.refresh) and the editor starts once more from it (a new `generation`):
// its cards from the new versions and values, the focus back on the control it was on if nothing else has it. From the press of „Avalda
// muudatused“, „Jah, loobu“ or „Avalikul lehel“ through its request and until the new read arrives, the cards are inert and aria-busy and take nothing
// typed (review I-2 and round 2: a text typed then would be a copy on a version the server has moved on, a false „Muudeti teises aknas“ after the
// restart); on an unpublished course also from the type's choice until its save is answered. A picture whose upload ends meanwhile is not lost: it
// waits and goes into the gallery card that is there once the cards take typing again. After a discard the parts' copies in this browser go first
// (engine discardCopy, review I-1), so the fields show the live text and nothing is sent again; the discarded cards must start over, so a read that
// does not come is asked for again until it does (round 2 N-1). Any other read that never comes is given up after REREAD_WAIT_MS (review M-4). What
// is not the engines' (the published flag, the modules and their labels) follows every new read of the page, and so does what the bar and the
// switches have to say (kept here, above the restart).

const t = adminEt.courseEditor;

/** How long the editor waits for the page's new read before it gives up on it (the cards take typing again, from the versions they hold). */
export const REREAD_WAIT_MS = 15_000;

/** POST to one of the course's routes; `signedOut` for withAdmin's 401; not ok for any other refusal or no answer. */
async function post(url: string): Promise<{ ok: true; body: unknown } | { ok: false; signedOut: boolean }> {
  try {
    const res = await fetch(url, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, signedOut: res.status === 401 };
    return { ok: true, body: await res.json().catch(() => null) };
  } catch {
    return { ok: false, signedOut: false };
  }
}

/** A publish or a discard that failed (piece 3a, Task 7 ruling: the existing words): signed out, or anything else. */
const failedLine = (signedOut: boolean) => (signedOut ? adminEt.leave.reasons.signedOut : adminEt.common.saveError);

/** The PublishBar's blocked list of a publish's answer (S3-P3-b): the missing fields' labels, the labels of the parts changed meanwhile. */
function blockedOf(parts: readonly BlockedPart[] | null): { missing: string[]; changed: string[] } | undefined {
  if (!parts || parts.length === 0) return undefined;
  return { missing: parts.filter((p) => p.reason === "missing").flatMap((p) => p.fields), changed: parts.filter((p) => p.reason === "changed").flatMap((p) => p.fields) };
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
  /** The switches' boxes show what was asked until the server's new state arrives (or the switch is refused). */
  asked: { published?: boolean; sample?: boolean };
  /** When „Avalda muudatused“ last went through: the chip's „Salvestatud {HH:MM}“ after it (piece3-texts §4), the cards having started over. */
  publishedAt: Date | null;
};
const QUIET: Said = { blocked: null, barError: null, switchError: null, priceRefused: false, asked: {}, publishedAt: null };

/** A change worked out from a field when it lands (a gallery upload's) that came while the cards waited: it goes in once they take typing again. */
type Late = { part: EditorPart; name: string; fn: (current: unknown) => unknown };
/** A part's `update`, whatever the part (the late changes are its own). */
type LooseUpdate = (name: string, fn: (current: unknown) => unknown) => void;

export function SavedCourse(props: Shared) {
  const { data } = props;
  const router = useRouter();
  const [seen, setSeen] = useState(data);
  const [seeds, setSeeds] = useState(data.parts);
  const [generation, setGeneration] = useState(0);
  /** The page's new read was asked for: the cards start over from it. */
  const [awaiting, setAwaiting] = useState(false);
  /** A publish, a discard or the „Avalikul lehel“ switch is on its way: the cards wait. */
  const [posting, setPosting] = useState(false);
  /** After a discard: the cards (their engines muted) must start over from the next read, however long it takes. */
  const [mustRestart, setMustRestart] = useState(false);
  const [asks, setAsks] = useState(0);
  const [said, setSaid] = useState<Said>(QUIET);
  // the late changes (an upload that ended while the cards waited), and a tick that tells the cards there is one
  const late = useRef<Late[]>([]);
  const [lateTick, setLateTick] = useState(0);
  const enqueue = useCallback((change: Late) => {
    late.current.push(change);
    setLateTick((n) => n + 1);
  }, []);
  const takeLate = useCallback(() => late.current.splice(0), []);
  // the control of the editor the focus was last on (kept above the restart): a restart puts it back there — the control she pressed, or the one she
  // moved to while the cards waited, never one she has left (inert cards drop the focus to <body>, which is no control)
  const lastFocus = useRef<string | null>(null);
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      lastFocus.current = focusKey(e.target instanceof Element ? e.target : null);
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);
  // a read that never comes (router.refresh failed): given up, so that a later, unrelated read (a lesson's action) does not restart the cards — but
  // after a discard it is asked for again (the discarded cards cannot take typing until they start over)
  useEffect(() => {
    if (!awaiting) return;
    const timer = setTimeout(() => {
      if (!mustRestart) return setAwaiting(false);
      setAsks((n) => n + 1);
      startTransition(() => router.refresh());
    }, REREAD_WAIT_MS);
    return () => clearTimeout(timer);
  }, [awaiting, mustRestart, asks, router]);
  if (data !== seen) {
    setSeen(data);
    setSaid((s) => ({ ...s, asked: {} }));
    if (awaiting || mustRestart) {
      setSeeds(data.parts);
      setGeneration((g) => g + 1);
      setAwaiting(false);
      setMustRestart(false);
    }
  }
  /** Reads the page again and starts the editor over from it; `restart`: whatever the wait (after a discard). */
  const reload = useCallback(
    (restart = false) => {
      setPosting(false);
      if (restart) setMustRestart(true);
      setAwaiting(true);
      startTransition(() => router.refresh());
    },
    [router],
  );
  /** The started-over editor's focus: the control she was last on, when it is there again, else the H1 (its bar's button is gone after a publish). */
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
      waiting={awaiting || posting || mustRestart}
      hold={setPosting}
      late={{ enqueue, take: takeLate, tick: lateTick }}
      refocus={generation > 0 ? refocus : null}
      reload={reload}
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
  hold,
  late,
  refocus,
  reload,
  said,
  setSaid,
}: Shared & {
  seeds: EditorParts;
  generation: number;
  /** A publish, a discard or the switch, or the page's new read, is on its way: the cards wait for it. */
  waiting: boolean;
  /** The cards wait from the press of a publish, a discard or the switch through its request (until reload or a failure lets go). */
  hold: (on: boolean) => void;
  /** The late changes that came while the cards waited (kept above the restart). */
  late: { enqueue: (change: Late) => void; take: () => Late[]; tick: number };
  /** The editor started over: puts the focus back (only while nothing has it). */
  refocus: (() => void) | null;
  reload: (restart?: boolean) => void;
  said: Said;
  setSaid: (update: (s: Said) => Said) => void;
}) {
  const { id, published, liveType } = data;
  const common = { courseId: id, published, liveType };
  const hooks = {
    basics: useCoursePart({ ...common, part: "basics", seed: seeds.basics }),
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
  // An unpublished course's type chosen (its commit, here): its save empties the other type's parts on the server (new versions). The cards wait
  // from the choice until that save is answered — any answer, so a refusal, an error or no connection lets them go (round 2 N-2) — and once the
  // server has confirmed the new type, the page is read again.
  const [typeAsk, setTypeAsk] = useState<{ type: string; answered: number } | null>(null);
  const typeWaiting = !published && typeAsk !== null && typeAsk.type !== seeds.basics.value.type && (hooks.basics.answeredFor.type ?? 0) === typeAsk.answered;
  const typeConfirmed = !published && typeAsk !== null && typeAsk.type !== seeds.basics.value.type && hooks.basics.confirmed.type === typeAsk.type;
  const frozen = waiting || typeWaiting;
  const parts = Object.fromEntries(
    order.map((part) => {
      const api = hooks[part].api as CourseParts[EditorPart];
      if (frozen) {
        // nothing typed is taken while the cards wait; a picture's upload that ends meanwhile waits for them (round 2 N-3)
        const update = ((name: string, fn: (current: unknown) => unknown) => late.enqueue({ part, name, fn })) as unknown as typeof api.update;
        return [part, { ...api, set: () => {}, commit: () => {}, update }];
      }
      if (part !== "basics" || published) return [part, api];
      const basics = api as CourseParts["basics"];
      const commit: typeof basics.commit = (name, value) => {
        if (name === "type") setTypeAsk({ type: value as string, answered: hooks.basics.answeredFor.type ?? 0 });
        basics.commit(name, value);
      };
      return [part, { ...basics, commit }];
    }),
  ) as CourseParts;

  // the late changes go in once the cards take typing again (after the restart, or a request that failed)
  const applyLate = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    applyLate.current = () => {
      for (const change of late.take()) (hooks[change.part].api.update as unknown as LooseUpdate)(change.name, change.fn);
    };
  });
  useEffect(() => {
    if (!frozen) applyLate.current();
  }, [frozen, late.tick]);
  const phone = usePhoneChip();
  const { asked } = said;
  // the parts the publish held, until each one's next save
  const blocked = (said.blocked?.parts ?? []).filter((b) => {
    const hook = order.includes(b.part as EditorPart) ? hooks[b.part as EditorPart] : null;
    const before = said.blocked?.generation === generation ? (said.blocked.saves[b.part] ?? 0) : 0;
    return !hook || hook.saves <= before;
  });
  const savesNow = () => Object.fromEntries(order.map((part) => [part, hooks[part].saves]));

  // the editor started over (after a publish, a discard, a switch, a type change): the focus back on the control she was last on, or the H1
  useLayoutEffect(() => refocus?.(), [refocus]);

  // an unpublished course's new type confirmed by the server, which emptied the other type's parts (new versions, Task 4): the page is read again
  const reread = useRef<object | null>(null);
  useEffect(() => {
    if (!typeConfirmed || reread.current === typeAsk) return;
    reread.current = typeAsk;
    reload();
  }, [typeConfirmed, typeAsk, reload]);

  /** Every card's waiting save, sent now and waited for: a publish, a discard or the switch work on what is saved. */
  const flushAll = () => Promise.all(order.map((part) => hooks[part].flushNow()));

  const publish = async () => {
    setSaid((s) => ({ ...s, barError: null }));
    hold(true);
    await flushAll();
    const answer = await post(`/api/admin/koolitus/${id}/avalda`);
    if (!answer.ok) {
      hold(false);
      return setSaid((s) => ({ ...s, barError: failedLine(answer.signedOut) }));
    }
    const result = answer.body as PublishResult | null;
    const held = Array.isArray(result?.blocked) && result.blocked.length > 0 ? result.blocked : null;
    const done = Array.isArray(result?.published) && result.published.length > 0;
    setSaid((s) => ({ ...s, blocked: held ? { parts: held, generation, saves: savesNow() } : null, publishedAt: done ? new Date() : s.publishedAt }));
    // something went live, or nothing was there to go (another tab published or threw it away meanwhile, or an answer that cannot be read): the
    // page is read again (review M-2)
    if (done || !held) reload();
    else hold(false);
  };

  const discard = async () => {
    setSaid((s) => ({ ...s, barError: null }));
    hold(true);
    await flushAll();
    const answer = await post(`/api/admin/koolitus/${id}/loobu`);
    if (!answer.ok) {
      hold(false);
      setSaid((s) => ({ ...s, barError: failedLine(answer.signedOut) }));
      throw new Error("discard failed"); // (the question stays open)
    }
    // what was thrown away must not come back: every part's copy in this browser goes before the cards start over (review I-1); muted, they must
    // start over whatever the wait (round 2 N-1)
    for (const part of order) hooks[part].discardCopy();
    setSaid((s) => ({ ...s, blocked: null }));
    reload(true);
  };

  const switchPublished = async (on: boolean) => {
    if (asked.published !== undefined || asked.sample !== undefined) return;
    setSaid((s) => ({ ...s, switchError: null, asked: { published: on } }));
    hold(true);
    // switched off, the drafts are published first (R-d): they get what is typed
    if (!on) await flushAll();
    let result: SwitchResult;
    try {
      result = await setCoursePublished({ id, on });
    } catch {
      result = { ok: false, error: "server" };
    }
    if (result.ok) {
      setSaid((s) => ({ ...s, blocked: null, priceRefused: false }));
      return reload();
    }
    const refused = result;
    hold(false);
    setSaid((s) => {
      const quiet = { ...s, asked: {} };
      if (refused.error === "blocked") return { ...quiet, blocked: { parts: refused.blocked, generation, saves: savesNow() } };
      if (refused.error === "invalid" && Object.values(refused.fields ?? {}).includes("priceRequired")) return { ...quiet, priceRefused: true, switchError: t.errors.priceRequired };
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
    // done: the action has the page read again (its refresh), and the box shows the stored state then
    if (!result.ok) setSaid((s) => ({ ...s, asked: {}, switchError: adminEt.common.saveError }));
  };

  // the price a published course must have: missing at the publish (S3-P3-b), or the switch on refused for it; gone once a price is typed
  const price = parts.price.fields;
  const missing = blocked.some((b) => b.reason === "missing") || said.priceRefused;
  const hasPrice = type === "e_learning" ? price.price.trim() !== "" : price.priceGroup.trim() !== "" || price.priceIndividual.trim() !== "";
  const combined = combineStatus(order.map((part) => hooks[part].status));
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
  };

  return (
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
      blocked={blocked.map((b) => b.part)}
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
  );
}
