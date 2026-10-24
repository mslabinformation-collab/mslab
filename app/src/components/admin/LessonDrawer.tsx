"use client";

import { useRouter } from "next/navigation";
import { startTransition, useActionState, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { LESSON_LIMITS, lessonTextProblems } from "@/domain/lesson-limits";
import { adminEt } from "@/i18n/dict/admin";
import type { I18n } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { COURSE_COPY_OWNER, courseCopyKey } from "@/lib/course-copies";
import { deleteLesson, setLessonHidden, setLessonKind } from "@/server/actions/admin-lessons";
import type { AdminLesson } from "@/server/admin-lessons";
import type { EditResult } from "@/server/edit-check";
import { patchSender, type Fields, type SendPatch } from "./autosave/engine";
import { useAutosave } from "./autosave/useAutosave";
import { Choice } from "./Choice";
import { ConfirmPanel } from "./ConfirmPanel";
import { focusFell } from "./focus-fell";
import { I18nInput } from "./I18nInput";
import { LessonFiles } from "./LessonFiles";
import { LessonVideoField } from "./LessonVideoField";
import { lessonError } from "./LessonsEditor";
import { SaveStatus } from "./SaveStatus";
import { Switch } from "./Switch";
import { useUndo } from "./UndoBar";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import forms from "./RegistrationForms.module.css";
import cd from "./ClientDrawer.module.css";
import styles from "./LessonsEditor.module.css";

// One lesson in the admin drawer (?oppetund=<id> on the course editor's address; admin UX pass piece 3a, Task 10; README B2 lesson drawer, the Part 3
// frame „LESSON DRAWER“ and the Part 4 „B2 Lesson drawer“), top to bottom:
// - the header: „Moodul {nn} · Õppetund {n.n}“ (its place as the card numbers it), the name (as its field has it now) and SaveStatus, left of the
//   drawer's ✕ (Drawer.tsx: it asks only through the leave guard);
// - „Õppetunni nimi“ and „Lühike tekst“, autosaved (useAutosave on POST /api/admin/oppetund/<id> from the lesson's „t:“ version, R-b2): a published
//   course's live lesson waits in its outline draft, a new one and an unpublished course's are written on the row (server/admin-lessons.ts
//   writeOutlineText); a stored text has the page read again, for the row behind the drawer and the PublishBar's labels. No „Salvesta“;
// - „Õppetunni liik“, instant; Video → Tekst with a video asks in a ConfirmPanel first;
// - the video (a video lesson: LessonVideoField.tsx) and „Failid“ (LessonFiles.tsx: a drop zone, „Eemalda“ with the UndoBar);
// - the switch „Õpilastele nähtav“ (the shared Switch) with the existing hint for a lesson with progress; off, the UndoBar „Õppetund peidetud.“, whose
//   „Võta tagasi“ shows it again (S3-P3-c); on, no bar;
// - „Kustuta õppetund“, only without progress, after a ConfirmPanel.
// No ET | RU switch of its own (Dim 22.10): the fields follow the page's language. A file dropped anywhere on the drawer but its drop zone (its
// backdrop too) is taken and does nothing (final review P10-2): the browser would open it in the tab, and the admin would be gone.

const t = adminEt.lessons;

type Action = (fd: FormData) => void;
const send = (action: Action, fields: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  startTransition(() => action(fd));
};
const formOf = (fields: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
};

type LessonKind = AdminLesson["kind"];
type TextField = "title" | "body";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameText = (a: I18n, b: I18n) => a.et === b.et && (a.ru ?? "") === (b.ru ?? "");

/**
 * The name and the short text as the server checks them (domain/lesson-limits.ts, the rule of server/edit-check.ts Check.text): a name needed, each
 * language within its limit, trimmed.
 */
const checkText = (f: Fields): Record<string, string> => lessonTextProblems({ title: f.title as I18n, body: f.body as I18n });
const labelOf = (field: string) => (field === "body" ? t.drawer.body : t.drawer.name);
const fieldOf = (field: string) => document.querySelector<HTMLElement>(`[data-i18n="lesson-${field === "body" ? "body" : "title"}"]`);
const focusField = (field: string) => fieldOf(field)?.focus();

/**
 * The name and the short text's autosave (README B2 „Õppetunni nimi, Lühike tekst (autosave)“; R-b2): the shared engine on POST
 * /api/admin/oppetund/<id> from the version the page read. The copy in this browser is `mslab-draft:koolitus:<course>-oppetund<id>:<tab>`, so a
 * „Loobu muudatustest“ drops it with the course's (lib/course-copies.ts). It is a leave-guard source inside the drawer: ✕ waits for its save, or asks.
 */
function useLessonText(courseId: number, lesson: AdminLesson) {
  const router = useRouter();
  const live = useRef(router);
  useLayoutEffect(() => {
    live.current = router;
  });
  /** The server's refusal codes (400) by field, until the field is typed in again or saved. */
  const [refused, setRefused] = useState<Partial<Record<TextField, string>>>({});
  const save = useMemo<SendPatch>(() => {
    const base = patchSender(`/api/admin/oppetund/${lesson.id}`);
    return async (body, opts) => {
      const answer = await base(body, opts);
      const reply = answer && isRecord(answer.body) ? answer.body : null;
      if (answer?.status === 400 && reply?.error === "invalid" && isRecord(reply.fields)) {
        const codes: Partial<Record<TextField, string>> = {};
        for (const f of ["title", "body"] as const) if (typeof reply.fields[f] === "string") codes[f] = reply.fields[f] as string;
        setRefused(codes);
      } else if (answer?.status === 200 && reply?.ok === true) {
        setRefused({});
        // stored (its version moved): the row behind the drawer, its „avaldamata“ and the PublishBar's „Moodul {nn}“ are the page's to say
        if (reply.version !== body.version) startTransition(() => live.current.refresh());
      }
      return answer;
    };
  }, [lesson.id]);
  const auto = useAutosave({
    owner: COURSE_COPY_OWNER,
    key: courseCopyKey(courseId, `oppetund${lesson.id}`),
    version: lesson.version,
    fields: { title: lesson.title, body: lesson.body ?? { et: "" } },
    save,
    validate: checkText,
    label: labelOf,
    focusField,
  });
  const value = { title: auto.fields.title as I18n, body: auto.fields.body as I18n };
  const held = auto.status.kind === "invalid";
  const local = checkText(auto.fields);
  const codeOf = (field: TextField): string | undefined => (held ? (local[field] ?? refused[field]) : undefined);
  const { setField, flush, restore } = auto;
  return {
    status: auto.status,
    value,
    set: (field: TextField, next: I18n) => {
      if (!sameText(next, value[field])) setRefused((r) => (r[field] ? { ...r, [field]: undefined } : r));
      setField(field, next);
    },
    flush: () => void flush(),
    error: (field: TextField) => {
      const code = codeOf(field);
      return code === undefined ? undefined : code === "tooLong" ? t.errors.tooLong : t.errors.required;
    },
    /** SaveStatus's „Näita“: the first field held back. */
    showInvalid: () => focusField(codeOf("title") !== undefined ? "title" : "body"),
    conflict: auto.conflict !== null,
    restore: () => void restore(),
  };
}
type LessonText = ReturnType<typeof useLessonText>;

/** A drag that carries files (a text dragged inside a field carries none, and is left to the browser). */
const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * Files dragged over the drawer's dialog (`inside`'s, else `inside` itself) and dropped beside its drop zone do nothing: the browser's own drop
 * (open the file in the tab) is prevented. The drop zone takes its drop first and uploads it (LessonFiles.tsx); other drags are left as they are.
 */
function useFileDropsKept(inside: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = inside.current;
    const host = el?.closest("dialog") ?? el;
    if (!host) return;
    const keep = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    host.addEventListener("dragover", keep);
    host.addEventListener("drop", keep);
    return () => {
      host.removeEventListener("dragover", keep);
      host.removeEventListener("drop", keep);
    };
  }, [inside]);
}

type Props = {
  courseId: number;
  /** The course is published: a live lesson's text saves to the draft, and the chip says „Mustand salvestatud“ (README §1.4). */
  published: boolean;
  lesson: AdminLesson;
  /** Its place as the card numbers it: the module's place in the course and the lesson's in its module (1…n). */
  place: { module: number; lesson: number };
  /** Bunny is set up: else the video field only says "Video seadistamata". */
  bunnyReady: boolean;
};

export function LessonDrawer({ courseId, published, lesson, place, bunnyReady }: Props) {
  const text = useLessonText(courseId, lesson);
  const root = useRef<HTMLDivElement>(null);
  useFileDropsKept(root);
  // the name as its field has it (a blank field keeps the stored one), in the header and the delete's question
  const name = text.value.title.et.trim() || lesson.title.et.trim();
  return (
    <div ref={root} className={styles.lessonDrawer} data-lesson-drawer={lesson.id}>
      <header className={`${cd.head} ${styles.drawerHead}`} data-lesson-head="">
        <p className={styles.drawerPlace} data-lesson-place="">
          {fill(t.drawer.place, { nn: String(place.module).padStart(2, "0"), m: place.module, n: place.lesson })}
        </p>
        <h2 className={styles.drawerTitle}>{name}</h2>
        <SaveStatus status={text.status} draft={published} thing={t.drawer.thing} onShowInvalid={text.showInvalid} />
      </header>
      <LessonTextFields text={text} />
      <LessonKindField lesson={lesson} />
      {lesson.kind === "video" && (
        <LessonVideoField
          lessonId={lesson.id}
          bunnyReady={bunnyReady}
          video={{ status: lesson.videoStatus, durationSec: lesson.durationSec, replacing: lesson.replacing, progress: lesson.videoProgress }}
        />
      )}
      <LessonFiles lessonId={lesson.id} files={lesson.files} />
      <LessonVisibility lesson={lesson} />
      {!lesson.inUse && <LessonDelete courseId={courseId} lesson={lesson} name={name} />}
    </div>
  );
}

/** „Õppetunni nimi“ and „Lühike tekst“ (ET / RU by the page's language): saved 1.5 s after the last key, or when the fields are left. */
function LessonTextFields({ text }: { text: LessonText }) {
  return (
    <section className={`${cd.section} ${styles.drawerText}`} onBlur={text.flush} data-lesson-text="">
      <I18nInput label={t.drawer.name} name="lesson-title" value={text.value.title} onChange={(v) => text.set("title", v)} maxLength={LESSON_LIMITS.title} error={text.error("title")} />
      <I18nInput
        label={t.drawer.body}
        hint={t.drawer.bodyHint}
        name="lesson-body"
        value={text.value.body}
        onChange={(v) => text.set("body", v)}
        multiline
        rows={6}
        maxLength={LESSON_LIMITS.body}
        error={text.error("body")}
      />
      {text.conflict && (
        <p className={styles.restore}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={text.restore} data-lesson-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
    </section>
  );
}

/**
 * „Õppetunni liik“: Video or Tekst, saved as soon as it is chosen (pills; a segmented control on a phone, the Part 4 frame). Tekst on a lesson that
 * has a video (or one on its way) asks first, in a ConfirmPanel under the choice (README B2): „Katkesta“ puts the choice back on Video with the focus,
 * „Jah, vaheta“ saves it (the panel busy meanwhile) and the focus goes to Tekst; a refusal says why (the panel stays when it asked).
 */
function LessonKindField({ lesson }: { lesson: AdminLesson }) {
  const uid = useId();
  const [choice, setChoice] = useState<LessonKind>(lesson.kind);
  const [stored, setStored] = useState<LessonKind>(lesson.kind);
  const [asking, setAsking] = useState(false);
  /** The radio that gets the focus after the panel goes (README §1.6: the trigger comes back with it); a new object each time. */
  const [focusTo, setFocusTo] = useState<{ kind: LessonKind } | null>(null);
  if (stored !== lesson.kind) {
    setStored(lesson.kind);
    setChoice(lesson.kind);
    setAsking(false);
  }
  const [state, action, pending] = useActionState<EditResult | null, FormData>(setLessonKind, null);
  // an answer: a refusal puts the choice back on the stored kind (unless the panel still asks about Tekst); a yes closes the panel
  const [answer, setAnswer] = useState(state);
  if (answer !== state) {
    setAnswer(state);
    if (state && !state.ok && !asking) setChoice(lesson.kind);
    if (state?.ok && asking) {
      setAsking(false);
      setFocusTo({ kind: "text" });
    }
  }
  const hasVideo = lesson.videoStatus !== "none" || lesson.replacing;
  const error = lessonError(state);

  useEffect(() => {
    if (focusTo) document.getElementById(`${uid}-${focusTo.kind}`)?.focus();
  }, [focusTo, uid]);

  const choose = (kind: LessonKind) => {
    if (pending) return;
    setChoice(kind);
    // back on the stored kind (Video while the panel asks): nothing to save
    if (kind === lesson.kind) return setAsking(false);
    if (kind === "text" && hasVideo) return setAsking(true);
    setAsking(false);
    send(action, { id: lesson.id, kind });
  };

  return (
    <section className={cd.section} data-lesson-kind="">
      <fieldset className={`${ed.fieldset} ${styles.kind}`} aria-describedby={error ? `${uid}-error` : undefined} aria-busy={pending || undefined}>
        <legend className={styles.drawerLabel}>{t.drawer.kind.label}</legend>
        <div className={styles.kindPills}>
          {(["video", "text"] as const).map((k) => (
            <Choice
              key={k}
              id={`${uid}-${k}`}
              className={styles.kindPill}
              label={t.drawer.kind[k]}
              type="radio"
              name={`${uid}-kind`}
              value={k}
              checked={choice === k}
              onChange={() => choose(k)}
            />
          ))}
        </div>
      </fieldset>
      {asking && (
        <ConfirmPanel
          question={t.drawer.kind.confirm}
          lines={[t.drawer.kind.confirmLine]}
          yesLabel={t.drawer.kind.yes}
          tone="danger"
          busy={pending}
          onYes={() => send(action, { id: lesson.id, kind: "text" })}
          onCancel={() => {
            setAsking(false);
            setChoice("video");
            setFocusTo({ kind: "video" });
          }}
        />
      )}
      {error && (
        <p id={`${uid}-error`} role="alert" className={ui.error} data-kind-error="">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * „Õpilastele nähtav“ (README B2; the Part 3 frame: a two-state switch where „Peida“ / „Näita õpilastele“ were): saved at once. Off, the UndoBar „Õppetund
 * peidetud.“ (S3-P3-c), whose „Võta tagasi“ shows it again; on, no bar (it is its own reverse), and a bar of the hide still up goes. The bar's undo is
 * the server's: it stays when the drawer closes and works then too. The switch shows what was asked until the page's read has it; a refusal says why
 * under it. Under it the existing hint for a lesson with progress (ADM:1723: it can only be hidden), and while it is hidden what that means.
 */
function LessonVisibility({ lesson }: { lesson: AdminLesson }) {
  const uid = useId();
  const undo = useUndo();
  /** The hidden state asked, until the page's read shows it. */
  const [asked, setAsked] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Takes away the bar of the last hide (UndoBar's show answers it). */
  const withdraw = useRef<(() => void) | null>(null);
  if (asked !== null && !pending && lesson.hidden === asked) setAsked(null);
  const hidden = asked ?? lesson.hidden;

  const refocus = useCallback(() => {
    if (focusFell()) document.querySelector<HTMLElement>(`[data-lesson-visible="${lesson.id}"]`)?.focus();
  }, [lesson.id]);

  const change = (on: boolean) => {
    if (pending) return;
    const hide = !on;
    setError(null);
    setAsked(hide);
    setPending(true);
    void (async () => {
      let result: EditResult;
      try {
        result = await setLessonHidden(null, formOf({ id: lesson.id, hidden: hide ? "1" : "0" }));
      } catch {
        result = { ok: false, error: "server" };
      }
      setPending(false);
      if (!result.ok) {
        setAsked(null);
        setError(lessonError(result));
        return;
      }
      if (!hide) {
        withdraw.current?.();
        withdraw.current = null;
        return;
      }
      withdraw.current = undo.show({
        text: t.drawer.hidden,
        undo: async () => {
          try {
            const shown = await setLessonHidden(null, formOf({ id: lesson.id, hidden: "0" }));
            if (shown.ok) refocus();
            return shown.ok;
          } catch {
            return false;
          }
        },
      });
    })();
  };

  const described = [lesson.inUse && `${uid}-inuse`, hidden && `${uid}-hidden`, error && `${uid}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <section className={`${cd.section} ${styles.visibility}`} data-lesson-visibility="">
      <Switch label={t.drawer.visible} checked={!hidden} onChange={change} describedBy={described} data-lesson-visible={String(lesson.id)} />
      {lesson.inUse && (
        <p id={`${uid}-inuse`} className={ui.hint}>
          {t.drawer.inUse}
        </p>
      )}
      {hidden && (
        <p id={`${uid}-hidden`} className={ui.hint}>
          {t.drawer.hiddenNote}
        </p>
      )}
      {error && (
        <p id={`${uid}-error`} role="alert" className={ui.error}>
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * „Kustuta õppetund“ (README B2: only without progress; the drawer does not offer it to a lesson with progress): a ConfirmPanel in its place, today's
 * question „Kas kustutan õppetunni „{nimi}“ koos video ja failidega?“ with „Jah, kustuta“ / „Katkesta“, busy while the delete runs. „Katkesta“ gives
 * the button back with the focus; deleted, the page goes back to the course and the drawer closes; a refusal (progress came meanwhile) keeps the panel
 * and says why.
 */
function LessonDelete({ courseId, lesson, name }: { courseId: number; lesson: AdminLesson; name: string }) {
  const [asking, setAsking] = useState(false);
  const [state, action, pending] = useActionState<EditResult | null, FormData>(deleteLesson, null);
  const opener = useRef<HTMLButtonElement>(null);
  /** „Katkesta“ was pressed: the button comes back with the focus (README §1.6). */
  const refocus = useRef(false);
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    opener.current?.focus();
  }, [asking]);
  const error = lessonError(state, t.drawer.inUse);

  return (
    <section className={`${cd.section} ${styles.deleteRow}`} data-delete-lesson="">
      {asking ? (
        <>
          <ConfirmPanel
            question={fill(t.drawer.deleteConfirm, { title: name })}
            yesLabel={t.deleteYes}
            tone="danger"
            busy={pending}
            onYes={() => send(action, { id: lesson.id, courseId })}
            onCancel={() => {
              refocus.current = true;
              setAsking(false);
            }}
          />
          {error && (
            <p role="alert" className={ui.error}>
              {error}
            </p>
          )}
        </>
      ) : (
        <div className={forms.actions}>
          <button ref={opener} type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} onClick={() => setAsking(true)} data-delete-lesson-open="">
            {t.drawer.delete}
          </button>
        </div>
      )}
    </section>
  );
}
