"use client";

import Link from "next/link";
import { startTransition, useActionState, useCallback, useEffect, useId, useLayoutEffect, useMemo, useOptimistic, useRef, useState, type ReactNode } from "react";
import { moveLesson, type ModuleLayout } from "@/domain/lessons";
import { adminEt } from "@/i18n/dict/admin";
import type { I18n } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { COURSE_COPY_OWNER, courseCopyKey } from "@/lib/course-copies";
import { addLesson, addModule, deleteModule, moveLessonInList, moveModuleTo } from "@/server/actions/admin-lessons";
import type { AdminLesson, AdminModule } from "@/server/admin-lessons";
import type { EditResult } from "@/server/edit-check";
import { patchSender, type Fields, type SendPatch } from "./autosave/engine";
import { useAutosave } from "./autosave/useAutosave";
import { ConfirmPanel } from "./ConfirmPanel";
import { useOutlineTexts } from "./course/OutlineTexts";
import { DragList } from "./DragList";
import { I18nInput } from "./I18nInput";
import { reorder } from "./reorder";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import forms from "./RegistrationForms.module.css";
import styles from "./LessonsEditor.module.css";

// „Moodulid ja õppetunnid“ (an e-course) or „Programm“ (a contact course: module names only) among the course editor's cards (admin UX pass piece 3a,
// Task 9; README B2 and B18; the Part 3 frame's modules card; piece3-texts P-3, P-4, S3-P3-e, S3-P3-m):
// - the card's title with its summary „{n} moodulit · {m} õppetundi“ (P-4; none yet: „Mooduleid veel pole.“ in its place);
// - each module a box: the handle ⋮⋮, its number, its name edited in the row and autosaved on its own route (api/admin/moodul/<id> from its „t:“
//   version, R-b2: no „Salvesta“), „avaldamata“ while it waits for „Avalda muudatused“ (P-3: new, or changed in the draft), and ↑ / ↓. A drag, ↑ and ↓
//   are one `moveModuleTo` each (DragList, S3-P3-m's names and announcement), shown at once and stored as the server says: on a published course in its
//   outline draft, on an unpublished one in the rows (server/admin-lessons.ts);
// - an e-course module's lessons: the name (read-only here: the drawer edits it), „avaldamata“, „Peidetud“, the video tag („Valmis“, „Töötlemisel
//   {n}%“ or „Töötlemisel“ without a figure, „Video puudub“, „Tekst“; the undrawn „Video üleslaadimisel“ and „Video viga“), ↑ / ↓ (across modules at an
//   edge, as before) and › to its drawer (?oppetund=<id>, LessonDrawer.tsx); then „Lisa õppetund“;
// - „Kustuta moodul“ („Kustuta punkt“ for a programme point, Dim 24.10 D-5) only where it can go (AdminModule.deletable; else „Moodulit saab
//   kustutada, kui selles pole õppetunde.“ in its place, D-7): a ConfirmPanel in its place, „Kas kustutan punkti „{title}“?“ for a programme point,
//   „Kas kustutan mooduli „{title}“?“ for a module — with the name as it is in its field; then „+ Lisa moodul“ / „+ Lisa punkt“.
// The adds, moves and deletes are server actions whose answer brings the page's new read (the course editor takes it without starting its cards
// over, course/SavedCourse.tsx). Inside the editor a name's autosave is one of the editor's (course/OutlineTexts.ts). While an action is on its way
// its button is aria-disabled (a disabled button would drop the focus) and a second press does nothing.

const t = adminEt.lessons;
/** A module's or programme point's name, at most (server/course-outline.ts LESSON_LIMITS.title; the server checks it again). */
const TITLE_MAX = 120;

type Action = (fd: FormData) => void;
/** Sends these fields through `action` (a server action of useActionState). */
const send = (action: Action, fields: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  startTransition(() => action(fd));
};

/** The text of a refused change: the field codes of `invalid` (a name), else inUse, notFound, server. */
export function lessonError(r: EditResult | null, inUse: string = t.errors.inUse): string | null {
  if (!r || r.ok) return null;
  const field = r.fields?.title ?? r.fields?.body;
  if (r.error === "invalid" && field) return field === "tooLong" ? t.errors.tooLong : t.errors.required;
  if (r.error === "inUse") return inUse;
  if (r.error === "notFound") return t.errors.notFound;
  return t.errors.server;
}

/** The card's summary beside its title (P-4, P-8): an e-course's „{n} moodulit · {m} õppetundi“, a programme's „{n} punkti“ (D-6), none yet „Mooduleid veel pole.“. */
function summaryOf(modules: readonly AdminModule[], online: boolean): string {
  if (modules.length === 0) return t.empty;
  if (!online) return modules.length === 1 ? t.pointsOne : fill(t.pointsN, { n: modules.length });
  const lessons = modules.reduce((n, m) => n + m.lessons.length, 0);
  return fill(t.summary, {
    modules: modules.length === 1 ? t.modulesOne : fill(t.modulesN, { n: modules.length }),
    lessons: lessons === 1 ? t.lessonsOne : fill(t.lessonsN, { n: lessons }),
  });
}

/** A lesson row's video tag (P-4): „Töötlemisel {n}%“ only with a figure Bunny gave (S3-P3-e: none, or 0, is „Töötlemisel“). */
function videoTag(l: AdminLesson): string {
  if (l.videoStatus === "processing" && l.videoProgress !== null && l.videoProgress > 0) return fill(t.videoProgress, { n: Math.min(100, Math.round(l.videoProgress)) });
  return t.videoTag[l.videoStatus];
}

/** The video tag's colours (the Part 3 frame): „Valmis“ green, „Töötlemisel“ the status accent, „Video puudub“ and „Video viga“ red (they keep the lessons after it locked for students). */
const VIDEO_TONE: Record<AdminLesson["videoStatus"], string> = { none: ui.bad, uploading: styles.quietTag, processing: ui.warn, ready: ui.ok, failed: ui.bad };

type Props = {
  /** The saved course; null on a new course (nothing can be added before it is created). */
  courseId: number | null;
  /** An e-course: modules with lessons. A contact course: its programme (module names only). The type the editor's cards follow (the drafted one). */
  online: boolean;
  modules: AdminModule[];
};

export function LessonsEditor({ courseId, online, modules }: Props) {
  const uid = useId();
  const addField = useRef<HTMLInputElement>(null);
  // a move shows at once (in the same tick as the drop or the press), and the page's new read brings the stored order; refused, the order goes back
  const [items, moveOptimistic] = useOptimistic(modules, (list: AdminModule[], m: { from: number; to: number }) => reorder(list, m.from, m.to));
  /** The module whose move was refused: „Järjekorra muutmine ei õnnestunud. Proovi uuesti.“ under it, until the next move or the page's next read. */
  const [moveFailed, setMoveFailed] = useState<number | null>(null);
  const [readOf, setReadOf] = useState(modules);
  if (readOf !== modules) {
    setReadOf(modules);
    if (moveFailed !== null) setMoveFailed(null);
  }
  /** Each module's name as its field has it now (typed, not yet read back): the handle's and arrows' names and the announcement (review M-5). */
  const [names, setNames] = useState<Record<number, string>>({});
  const nameOf = useCallback((id: number, name: string) => setNames((all) => (all[id] === name ? all : { ...all, [id]: name })), []);
  // a lesson's ↑ / ↓ and „Kustuta moodul“ live here, not in the rows: a moved lesson can land in another module's list (a new row), a deleted
  // module's row is gone. The answer comes with the page's new state, so the effects below run once the rows are in place.
  const [lessonMove, moveLessonAction, lessonMoving] = useActionState<EditResult | null, FormData>(moveLessonInList, null);
  const [moduleDelete, deleteModuleAction, deleting] = useActionState<EditResult | null, FormData>(deleteModule, null);
  /** The lesson's ↑ / ↓ last pressed (its id), so the focus stays on it where its row is now. */
  const moved = useRef<string | null>(null);
  /** Which lesson or module the last lesson move or module delete was for (its error goes under that row). */
  const [target, setTarget] = useState<{ lessonMove?: number; moduleDelete?: number }>({});

  useEffect(() => {
    const id = moved.current;
    moved.current = null;
    if (id) document.getElementById(id)?.focus();
  }, [lessonMove]);

  // a module deleted: its row is gone, the focus goes to the field for a new one
  useEffect(() => {
    if (moduleDelete?.ok) addField.current?.focus();
  }, [moduleDelete]);

  const layout: ModuleLayout[] = items.map((m) => ({ moduleId: m.id, lessonIds: m.lessons.map((l) => l.id) }));

  const moveModule = (from: number, to: number) => {
    const id = items[from].id;
    setMoveFailed(null);
    startTransition(async () => {
      moveOptimistic({ from, to });
      let ok = false;
      try {
        ok = (await moveModuleTo({ id, index: to })).ok;
      } catch {
        ok = false;
      }
      // (the list's words for a refused move, as the course list says them: piece3-texts P-1)
      if (!ok) setMoveFailed(id);
    });
  };
  const moveLessonTo = (l: AdminLesson, dir: "up" | "down") => {
    if (lessonMoving || !moveLesson(layout, l.id, dir === "up" ? -1 : 1)) return;
    moved.current = `lesson-${l.id}-${dir}`;
    setTarget((x) => ({ ...x, lessonMove: l.id }));
    send(moveLessonAction, { id: l.id, dir });
  };

  const summary = courseId === null ? null : summaryOf(items, online);
  const nameIn = (m: AdminModule) => names[m.id] ?? m.title.et.trim();

  return (
    <section className={`${ui.card} ${styles.editor}`} aria-labelledby={`${uid}-title`} data-lessons-editor="">
      <div className={styles.intro}>
        <div className={styles.titleRow}>
          <h2 id={`${uid}-title`} className={ui.h2}>
            {online ? t.title : adminEt.courseEditor.sections.modulesC}
          </h2>
          {summary !== null && (
            <span className={styles.summary} data-modules-summary="">
              {summary}
            </span>
          )}
        </div>
        <p className={ui.hint}>{online ? t.hint : adminEt.courseEditor.fields.modulesCHint}</p>
      </div>

      {courseId === null ? (
        <p className={ui.notice}>{t.saveFirst}</p>
      ) : (
        <>
          {items.length > 0 && (
            <DragList<AdminModule>
              items={items}
              keyOf={(m) => String(m.id)}
              label={nameIn}
              onMove={moveModule}
              className={styles.modules}
              rowClassName={styles.module}
              renderRow={(m, i, handle, arrows) => (
                <ModuleRow
                  module={m}
                  n={i + 1}
                  courseId={courseId}
                  online={online}
                  handle={handle}
                  arrows={arrows}
                  onName={nameOf}
                  moveError={moveFailed === m.id ? adminEt.courses.moveError : null}
                  deleteError={target.moduleDelete === m.id ? lessonError(moduleDelete) : null}
                  deleting={deleting && target.moduleDelete === m.id}
                  onDelete={() => {
                    if (deleting) return;
                    setTarget((x) => ({ ...x, moduleDelete: m.id }));
                    send(deleteModuleAction, { id: m.id });
                  }}
                >
                  {online && (
                    <LessonList
                      module={m}
                      layout={layout}
                      courseId={courseId}
                      onMove={moveLessonTo}
                      moveError={(l) => (target.lessonMove === l.id ? lessonError(lessonMove) : null)}
                    />
                  )}
                </ModuleRow>
              )}
            />
          )}
          <AddModuleForm courseId={courseId} online={online} field={addField} />
        </>
      )}
    </section>
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameText = (a: I18n, b: I18n) => a.et === b.et && (a.ru ?? "") === (b.ru ?? "");

/** A module's name as its check refuses it, before anything is sent (the server's own check: required, at most TITLE_MAX characters a language). */
function checkTitle(f: Fields): Record<string, string> {
  const v = f.title as I18n;
  if (!v.et.trim()) return { title: "required" };
  if (v.et.length > TITLE_MAX || (v.ru ?? "").length > TITLE_MAX) return { title: "tooLong" };
  return {};
}

/**
 * A module's name, autosaved on its own route (README B2 „the title edits inline (autosave)“; R-b2): the shared engine on POST /api/admin/moodul/<id>
 * from the version the page read (`t:<hash>`); a published course's live module waits in the outline draft, a new one and an unpublished course's are
 * written on the row (server/admin-lessons.ts writeOutlineText). The copy in this browser is `mslab-draft:koolitus:<course>-moodul<id>:<tab>`, so the
 * public preview's „Loobu muudatustest“ drops it with the course's (lib/course-copies.ts). Inside the course editor it is one of the editor's
 * autosaves (course/OutlineTexts.ts).
 */
function useModuleTitle(courseId: number, m: AdminModule, label: string) {
  const texts = useOutlineTexts();
  /** The editor's hold as it is when an answer comes (a save's answer comes after its render). */
  const editor = useRef(texts);
  useLayoutEffect(() => {
    editor.current = texts;
  });
  /** The server's refusal code of the name (400), until it is typed in again or saved. */
  const [refused, setRefused] = useState<string | null>(null);
  const save = useMemo<SendPatch>(() => {
    const base = patchSender(`/api/admin/moodul/${m.id}`);
    return async (body, opts) => {
      const answer = await base(body, opts);
      const reply = answer && isRecord(answer.body) ? answer.body : null;
      if (answer?.status === 400 && reply?.error === "invalid" && isRecord(reply.fields) && typeof reply.fields.title === "string") setRefused(reply.fields.title);
      else if (answer?.status === 200 && reply?.ok === true) {
        setRefused(null);
        // stored (its version moved): the PublishBar's labels and the rows' „avaldamata“ are the server's to say
        if (reply.version !== body.version) editor.current?.stored();
      }
      return answer;
    };
  }, [m.id]);
  const named = useCallback(() => label, [label]);
  const auto = useAutosave({
    owner: COURSE_COPY_OWNER,
    key: courseCopyKey(courseId, `moodul${m.id}`),
    version: m.version,
    fields: { title: m.title },
    save,
    validate: checkTitle,
    label: named,
    focusField: () => document.querySelector<HTMLElement>(`[data-i18n="module-${m.id}"]`)?.focus(),
  });

  const { flush, discardCopy, setField, restore, status } = auto;
  const join = texts?.join;
  const report = texts?.report;
  const key = String(m.id);
  useEffect(() => join?.({ flush, discardCopy }), [join, flush, discardCopy]);
  useEffect(() => report?.(key, status), [report, key, status]);
  useEffect(() => () => report?.(key, null), [report, key]);

  const value = auto.fields.title as I18n;
  const held = status.kind === "invalid";
  const code = held ? (checkTitle(auto.fields).title ?? refused ?? "required") : null;
  return {
    value,
    set: (next: I18n) => {
      if (texts?.frozen) return;
      if (!sameText(next, value)) setRefused(null);
      setField("title", next);
    },
    flush: () => void flush(),
    error: code === null ? undefined : code === "tooLong" ? t.errors.tooLong : t.errors.required,
    conflict: auto.conflict !== null,
    restore: () => void restore(),
  };
}

type ModuleRowProps = {
  module: AdminModule;
  n: number;
  courseId: number;
  online: boolean;
  handle: ReactNode;
  arrows: ReactNode;
  /** Tells the list the name as the field has it now. */
  onName: (id: number, name: string) => void;
  moveError: string | null;
  deleteError: string | null;
  deleting: boolean;
  onDelete: () => void;
  children: ReactNode;
};

/** One module (the Part 3 frame's box): ⋮⋮, its number, its name, „avaldamata“, ↑ ↓; its lessons; „Kustuta moodul“ where it can go, else why not. */
function ModuleRow({ module: m, n, courseId, online, handle, arrows, onName, moveError, deleteError, deleting, onDelete, children }: ModuleRowProps) {
  const uid = useId();
  const label = online ? t.moduleName : adminEt.courseEditor.fields.modulesC;
  const title = useModuleTitle(courseId, m, label);
  const [asking, setAsking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  /** „Katkesta“ was pressed: the button comes back with the focus (README §1.6). */
  const refocus = useRef(false);
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    opener.current?.focus();
  }, [asking]);
  // the name as its field has it (a name typed and not yet read back is the one she sees; a field typed away keeps the stored one)
  const name = title.value.et.trim() || m.title.et.trim();
  useEffect(() => onName(m.id, name), [onName, m.id, name]);
  const error = moveError ?? deleteError;

  return (
    <div className={styles.box} data-module={m.id}>
      <div className={styles.moduleHead}>
        {handle && <span className={styles.handle}>{handle}</span>}
        <span className={styles.moduleNum} aria-hidden="true">
          {String(n).padStart(2, "0")}
        </span>
        <div className={styles.name} onBlur={title.flush} data-module-name="">
          <I18nInput
            label={label}
            labelHidden
            name={`module-${m.id}`}
            value={title.value}
            onChange={title.set}
            maxLength={TITLE_MAX}
            error={title.error}
            describedBy={m.changed ? `${uid}-tag` : undefined}
          />
        </div>
        {m.changed && (
          <span id={`${uid}-tag`} className={styles.rowTag} data-module-tag="">
            {adminEt.publish.fieldTag}
          </span>
        )}
        {arrows && <span className={styles.arrows}>{arrows}</span>}
      </div>

      {title.conflict && (
        <p className={styles.restore}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={title.restore} data-module-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}

      {children}

      {!m.deletable ? (
        <p className={`${ui.muted} ${ui.small} ${styles.blocked}`} data-delete-blocked="">
          {t.deleteModuleBlocked}
        </p>
      ) : asking ? (
        <ConfirmPanel
          question={fill(online ? t.deleteModuleConfirm : t.deletePointConfirm, { title: name })}
          yesLabel={t.deleteYes}
          tone="danger"
          busy={deleting}
          onYes={onDelete}
          onCancel={() => {
            refocus.current = true;
            setAsking(false);
          }}
        />
      ) : (
        <div className={forms.actions}>
          <button ref={opener} type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} onClick={() => setAsking(true)} data-delete-module="">
            {online ? t.deleteModule : t.deletePoint}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className={`${ui.error} ${styles.rowError}`} data-module-error="">
          {error}
        </p>
      )}
    </div>
  );
}

/** An e-course module's lessons: name, tags, ↑ ↓ and › (the drawer); then „Lisa õppetund“. */
function LessonList({
  module: m,
  layout,
  courseId,
  onMove,
  moveError,
}: {
  module: AdminModule;
  layout: ModuleLayout[];
  courseId: number;
  onMove: (l: AdminLesson, dir: "up" | "down") => void;
  moveError: (l: AdminLesson) => string | null;
}) {
  return (
    <div className={styles.lessonPart}>
      {m.lessons.length === 0 ? (
        <p className={`${ui.muted} ${ui.small}`}>{t.noLessons}</p>
      ) : (
        <ol className={styles.lessons} data-lessons="">
          {m.lessons.map((l) => {
            const title = l.title.et;
            const error = moveError(l);
            return (
              <li key={l.id} className={styles.lesson} data-lesson={l.id}>
                <span className={styles.lessonTitle} data-lesson-title="">
                  {title}
                </span>
                <span className={styles.tags}>
                  {l.changed && (
                    <span className={styles.rowTag} data-lesson-tag="">
                      {adminEt.publish.fieldTag}
                    </span>
                  )}
                  {l.hidden && (
                    <span className={`${ui.tag} ${ui.muted}`} data-lesson-hidden="">
                      {t.hiddenTag}
                    </span>
                  )}
                  {l.kind === "text" ? (
                    <span className={`${ui.tag} ${styles.quietTag}`} data-lesson-kind="text">
                      {t.textTag}
                    </span>
                  ) : (
                    <span className={`${ui.tag} ${VIDEO_TONE[l.videoStatus]}`} data-lesson-video={l.videoStatus}>
                      {videoTag(l)}
                    </span>
                  )}
                </span>
                <span className={`${ed.tools} ${styles.lessonTools}`}>
                  <button
                    id={`lesson-${l.id}-up`}
                    type="button"
                    className={ed.iconBtn}
                    aria-label={fill(t.moveUp, { title })}
                    aria-disabled={!moveLesson(layout, l.id, -1) || undefined}
                    onClick={() => onMove(l, "up")}
                  >
                    ↑
                  </button>
                  <button
                    id={`lesson-${l.id}-down`}
                    type="button"
                    className={ed.iconBtn}
                    aria-label={fill(t.moveDown, { title })}
                    aria-disabled={!moveLesson(layout, l.id, 1) || undefined}
                    onClick={() => onMove(l, "down")}
                  >
                    ↓
                  </button>
                  <Link
                    id={`edit-lesson-${l.id}`}
                    className={styles.open}
                    href={`/admin/koolitused/${courseId}?oppetund=${l.id}`}
                    scroll={false}
                    aria-label={fill(t.editLabel, { title })}
                    data-edit-lesson=""
                  >
                    <span aria-hidden="true">›</span>
                  </Link>
                </span>
                {error && (
                  <p role="alert" className={`${ui.error} ${styles.rowError}`}>
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {/* a new key once a lesson is added: the field starts empty again */}
      <AddLessonForm key={m.lessons.length} moduleId={m.id} courseId={courseId} />
    </div>
  );
}

/** "Lisa õppetund": a name and one button; the new lesson opens in the drawer. */
function AddLessonForm({ moduleId, courseId }: { moduleId: number; courseId: number }) {
  const uid = useId();
  const [state, action, pending] = useActionState<EditResult | null, FormData>(addLesson, null);
  const error = lessonError(state);
  return (
    <form
      className={styles.add}
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
      noValidate
      data-add-lesson={moduleId}
    >
      <input type="hidden" name="moduleId" value={moduleId} />
      <input type="hidden" name="courseId" value={courseId} />
      <div className={`${ui.field} ${styles.addField}`}>
        <label htmlFor={`add-lesson-${moduleId}`}>{t.newLesson}</label>
        <input
          id={`add-lesson-${moduleId}`}
          name="titleEt"
          className={ui.input}
          type="text"
          autoComplete="off"
          maxLength={TITLE_MAX}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${uid}-msg`}
        />
      </div>
      <button type="submit" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} aria-disabled={pending || undefined}>
        {pending ? adminEt.common.saving : t.addLesson}
      </button>
      <p id={`${uid}-msg`} role="status" className={`${ui.error} ${styles.addMsg}`}>
        {error ?? ""}
      </p>
    </form>
  );
}

/** „+ Lisa moodul“ / „+ Lisa punkt“ at the end (the frame's pill; the „+“ in the text, as the list's „Lisa koolitus +“): a name and one button; cleared once it is there. */
function AddModuleForm({ courseId, online, field }: { courseId: number; online: boolean; field: React.RefObject<HTMLInputElement | null> }) {
  const uid = useId();
  const [value, setValue] = useState("");
  const [state, action, pending] = useActionState<EditResult | null, FormData>(addModule, null);
  // the answer is about what was sent: a changed name is not refused (nor added) yet
  const [edited, setEdited] = useState(false);
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(false);
    if (state?.ok) setValue("");
  }
  const error = edited ? null : lessonError(state);
  return (
    <form
      className={`${styles.add} ${styles.addModule}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        send(action, { courseId, titleEt: value, titleRu: "" });
      }}
      noValidate
      data-add-module=""
    >
      <div className={`${ui.field} ${styles.addField}`}>
        <label htmlFor={`${uid}-name`}>{online ? t.newModule : t.newItem}</label>
        <input
          ref={field}
          id={`${uid}-name`}
          name="titleEt"
          className={ui.input}
          type="text"
          autoComplete="off"
          maxLength={TITLE_MAX}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setEdited(true);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${uid}-msg`}
        />
      </div>
      <button type="submit" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} aria-disabled={pending || undefined}>
        {pending ? adminEt.common.saving : `+ ${online ? t.addModule : t.addItem}`}
      </button>
      <p id={`${uid}-msg`} role="status" className={`${ui.error} ${styles.addMsg}`}>
        {error ?? ""}
      </p>
    </form>
  );
}
