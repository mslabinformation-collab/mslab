"use client";

import { startTransition, useActionState, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { newCourseDraft, type CourseDraft } from "@/domain/course-editor";
import { COURSE_PARTS, PART_FIELDS, partValue, type EditorPart } from "@/domain/course-parts";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { stableJson } from "@/lib/version";
import { createCourse } from "@/server/actions/admin-content";
import type { AdminModule } from "@/server/admin-lessons";
import type { EditResult } from "@/server/edit-check";
import { useGuardSource } from "../LeaveGuard";
import ui from "../ui.module.css";
import styles from "../CourseEditor.module.css";
import { fieldLabel } from "./course-view";
import { CourseView } from "./CourseView";
import { focusPartField } from "./useCoursePart";
import { useLocalParts } from "./useLocalParts";
import type { OtherCourse } from "./types";

// The new-course page /admin/koolitused/uus (admin UX pass piece 3a, Task 7; piece3-texts S3-P3-g, P-6; README P1 §3.1): the same cards, but nothing
// saves until the one explicit „Lisa koolitus“ (createCourse) — the course does not exist yet. The header says „Täida kohustuslikud väljad“ until
// „Koolituse nimi“ (the one required field) has its Estonian text, then „Vajuta „Lisa koolitus“.“; the press sends the draft and the new course opens
// at its own address, where every card autosaves. Leaving with typed text asks with the leave guard's notice and the reason „Koolitust pole veel
// lisatud.“; „Sulge, tekst jääb seadmesse“ keeps the typed draft in this browser (NEW_COPY), and the page brings it back the next time it opens.

const t = adminEt.courseEditor;

/** This browser's copy of the new course typed and not created yet (one per browser; the saved course's page drops it once it is created). */
export const NEW_COPY = "mslab-draft:koolitus:uus";

const EMPTY = newCourseDraft();

/** The copy, read defensively: its fields over a new draft, each only when it has the new draft's kind (a list, a text, an object). */
function readCopy(): CourseDraft | null {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(NEW_COPY) ?? "null");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const out: Record<string, unknown> = { ...EMPTY };
    for (const [key, base] of Object.entries(EMPTY)) {
      const v = (raw as Record<string, unknown>)[key];
      if (key === "id" || key === "version" || v === undefined) continue;
      const kind = (x: unknown) => (Array.isArray(x) ? "list" : x === null ? "null" : typeof x);
      if (kind(v) === kind(base) || (key === "badge" && (v === null || typeof v === "object"))) out[key] = v;
    }
    return out as CourseDraft;
  } catch {
    return null;
  }
}

/** The new course is created: this browser's copy of it goes (the saved course's page, `?loodud=1`). */
export const dropNewCourseCopy = (): void => writeCopy(null);

function writeCopy(draft: CourseDraft | null): void {
  try {
    if (draft) window.localStorage.setItem(NEW_COPY, JSON.stringify(draft));
    else window.localStorage.removeItem(NEW_COPY);
  } catch {
    // full or blocked: nothing is kept
  }
}

/** The first field typed into, in screen order (its part and name): what the leave guard's notice names. */
function firstTyped(draft: CourseDraft): { part: EditorPart; name: string } | null {
  for (const part of COURSE_PARTS) {
    if (part === "outline") continue;
    const now = partValue(part, draft) as Record<string, unknown>;
    const empty = partValue(part, EMPTY) as Record<string, unknown>;
    const name = (PART_FIELDS[part] as readonly string[]).find((n) => stableJson(now[n]) !== stableJson(empty[n]));
    if (name) return { part, name };
  }
  return null;
}

export function NewCourse({ others, next, modules }: { others: OtherCourse[]; next: { startsAt: string; city: string } | null; modules: AdminModule[] }) {
  const uid = useId();
  const [draft, setDraft] = useState<CourseDraft>(EMPTY);
  const [state, action, pending] = useActionState<EditResult | null, FormData>(createCourse, null);
  /** The draft the last press sent: a refusal of a list is placed on its rows as they were then. */
  const [sent, setSent] = useState<CourseDraft | null>(null);
  // the fields typed again since the refusal: their words go
  const [retyped, setRetyped] = useState<{ of: EditResult | null; names: string[] }>({ of: null, names: [] });
  const refused = useMemo(() => {
    if (!state || state.ok || state.error !== "invalid") return {};
    const names = retyped.of === state ? retyped.names : [];
    return Object.fromEntries(Object.entries(state.fields ?? {}).filter(([name]) => !names.includes(name))) as Record<string, string>;
  }, [state, retyped]);
  const clear = useCallback((name: string) => setRetyped((r) => ({ of: state, names: r.of === state ? [...r.names, name] : [name] })), [state]);
  const parts = useLocalParts({ draft, setDraft, refused, sent, clear });

  // the copy an earlier visit kept comes back (after the first render: the server knows no browser storage); from then on it follows the draft
  const restored = useRef(false);
  useEffect(() => {
    if (!restored.current) {
      restored.current = true;
      const copy = readCopy();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the storage is only known in the browser, after hydration
      if (copy && stableJson(copy) !== stableJson(EMPTY)) setDraft(copy);
      return;
    }
    writeCopy(stableJson(draft) === stableJson(EMPTY) ? null : draft);
  }, [draft]);

  // a refused create: the first marked field gets the focus
  useEffect(() => {
    if (!state || state.ok || state.error !== "invalid") return;
    document.querySelector<HTMLElement>('[data-course-editor] [aria-invalid="true"], [data-course-editor] [data-invalid]')?.focus();
  }, [state]);

  // the leave guard (S3-P3-g): typed and not created yet — it asks, naming the first field typed into, with the reason „Koolitust pole veel lisatud.“
  const typed = firstTyped(draft);
  useGuardSource({
    id: uid,
    label: () => (typed ? fieldLabel(typed.part, typed.name) : t.fields.title),
    flush: async () => false,
    unconfirmed: () => (typed ? { reason: "notCreated", thing: t.newThing } : null),
    focus: () => typed && focusPartField(typed.part, typed.name),
  });

  const ready = draft.title.et.trim() !== "";
  const create = () => {
    if (pending) return;
    const fd = new FormData();
    fd.set("data", JSON.stringify(draft));
    setSent(draft);
    startTransition(() => action(fd));
  };
  const failed = state && !state.ok ? (state.error === "invalid" ? t.invalid : adminEt.common.saveError) : null;

  return (
    <CourseView
      title={t.newTitle}
      published={draft.published}
      sample={draft.isSample}
      status={
        <span className={styles.create}>
          <span className={styles.createLine} role="status" data-new-course-line="">
            {ready ? fill(t.newReady, { button: adminEt.courses.add }) : t.newRequired}
          </span>
          <button type="button" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined} onClick={create} data-create-course="">
            {adminEt.courses.add}
          </button>
          {failed && (
            <span role="alert" className={`${ui.error} ${styles.createError}`} data-new-course-error="">
              {failed}
            </span>
          )}
        </span>
      }
      publicHref={null}
      parts={parts}
      courseId={null}
      modules={modules}
      others={others}
      next={next}
      locked={false}
      liveType={draft.type}
      priceMissing={false}
      blocked={[]}
      switches={{
        published: draft.published,
        sample: draft.isSample,
        onPublished: (on) => setDraft((d) => ({ ...d, published: on })),
        onSample: (on) => setDraft((d) => ({ ...d, isSample: on })),
      }}
    />
  );
}
