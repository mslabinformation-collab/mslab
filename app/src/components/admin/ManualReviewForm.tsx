"use client";

import { useRouter } from "next/navigation";
import { startTransition, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import {
  checkManualReview, MANUAL_REVIEW_FIELDS, REVIEW_NAME_MAX, REVIEW_NOTE_MAX, REVIEW_TEXT_MAX, type ManualReviewFields,
} from "@/domain/review";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { toStorable } from "@/lib/to-storable";
import { saveManualReviewAction } from "@/server/actions/admin-reviews";
import { patchSender, type Fields, type SendPatch } from "./autosave/engine";
import { useAutosave } from "./autosave/useAutosave";
import { useDrawerClose } from "./Drawer";
import { SaveStatus } from "./SaveStatus";
import type { ReviewCourseOption } from "./review-view";
import { focusFormField, useNewRecord } from "./useNewRecord";
import ed from "./editor.module.css";
import ui from "./ui.module.css";
import chip from "./SaveStatus.module.css";
import styles from "./ReviewsPanel.module.css";

// The two drawers of a review Maria received elsewhere (student reviews, Task 4; spec D4; admin UX pass piece 4c, Task 2: README C6, S4-39, rulings
// R-c): the course, the name to show, the words, the day they were written, their language and her internal note „Kust see pärit on?“ (required,
// never shown publicly), under „Lisa ainult päris õpilase sõnad tema loal.“. The rules are domain/review.ts checkManualReview's (the server checks
// them again).
// - NewReviewForm, „Lisa arvustus +“ (?id=uus): an explicit create (screens notes 11: a new review is published at once, so it is never autosaved).
//   Its header says „Täida kohustuslikud väljad“ and then „Vajuta „Lisa arvustus“.“; „Lisa arvustus“ creates it and the drawer closes with no result
//   line, the focus back on „Lisa arvustus +“ (the drawer's returnFocus). „Katkesta“ closes it and throws the typed text away. Leaving it any other way
//   with typed text asks (the leave guard) with „Arvustust pole veel lisatud.“, and „Sulge, tekst jääb seadmesse“ keeps the text in this browser
//   (NEW_REVIEW_COPY) for the next opening.
// - EditReviewForm, „Muuda“ (?id=<review>): the same fields, autosaved (useAutosave on POST /api/admin/arvustus/<id>, server/reviews.ts writeManualReview;
//   R-c's version), SaveStatus in the drawer's header (its gone word S4-4: „Seda arvustust enam ei ole. …“), a conflict with „Taasta minu tekst“.
//   Only a review Maria added has one: a student's words are never edited.
// Text pasted from Word can carry a vertical tab or a form feed, which the rules refuse as invalid: as it is typed every control character becomes a
// space, and a line or page break a line break (a name's a space: it has one line). This file runs on old iPads: no regular expression with a
// lookbehind, here or in anything it imports (tests/unit/old-safari.test.ts).

const t = adminEt.reviews.form;
type Field = (typeof MANUAL_REVIEW_FIELDS)[number];

/** This browser's copy of a new review typed and not added yet (one per browser; dropped once it is added, or by „Katkesta“). */
export const NEW_REVIEW_COPY = "mslab-draft:arvustus:uus";
/** The engines' copies of „Muuda“ in this browser: `mslab-draft:arvustus:<id>:<tab>`. */
const OWNER = "arvustus";

/** The visible names of the fields (the leave guard's notice and SaveStatus's „Näita“ name them). */
const LABELS: Record<Field, string> = { courseId: t.course, name: t.name, text: t.text, writtenAt: t.writtenAt, locale: t.locale, note: t.note };
const labelOf = (field: string): string => LABELS[field as Field] ?? field;

/**
 * The text as it is kept: a carriage return (alone or before a line feed) is a line break; every other control character but the line feed is a space,
 * except Word's line break (vertical tab) and page break (form feed), which are line breaks (lib/to-storable.ts, which also drops a broken surrogate).
 * A name has one line: its breaks are spaces too. Blank space at either end is left to checkManualReview, which trims.
 */
function cleanTyped(field: Field, raw: string): string {
  if (field !== "name" && field !== "text" && field !== "note") return raw;
  const text = toStorable(raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u0009\u000e-\u001f\u007f]/g, " "));
  return field === "name" ? text.replace(/\n/g, " ") : text;
}

/** The fields' problems by the rules (checkManualReview's codes by field: required, tooLong, invalid); none when the review would be stored. */
function problemsOf(f: ManualReviewFields): Partial<Record<Field, string>> {
  const checked = checkManualReview(f);
  if (checked.ok) return {};
  return Object.fromEntries(Object.entries(checked.fields).filter(([k]) => (MANUAL_REVIEW_FIELDS as readonly string[]).includes(k))) as Partial<Record<Field, string>>;
}

const errorText = (code: string): string => (t.errors as Record<string, string>)[code] ?? t.errors.invalid;

/** The drawer's field `name` (the first in the open drawer, else any): „Jää siia“, „Näita“ and a refused create. */
const focusField = (name: string): void => focusFormField("[data-review-form]", name);

// ---------- the fields (both drawers) ----------

type FieldsView = {
  values: ManualReviewFields;
  /** A field typed into (already cleaned). */
  set: (f: Field, value: string) => void;
  /** A select or the day chosen: an instant field (README §1.3), which „Muuda“ saves at once. */
  onChoose: () => void;
  /** A field left (any field: the form's focusout). */
  onLeave: () => void;
  error: (f: Field) => string | undefined;
  courses: ReviewCourseOption[];
  /** Nothing can be typed (a create on its way: what it sends is what the form shows). */
  busy?: boolean;
};

/**
 * The fields in the form's order — „Koolitus“, „Nimi, mida näidatakse“, „Arvustuse tekst“, „Kirjutamise kuupäev“, „Arvustuse keel“, „Kust see pärit
 * on?“ — the name, the text and the note each with its counter „{n} / {max}“, the note with its hint; each field's error under it, named by
 * aria-describedby. Two to a row in the drawer, one per row on a phone (editor.module.css grid).
 */
function ReviewFieldList({ view }: { view: FieldsView }) {
  const uid = useId();
  const id = (f: Field) => `${uid}-${f}`;
  const v = view.values;
  const describedBy = (f: Field, extra?: string) => [extra, view.error(f) ? `${id(f)}-error` : ""].filter(Boolean).join(" ") || undefined;
  const invalid = (f: Field) => (view.error(f) ? true : undefined);
  const set = (f: Field) => (e: { target: { value: string } }) => view.set(f, cleanTyped(f, e.target.value));
  const choose = (f: Field) => (e: { target: { value: string } }) => {
    view.set(f, e.target.value);
    view.onChoose();
  };
  const counter = (f: "name" | "text" | "note", max: number) => (
    <p id={`${id(f)}-count`} className={`${ui.hint} ${styles.count}`} data-review-count={f}>
      {fill(t.count, { n: v[f].length, max })}
    </p>
  );
  const error = (f: Field) => {
    const words = view.error(f);
    return (
      words && (
        <p id={`${id(f)}-error`} className={ui.error} data-field-error="">
          {words}
        </p>
      )
    );
  };
  return (
    <div className={`${ed.grid} ${styles.fields}`} onBlur={view.onLeave} aria-busy={view.busy || undefined}>
      <div className={ui.field}>
        <label htmlFor={id("courseId")}>{t.course}</label>
        <select
          id={id("courseId")}
          name="courseId"
          className={`${ui.input} ${ed.select}`}
          value={v.courseId}
          aria-disabled={view.busy || undefined}
          onChange={choose("courseId")}
          aria-invalid={invalid("courseId")}
          aria-describedby={describedBy("courseId")}
          data-review-field="courseId"
        >
          {v.courseId === "" && <option value="">{t.chooseCourse}</option>}
          {view.courses.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.label}
            </option>
          ))}
        </select>
        {error("courseId")}
      </div>

      <div className={ui.field}>
        <label htmlFor={id("name")}>{t.name}</label>
        <input
          id={id("name")}
          name="name"
          className={ui.input}
          type="text"
          autoComplete="off"
          maxLength={REVIEW_NAME_MAX}
          value={v.name}
          readOnly={view.busy || undefined}
          onChange={set("name")}
          aria-invalid={invalid("name")}
          aria-describedby={describedBy("name", `${id("name")}-count`)}
          data-review-field="name"
        />
        {counter("name", REVIEW_NAME_MAX)}
        {error("name")}
      </div>

      <div className={`${ui.field} ${ed.wide}`}>
        <label htmlFor={id("text")}>{t.text}</label>
        <textarea
          id={id("text")}
          name="text"
          className={ui.textarea}
          rows={5}
          maxLength={REVIEW_TEXT_MAX}
          value={v.text}
          readOnly={view.busy || undefined}
          onChange={set("text")}
          aria-invalid={invalid("text")}
          aria-describedby={describedBy("text", `${id("text")}-count`)}
          data-review-field="text"
        />
        {counter("text", REVIEW_TEXT_MAX)}
        {error("text")}
      </div>

      <div className={ui.field}>
        <label htmlFor={id("writtenAt")}>{t.writtenAt}</label>
        <input
          id={id("writtenAt")}
          name="writtenAt"
          className={`${ui.input} ${ed.dateTime}`}
          type="date"
          value={v.writtenAt}
          readOnly={view.busy || undefined}
          onChange={choose("writtenAt")}
          aria-invalid={invalid("writtenAt")}
          aria-describedby={describedBy("writtenAt")}
          data-review-field="writtenAt"
        />
        {error("writtenAt")}
      </div>

      <div className={ui.field}>
        <label htmlFor={id("locale")}>{t.locale}</label>
        <select
          id={id("locale")}
          name="locale"
          className={`${ui.input} ${ed.select}`}
          value={v.locale}
          aria-disabled={view.busy || undefined}
          onChange={choose("locale")}
          aria-invalid={invalid("locale")}
          aria-describedby={describedBy("locale")}
          data-review-field="locale"
        >
          <option value="et">{t.localeOptions.et}</option>
          <option value="ru">{t.localeOptions.ru}</option>
        </select>
        {error("locale")}
      </div>

      <div className={`${ui.field} ${ed.wide}`}>
        <label htmlFor={id("note")}>{t.note}</label>
        <textarea
          id={id("note")}
          name="note"
          className={ui.textarea}
          rows={2}
          maxLength={REVIEW_NOTE_MAX}
          value={v.note}
          readOnly={view.busy || undefined}
          onChange={set("note")}
          aria-invalid={invalid("note")}
          aria-describedby={describedBy("note", `${id("note")}-hint ${id("note")}-count`)}
          data-review-field="note"
        />
        <p id={`${id("note")}-hint`} className={ui.hint}>
          {t.noteHint}
        </p>
        {counter("note", REVIEW_NOTE_MAX)}
        {error("note")}
      </div>
    </div>
  );
}

// ---------- „Lisa arvustus +“: a new review, created by its one button ----------

/** The fields of a new review: no course chosen (an explicit choice, so that a review is never filed under the first course by mistake), today's day, Estonian. */
export const emptyReview = (today: string): ManualReviewFields => ({ courseId: "", name: "", text: "", writtenAt: today, locale: "et", note: "" });

/** A kept copy's fields: each a text over a new review's; the course only while it is one of `courses`, the language only et or ru. */
function readCopy(raw: Record<string, unknown>, empty: ManualReviewFields, courses: ReviewCourseOption[]): ManualReviewFields {
  const out: ManualReviewFields = { ...empty };
  for (const f of MANUAL_REVIEW_FIELDS) {
    const v = raw[f];
    if (typeof v !== "string") continue;
    if (f === "courseId") out.courseId = courses.some((c) => String(c.id) === v) ? v : "";
    else if (f === "locale") out.locale = v === "ru" ? "ru" : "et";
    else out[f] = v;
  }
  return out;
}

type CreateResult = Awaited<ReturnType<typeof saveManualReviewAction>>;

export function NewReviewForm({ courses, today }: { courses: ReviewCourseOption[]; today: string }) {
  const uid = useId();
  const close = useDrawerClose();
  const empty = useMemo(() => emptyReview(today), [today]);
  // the fields, their refusals, this browser's copy (NEW_REVIEW_COPY) and the leave guard's „Arvustust pole veel lisatud.“ (S4-39): useNewRecord, as
  // Kalender's new session has them
  const record = useNewRecord({
    copyKey: NEW_REVIEW_COPY,
    empty,
    read: (raw) => readCopy(raw, empty, courses),
    order: MANUAL_REVIEW_FIELDS,
    thing: t.newThing,
    label: labelOf,
    focus: focusField,
  });
  const { fields: values, refused } = record;
  /** A refusal of the whole, in words. */
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const refuse = (codes: Record<string, string>, words: string | null) => {
    record.refuse(codes);
    setFailed(words);
  };

  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // (added: the drawer is closing; a second press would add another)
    if (pending || record.finished()) return;
    const checked = checkManualReview(values);
    if (!checked.ok) return refuse(checked.fields, null);
    record.clearRefused();
    setFailed(null);
    start(async () => {
      let r: CreateResult;
      try {
        r = await saveManualReviewAction({ id: null, ...checked.value });
      } catch {
        // (a lost connection rejects the call: words, not an error page)
        r = { ok: false, error: "server", text: adminEt.reviews.errors.server };
      }
      if (r.ok) {
        // R-c: the drawer closes with no result line; the new review is on the page the action refreshed, and the focus is back on „Lisa arvustus +“
        record.finish();
        close?.();
        return;
      }
      if ("fields" in r) refuse(r.fields, t.errors.invalid);
      else setFailed(r.text);
    });
  };
  /** „Katkesta“: the drawer closes and the typed text goes with it (nothing to ask: she said so). */
  const cancel = () => {
    if (pending) return;
    record.finish();
    close?.();
  };

  const view: FieldsView = {
    values,
    set: (f, value) => {
      if (pending) return; // (the create is on its way: the fields are read-only, and a select's choice is not taken either)
      record.setField(f, value);
    },
    onChoose: () => {},
    onLeave: () => {},
    error: (f) => {
      const code = refused[f];
      return code === undefined ? undefined : errorText(code);
    },
    courses,
    busy: pending,
  };
  const ready = checkManualReview(values).ok;
  const line = pending ? adminEt.reviews.working : (failed ?? "");

  return (
    <form className={styles.drawerForm} onSubmit={create} noValidate aria-labelledby={`${uid}-title`} data-review-form="new">
      <header className={styles.drawerHead}>
        <div className={styles.chipRow}>
          {/* a new record's line in the chip's place, as the chip (SaveStatus's neutral one) of every other drawer (admin polish F22) */}
          <span className={`${chip.chip} ${chip.neutral}`} role="status" data-new-review-line="">
            <span className={chip.text}>{ready ? fill(adminEt.courseEditor.newReady, { button: t.create }) : adminEt.courseEditor.newRequired}</span>
          </span>
        </div>
        <h2 id={`${uid}-title`} className={styles.drawerTitle}>
          {t.newTitle}
        </h2>
      </header>
      <p className={`${ui.notice} ${styles.notice}`} data-review-warning="">
        {t.warning}
      </p>
      <ReviewFieldList view={view} />
      <div className={styles.formActions}>
        <button type="submit" className={ui.btn} aria-disabled={pending || undefined} data-review-create="">
          {t.create}
        </button>
        <button type="button" className={`${ui.btn} ${ui.secondary}`} onClick={cancel} data-review-cancel="">
          {adminEt.common.cancel}
        </button>
      </div>
      <p role="status" className={`${styles.status} ${failed && !pending ? ui.error : ui.hint}`} data-review-form-status="">
        {line}
      </p>
    </form>
  );
}

// ---------- „Muuda“: a review Maria added, autosaved ----------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function EditReviewForm({ id, version, fields, courses }: { id: number; version: string; fields: ManualReviewFields; courses: ReviewCourseOption[] }) {
  const uid = useId();
  const router = useRouter();
  const nav = useRef(router);
  useLayoutEffect(() => {
    nav.current = router;
  });
  /** The route's refusal codes (400) by field, until the field is typed in again or saved. */
  const [refused, setRefused] = useState<Partial<Record<Field, string>>>({});

  const save = useMemo<SendPatch>(() => {
    const base = patchSender(`/api/admin/arvustus/${id}`);
    return async (body, opts) => {
      const answer = await base(body, opts);
      const reply = answer && isRecord(answer.body) ? answer.body : null;
      if (answer?.status === 200 && reply?.ok === true) {
        setRefused({});
        // stored (its version moved): the card behind the drawer is the page's to show
        if (reply.version !== body.version) startTransition(() => nav.current.refresh());
      } else if (answer?.status === 400 && reply?.error === "invalid" && isRecord(reply.fields)) {
        const codes: Partial<Record<Field, string>> = {};
        for (const f of MANUAL_REVIEW_FIELDS) if (typeof reply.fields[f] === "string") codes[f] = reply.fields[f] as string;
        setRefused(codes);
      }
      return answer;
    };
  }, [id]);
  const validate = useCallback((f: Fields): Record<string, string> => problemsOf(f as ManualReviewFields) as Record<string, string>, []);
  const auto = useAutosave({ owner: OWNER, key: String(id), version, fields: { ...fields }, save, validate, label: labelOf, focusField });
  const { setField, flush, restore } = auto;
  const values = auto.fields as ManualReviewFields;

  const held = auto.status.kind === "invalid";
  const local = problemsOf(values);
  const codeOf = (f: Field): string | undefined => (held ? (local[f] ?? refused[f]) : undefined);
  const view: FieldsView = {
    values,
    set: (f, value) => {
      setRefused((r) => (r[f] === undefined ? r : { ...r, [f]: undefined }));
      setField(f, value);
    },
    onChoose: () => void flush(),
    onLeave: () => void flush(),
    error: (f) => {
      const code = codeOf(f);
      return code === undefined ? undefined : errorText(code);
    },
    courses,
  };
  const showInvalid = () => focusField(MANUAL_REVIEW_FIELDS.find((f) => codeOf(f) !== undefined) ?? "courseId");

  return (
    <div className={styles.drawerForm} aria-labelledby={`${uid}-title`} role="group" data-review-form={id}>
      <header className={styles.drawerHead} data-review-head="">
        <div className={styles.chipRow}>
          <SaveStatus status={auto.status} thing={t.thing} onShowInvalid={showInvalid} />
        </div>
        <h2 id={`${uid}-title`} className={styles.drawerTitle}>
          {t.editTitle}
        </h2>
      </header>
      <p className={`${ui.notice} ${styles.notice}`} data-review-warning="">
        {t.warning}
      </p>
      <ReviewFieldList view={view} />
      {auto.conflict && (
        <p className={styles.restore}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => void restore()} data-review-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
    </div>
  );
}
