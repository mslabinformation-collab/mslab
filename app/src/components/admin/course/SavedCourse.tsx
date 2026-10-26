"use client";

import { useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SAVE_TIMEOUT_MS } from "@/components/admin/autosave/constants";
import type { AutosaveStatus } from "@/domain/autosave";
import { type EditorPart, type EditorParts, type PartValues } from "@/domain/course-parts";
import { adminEt } from "@/i18n/dict/admin";
import { dropCourseCopies } from "@/lib/course-copies";
import { setCoursePublished, setCourseSample } from "@/server/actions/admin-content";
import type { AdminModule } from "@/server/admin-lessons";
import type { BlockedPart, SwitchResult } from "@/server/course-parts";
import { PublishBar } from "../PublishBar";
import { SaveStatus } from "../SaveStatus";
import { blockedOf, LATE, orLate, usePublishPresses, stampOf, useEditorRestarts, useFormOnScreen, type Change as AnyChange, type Waits as EditorWaits } from "../useEditorRestarts";
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
// discard, its status in the chip and „Kontrolli“ on the map; once a name is stored the page is read again for the bar's labels.
//
// Which read starts the cards over (Task 9 review M-1): reads overlap — a read for the labels, a module action's own, one asked before a press can
// land after it. Every read of the page carries its stamp (`data.stamp`, server/read-stamp.ts: the database's clock before the page read anything),
// and „Avalda muudatused“, „Jah, loobu“ and „Avalikul lehel“ answer with the stamp taken after their commit. The cards start over only from a read
// whose stamp is at or past their press's answer: an older read may be from before the press, so it starts nothing, and the read the press asked
// for comes after it. A switch's box shows what was asked until such a read arrives (or one came already). Without a stamp (a type's save, the
// wait's bound: the outcome unknown) the next read starts them over, as before; Task 7's one bound still ends every wait.
//
// The waits, the restart from a read at or past a press's stamp, the late changes and the focus kept for a restart are shared with the site editors
// (piece 4a, Task 2): ../useEditorRestarts.ts holds them as they were written here; what stays here is the course's own (its switches, its type).

const t = adminEt.courseEditor;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The type a basics save's answer says the server holds: a 200's, the one it sent (if it did); a conflict's (409), the stored one. */
function storedType(patch: Record<string, unknown>, answer: SaveAnswer): unknown {
  const reply = answer && isRecord(answer.body) ? answer.body : null;
  if (answer?.status === 200 && reply?.ok === true) return patch.type;
  if (answer?.status === 409 && reply?.error === "conflict" && isRecord(reply.value)) return reply.value.type;
  return undefined;
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
  /** The stamp a read must reach to show the switch's stored state: its answer's (-Infinity: an answer without one, the next read); null: no answer yet. */
  askedFrom: number | null;
  /** When „Avalda muudatused“ last went through: the chip's „Salvestatud {HH:MM}“ after it (piece3-texts §4), the cards having started over. */
  publishedAt: Date | null;
};
const QUIET: Said = { blocked: null, barError: null, switchError: null, priceRefused: false, asked: {}, askedFrom: null, publishedAt: null };

/** A part's change worked out from the field when it lands (a gallery upload's): `route` takes it to the form on screen, or keeps it while the cards wait. */
type Change = AnyChange<EditorPart>;
/** A part's `update`, whatever the part. */
type LooseUpdate = (name: string, fn: (current: unknown) => unknown) => void;

/** What the editor shell gives the form for the waits (kept above the restart): the shared ones, and the course's read for the modules' labels. */
type Waits = EditorWaits<EditorParts, EditorPart> & {
  /** The page is read again for what only the server says (the modules' labels), starting no card over; nothing while a press or a switch is on its way. */
  readLabels: () => void;
};

export function SavedCourse(props: Shared) {
  const { data } = props;
  const router = useRouter();
  const [said, setSaid] = useState<Said>(QUIET);
  // the waits, the read that starts the cards over and the focus kept for it (../useEditorRestarts.ts); a read that shows what a switch's answer
  // said has the boxes show the stored state again, and so does a wait's bound
  const { seeds, generation, waiting, waits, refocus } = useEditorRestarts<EditorParts, EditorPart>({
    read: data,
    stamp: data.stamp,
    parts: data.parts,
    root: "[data-course-editor]",
    title: "[data-course-title]",
    onRead: (stamp) => {
      if (said.askedFrom !== null && stamp >= said.askedFrom) setSaid((s) => ({ ...s, asked: {}, askedFrom: null }));
    },
    onBound: () => setSaid((s) => ({ ...s, asked: {}, askedFrom: null })),
  });
  const { waitingNow } = waits;
  // a switch's answer is awaited (its box shows what was asked until the next read): a read for the labels would show the stored state before it
  const switching = useRef(false);
  useLayoutEffect(() => {
    switching.current = said.asked.published !== undefined || said.asked.sample !== undefined;
  });
  // (no read for the labels while a press or a switch is on its way: its own read follows; a read that lands then starts nothing, see the stamps)
  const readLabels = useCallback(() => {
    if (waitingNow() || switching.current) return;
    startTransition(() => router.refresh());
  }, [router, waitingNow]);
  // a switch that holds no card („Näidissisu“) has the same bound: its box shows the stored state again and the page is read
  const asking = said.asked.published !== undefined || said.asked.sample !== undefined;
  useEffect(() => {
    if (!asking || waiting) return;
    const timer = setTimeout(() => {
      setSaid((s) => ({ ...s, asked: {}, askedFrom: null }));
      startTransition(() => router.refresh());
    }, SAVE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [asking, waiting, router]);
  return (
    <SavedForm
      key={generation}
      {...props}
      seeds={seeds}
      generation={generation}
      waiting={waiting}
      waits={{ ...waits, readLabels }}
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
  const { hold, release, reload, stampSeen, reread, readLabels, route, onScreen, late } = waits;
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
  // the form on screen, for `route` (a card's list change, whenever it comes); the changes that came while the cards waited go in once they take
  // typing again; the focus back where it was when they let go, or after the editor started over (a publish, a discard, a switch, a type change,
  // the bound) — ../useEditorRestarts.ts
  useFormOnScreen<EditorPart>({
    frozen,
    generation,
    waits: { onScreen, late },
    refocus,
    apply: (change: Change) => (hooks[change.part].api.update as unknown as LooseUpdate)(change.name, change.fn),
  });
  const parts = Object.fromEntries(
    order.map((part) => {
      const api = hooks[part].api as CourseParts[EditorPart];
      const update = ((name: string, fn: (current: unknown) => unknown) => route({ part, name, fn })) as unknown as typeof api.update;
      // nothing typed is taken while the cards wait; a list change (a picture's upload that ends) goes in once they take typing again (`route`)
      return [part, frozen ? { ...api, set: () => {}, commit: () => {}, update } : { ...api, update }];
    }),
  ) as CourseParts;

  const phone = usePhoneChip();
  const { asked } = said;
  /** Every card's waiting save (the modules' names too), sent now and waited for: a publish, a discard or the switch work on what is saved. */
  const flushAll = () => Promise.all([...order.map((part) => hooks[part].flushNow()), ...Array.from(textRows.current, (row) => row.flush())]);

  // „Avalda muudatused“ and „Loobu muudatustest“ (../useEditorRestarts.ts usePublishPresses, shared with the site editors) never join a wait of the
  // cards (the switch's, final review P7-1: its answer, or its bound, would end both): while one is on its way the PublishBar is busy (`waiting`), and
  // a press that comes in the same turn does nothing; `blocked`, the parts the publish (or the switch) held, until each one's next save
  const {
    held: blocked,
    savesNow,
    publish,
    discard,
  } = usePublishPresses({
    said,
    setSaid,
    generation,
    waits,
    parts: Object.fromEntries(order.map((part) => [part, hooks[part]])),
    flushAll,
    urls: { publish: `/api/admin/koolitus/${id}/avalda`, discard: `/api/admin/koolitus/${id}/loobu` },
    // what was thrown away must not come back: every part's copy in this browser (review I-1), the modules' names', and every other copy of the
    // course — a closed lesson drawer kept its name and short text („Sulge, tekst jääb seadmesse“, Task 10)
    dropCopies: () => {
      for (const part of order) hooks[part].discardCopy();
      for (const row of textRows.current) row.discardCopy();
      dropCourseCopies(id);
    },
    seeds,
  });

  const switchPublished = async (on: boolean) => {
    if (asked.published !== undefined || asked.sample !== undefined) return;
    setSaid((s) => ({ ...s, switchError: null, asked: { published: on }, askedFrom: null }));
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
      const stamp = stampOf(result);
      setSaid((s) => ({ ...s, blocked: null, priceRefused: false, askedFrom: stamp ?? Number.NEGATIVE_INFINITY }));
      return reload(undefined, stamp);
    }
    release();
    setSaid((s) => {
      const quiet = { ...s, asked: {}, askedFrom: null };
      if (result.error === "blocked") return { ...quiet, blocked: { parts: result.blocked, generation, saves: savesNow() } };
      if (result.error === "invalid" && Object.values(result.fields ?? {}).includes("priceRequired")) return { ...quiet, priceRefused: true, switchError: t.errors.priceRequired };
      return { ...quiet, switchError: adminEt.common.saveError };
    });
  };

  const switchSample = async (on: boolean) => {
    if (asked.published !== undefined || asked.sample !== undefined) return;
    setSaid((s) => ({ ...s, switchError: null, asked: { sample: on }, askedFrom: null }));
    let result: SwitchResult;
    try {
      result = await setCourseSample({ id, on });
    } catch {
      result = { ok: false, error: "server" };
    }
    // done: the action has the page read again (its refresh), and the box shows the stored state from a read at or past the answer's stamp — the
    // action's own read may have come already; refused, unless the bound came first
    if (result.ok) {
      const stamp = stampOf(result);
      const shown = stamp !== null && stampSeen() >= stamp;
      setSaid((s) => (s.asked.sample !== on ? s : shown ? { ...s, asked: {}, askedFrom: null } : { ...s, askedFrom: stamp ?? Number.NEGATIVE_INFINITY }));
    } else setSaid((s) => (s.asked.sample === on ? { ...s, asked: {}, askedFrom: null, switchError: adminEt.common.saveError } : s));
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
              // the cards wait (a publish, a discard or the switch, or its read): the bar's buttons do nothing meanwhile
              waiting={frozen}
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
