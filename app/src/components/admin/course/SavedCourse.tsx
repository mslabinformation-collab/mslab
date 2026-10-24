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
// publish, a discard, the „Avaldatud“ switch (R-d publishes the drafts first), and on an unpublished course a type change, which empties the other
// type's parts on the server (Task 4) — the page is read again (router.refresh) and the editor starts once more from it (a new `generation`): its
// cards from the new versions and values (after a discard the live text), the focus where it was. What is not the engines' (the published flag, the
// modules and their labels) follows every new read of the page, and so does what the bar and the switches have to say (kept here, above the restart).

const t = adminEt.courseEditor;

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

/** A selector that finds the focused control again once the editor has started over (its ids are made anew): its type radio, its field. */
function focusKey(el: Element | null): string | null {
  if (!(el instanceof HTMLElement)) return null;
  if (el instanceof HTMLInputElement && el.type === "radio" && el.closest("[data-type-switch]")) return `[data-type-switch] input[value="${el.value}"]`;
  const field = el.getAttribute("data-field") ?? el.getAttribute("data-i18n");
  return field ? `[data-course-editor] [data-field="${field}"], [data-course-editor] [data-i18n="${field}"]` : null;
}

type Shared = {
  data: CourseEditorData;
  others: OtherCourse[];
  next: { startsAt: string; city: string } | null;
  created: boolean;
  modules: AdminModule[];
};

/** What the bar and the switches say and show; it stays when the editor starts over (a publish that held some parts lists them after the read). */
type Said = {
  blocked: BlockedPart[] | null;
  barError: string | null;
  switchError: string | null;
  priceRefused: boolean;
  /** The switches' boxes show what was asked until the server's new state arrives (or the switch is refused). */
  asked: { published?: boolean; sample?: boolean };
  /** When „Avalda muudatused“ last went through: the chip's „Salvestatud {HH:MM}“ after it (piece3-texts §4), the cards having started over. */
  publishedAt: Date | null;
};
const QUIET: Said = { blocked: null, barError: null, switchError: null, priceRefused: false, asked: {}, publishedAt: null };

export function SavedCourse(props: Shared) {
  const { data } = props;
  const router = useRouter();
  const [seen, setSeen] = useState(data);
  const [seeds, setSeeds] = useState(data.parts);
  const [generation, setGeneration] = useState(0);
  const [awaiting, setAwaiting] = useState(false);
  const [refocus, setRefocus] = useState<{ generation: number; focus: string } | null>(null);
  const [said, setSaid] = useState<Said>(QUIET);
  if (data !== seen) {
    setSeen(data);
    setSaid((s) => ({ ...s, asked: {} }));
    if (awaiting) {
      setSeeds(data.parts);
      setGeneration((g) => g + 1);
      setAwaiting(false);
    }
  }
  /** Reads the page again and starts the editor over from it; the focus goes back to `focus` (a selector), or to the H1. */
  const reload = useCallback(
    (focus: string | null) => {
      setRefocus({ generation: generation + 1, focus: focus ?? "[data-course-title]" });
      setAwaiting(true);
      startTransition(() => router.refresh());
    },
    [router, generation],
  );
  const restart = refocus && refocus.generation === generation ? refocus.focus : null;
  return <SavedForm key={generation} {...props} seeds={seeds} restart={restart} reload={reload} said={said} setSaid={setSaid} />;
}

function SavedForm({
  data,
  others,
  next,
  created,
  modules,
  seeds,
  restart,
  reload,
  said,
  setSaid,
}: Shared & {
  seeds: EditorParts;
  /** The editor started over: the focus goes back here (a selector). */
  restart: string | null;
  reload: (focus: string | null) => void;
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
  const parts = Object.fromEntries(order.map((part) => [part, hooks[part].api])) as CourseParts;
  const type = parts.basics.fields.type;
  const phone = usePhoneChip();
  const { blocked, asked } = said;

  // the editor started over (after a publish, a discard, a switch, a type change): the focus back where it was, or the H1
  useLayoutEffect(() => {
    if (!restart) return;
    (document.querySelector<HTMLElement>(restart) ?? document.querySelector<HTMLElement>("[data-course-title]"))?.focus();
  }, [restart]);

  // an unpublished course's type saved: the server emptied the other type's parts (new versions, Task 4): the page is read again
  const typeSaved = !published && hooks.basics.status.kind === "saved" && type !== seeds.basics.value.type;
  const reread = useRef(false);
  useEffect(() => {
    if (!typeSaved || reread.current) return;
    reread.current = true;
    reload(focusKey(document.activeElement));
  }, [typeSaved, reload]);

  /** Every card's waiting save, sent now and waited for: a publish, a discard or the switch work on what is saved. */
  const flushAll = () => Promise.all(order.map((part) => hooks[part].flushNow()));

  const publish = async () => {
    setSaid((s) => ({ ...s, barError: null }));
    await flushAll();
    const answer = await post(`/api/admin/koolitus/${id}/avalda`);
    if (!answer.ok) return setSaid((s) => ({ ...s, barError: failedLine(answer.signedOut) }));
    const result = answer.body as PublishResult | null;
    const done = result !== null && result.published.length > 0;
    setSaid((s) => ({ ...s, blocked: result?.blocked.length ? result.blocked : null, publishedAt: done ? new Date() : s.publishedAt }));
    if (done) reload(null);
  };

  const discard = async () => {
    setSaid((s) => ({ ...s, barError: null }));
    await flushAll();
    const answer = await post(`/api/admin/koolitus/${id}/loobu`);
    if (!answer.ok) {
      setSaid((s) => ({ ...s, barError: failedLine(answer.signedOut) }));
      throw new Error("discard failed"); // (the question stays open)
    }
    setSaid((s) => ({ ...s, blocked: null }));
    reload(null);
  };

  const switchPublished = async (on: boolean) => {
    if (asked.published !== undefined || asked.sample !== undefined) return;
    const focus = focusKey(document.activeElement);
    setSaid((s) => ({ ...s, switchError: null, asked: { published: on } }));
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
      return reload(focus);
    }
    const refused = result;
    setSaid((s) => {
      const quiet = { ...s, asked: {} };
      if (refused.error === "blocked") return { ...quiet, blocked: refused.blocked };
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
  const missing = (blocked ?? []).some((b) => b.reason === "missing") || said.priceRefused;
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
            blocked={blockedOf(blocked)}
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
      blocked={(blocked ?? []).map((b) => b.part)}
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
