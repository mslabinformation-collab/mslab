"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatSize } from "@/i18n/format";
import { removeLessonFile, undoRemoveLessonFile } from "@/server/actions/admin-lessons";
import type { AdminLessonFile } from "@/server/admin-lessons";
import type { EditResult } from "@/server/edit-check";
import { useGuardSource } from "./LeaveGuard";
import { lessonError } from "./LessonsEditor";
import { useUndo } from "./UndoBar";
import ui from "./ui.module.css";
import cd from "./ClientDrawer.module.css";
import styles from "./LessonsEditor.module.css";

// The lesson drawer's „Failid“ (admin UX pass piece 3a, Task 10; README B2 „Failid: drop zone + list; „Eemalda“ is instant with UndoBar“; the Part 3
// frame, and the Part 4 one on a phone, where the file picker replaces drag and drop):
// - the list: each file „{name} · {size}“ with „Eemalda“. „Eemalda“ takes the row away at once and only marks the file on the server (R-f,
//   server/lesson-files.ts removeLessonFile); the UndoBar says „Fail eemaldatud.“ (S3-P3-c), and its „Võta tagasi“ clears the mark (undoRemoveLessonFile)
//   while the server still has the row (10 s); after that the bar says its own ADM:162 line. The undo is the server's, so the bar stays when the
//   drawer closes and still works then; the page's read brings the file back, and the focus goes to its „Eemalda“ when it fell with the bar;
// - the drop zone: the file input's label (a tap anywhere on it opens the picker), „Lohista fail siia või vali fail · PDF, Word, pilt, kuni 4 MB“, on a
//   phone „Vali fail“. A file picked or dropped goes as it is to POST /api/admin/lesson-file, which checks its type, size and content
//   (server/lesson-files.ts); here only its size is checked first, so a hopeless upload is not sent. One at a time: a pick or a drop while one is on
//   its way is ignored. While it uploads, leaving asks through the leave guard (reason `upload`).

const t = adminEt.lessons.files;
const ACCEPT = ".pdf,.docx,image/jpeg,image/png,image/webp";
/** The server's limit (MAX_IMAGE_BYTES), written out: no server module enters the browser bundle. */
const MAX_BYTES = 4 * 1024 * 1024;

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "done" } | { kind: "error"; text: string };
type FileProblem = "type" | "size" | "empty" | "content" | "storage" | "server";
const PROBLEMS: readonly string[] = ["type", "size", "empty", "content", "storage", "server"] satisfies FileProblem[];

/** What the upload route's answer means for Maria (null: stored). */
async function answerText(res: Response): Promise<string | null> {
  if (res.status === 201) return null;
  if (res.status === 401) return t.session;
  const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const error = typeof json?.error === "string" ? json.error : "";
  if (error === "notFound") return adminEt.lessons.errors.notFound;
  if (PROBLEMS.includes(error)) return t[error as FileProblem];
  if (res.status === 413) return t.size;
  return t.server; // "missing" and anything else
}

/** The focus has nowhere to be: on <body>, on an element that is gone, or in the UndoBar (which goes once its undo is done). */
const focusFell = () => {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || active.closest("[data-undo-bar]") !== null;
};

const without = (set: ReadonlySet<number>, id: number): ReadonlySet<number> => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

export function LessonFiles({ lessonId, files }: { lessonId: number; files: AdminLessonFile[] }) {
  const uid = useId();
  const router = useRouter();
  const undo = useUndo();
  const input = useRef<HTMLInputElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  /** One upload at a time: a pick while one is on its way is ignored (the picker does not even open). */
  const uploading = useRef(false);
  /** A file is dragged over the zone. */
  const [over, setOver] = useState(false);
  /** Files taken away here: out of the list at once, until the page's read is without them (or back, when the server refuses). */
  const [gone, setGone] = useState<ReadonlySet<number>>(() => new Set());
  const [removeError, setRemoveError] = useState<string | null>(null);
  /** A file „Võta tagasi“ brought back: its „Eemalda“ gets the focus once the page's read lists it again (if the focus fell with the bar). */
  const back = useRef<number | null>(null);

  // the page's read without a file taken away here: nothing more to hold back
  const listed = new Set(files.map((f) => f.id));
  if ([...gone].some((id) => !listed.has(id))) setGone(new Set([...gone].filter((id) => listed.has(id))));

  useEffect(() => {
    const id = back.current;
    if (id === null || !files.some((f) => f.id === id)) return;
    back.current = null;
    if (focusFell()) document.querySelector<HTMLElement>(`[data-lesson-file="${id}"] button`)?.focus();
  }, [files]);

  const busy = status.kind === "busy";
  // while a file uploads, leaving asks (README §1.5): the guard's notice names „Failid“ and says „Üleslaadimine käib.“
  useGuardSource({
    id: `${uid}-upload`,
    label: () => adminEt.lessons.files.title,
    flush: async () => false,
    unconfirmed: () => (busy ? { reason: "upload" } : null),
    focus: () => statusLine.current?.focus(),
  });

  const upload = async (file: File) => {
    if (uploading.current) return;
    if (file.size > MAX_BYTES) return setStatus({ kind: "error", text: t.size });
    uploading.current = true;
    setStatus({ kind: "busy" });
    const body = new FormData();
    body.set("lessonId", String(lessonId));
    body.set("file", file);
    let text: string | null;
    try {
      text = await answerText(await fetch("/api/admin/lesson-file", { method: "POST", body, credentials: "same-origin" }));
    } catch {
      text = t.server;
    }
    uploading.current = false;
    if (text) return setStatus({ kind: "error", text });
    setStatus({ kind: "done" });
    router.refresh();
  };

  const remove = (f: AdminLessonFile) => {
    if (gone.has(f.id)) return;
    setRemoveError(null);
    // its row goes at once, and its button with it: the focus goes to the picker (as before the UndoBar)
    input.current?.focus();
    setGone((g) => new Set(g).add(f.id));
    void (async () => {
      let result: EditResult;
      try {
        result = await removeLessonFile(f.id);
      } catch {
        result = { ok: false, error: "server" };
      }
      if (!result.ok) {
        setGone((g) => without(g, f.id));
        setRemoveError(lessonError(result));
        return;
      }
      // the undo is the server's (the row is only marked): it works after the drawer has closed too, so the bar is not taken away with it
      undo.show({
        text: t.removed,
        undo: async () => {
          setGone((g) => without(g, f.id));
          back.current = f.id;
          try {
            return (await undoRemoveLessonFile(f.id)).ok;
          } catch {
            return false;
          }
        },
      });
    })();
  };

  const message = status.kind === "busy" ? t.uploading : status.kind === "done" ? t.added : status.kind === "error" ? status.text : "";
  const shown = files.filter((f) => !gone.has(f.id));
  const [before, after = ""] = t.drop.split("{pick}");

  return (
    <section className={cd.section} aria-labelledby={`${uid}-h`} data-lesson-files="">
      <h3 id={`${uid}-h`} className={styles.drawerLabel}>
        {t.title}
      </h3>
      {shown.length > 0 && (
        <ul className={styles.files}>
          {shown.map((f) => (
            <li key={f.id} className={styles.file} data-lesson-file={f.id}>
              <span className={styles.fileName}>
                {f.name} · {formatSize(f.size, "et")}
              </span>
              <button type="button" className={styles.fileRemove} aria-label={fill(t.removeLabel, { name: f.name })} onClick={() => remove(f)}>
                {t.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
      {removeError && (
        <p role="alert" className={ui.error}>
          {removeError}
        </p>
      )}
      <div className={styles.dropArea} aria-busy={busy || undefined}>
        <input
          ref={input}
          id={`${uid}-file`}
          className={styles.dropInput}
          type="file"
          accept={ACCEPT}
          aria-describedby={`${uid}-status`}
          aria-disabled={busy || undefined}
          onClick={(e) => {
            // while a file is uploading, the zone does nothing: no second picker
            if (uploading.current) e.preventDefault();
          }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // reset at once, so the same file can be picked again
            e.target.value = "";
            // a pick that still arrives during an upload (a test, a quick second pick) is ignored too
            if (!file || uploading.current) return;
            void upload(file);
          }}
        />
        <label
          htmlFor={`${uid}-file`}
          className={styles.drop}
          aria-disabled={busy || undefined}
          data-file-drop=""
          data-file-add=""
          data-over={over ? "" : undefined}
          onDragEnter={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragOver={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const file = e.dataTransfer?.files?.[0];
            if (file && !uploading.current) void upload(file);
          }}
        >
          <span className={styles.dropWide} data-drop-wide="">
            {before}
            <u className={styles.pick}>{t.pick}</u>
            {after}
          </span>
          <span className={styles.dropPhone} data-drop-phone="">
            <u className={styles.pick}>{t.pickPhone}</u>
          </span>
        </label>
        <p
          id={`${uid}-status`}
          ref={statusLine}
          tabIndex={-1}
          role="status"
          className={`${status.kind === "error" ? ui.error : status.kind === "done" ? ui.success : ui.hint} ${styles.statusLine}`}
          data-file-status={status.kind}
        >
          {message}
        </p>
      </div>
    </section>
  );
}
