"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { ShrinkError, shrinkImage, type ShrinkOptions, type ShrinkProblem } from "@/lib/shrink-image";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

/** The longest side of an uploaded image (spec: ≤ 2400 px). */
export const MAX_EDGE = 2400;
const ACCEPT = ["image/jpeg", "image/png", "image/webp"];
/** The server's limit (MAX_IMAGE_BYTES; Vercel refuses request bodies over 4.5 MB); checked here too so a hopeless upload is not sent. */
const MAX_BYTES = 4 * 1024 * 1024;
const QUALITY = 0.86;
/**
 * The admin's images (lib/shrink-image.ts, moved there in the e-course completion phase): at most 2400 px, JPEG stays JPEG at 0.86, PNG and
 * WebP become WebP (PNG where the browser cannot write WebP), at most 4 MB; originals over 60 MB are not opened.
 */
const SHRINK: ShrinkOptions = { maxEdge: MAX_EDGE, quality: QUALITY, maxBytes: MAX_BYTES, accept: ACCEPT, output: "keep" };

type Problem = ShrinkProblem | "session" | "storage" | "server";
class UploadProblem extends Error {
  constructor(readonly problem: Problem) {
    super(problem);
  }
}

/** Sends one prepared image to /api/admin/upload; its key. */
async function send(file: File): Promise<string> {
  const body = new FormData();
  body.set("file", file);
  let res: Response;
  try {
    res = await fetch("/api/admin/upload", { method: "POST", body, credentials: "same-origin" });
  } catch {
    throw new UploadProblem("server");
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; key?: string; error?: string } | null;
  if (res.ok && json?.ok && typeof json.key === "string") return json.key;
  if (res.status === 401) throw new UploadProblem("session");
  if (res.status === 413) throw new UploadProblem("size");
  if (res.status === 503 && json?.error === "storage") throw new UploadProblem("storage"); // no image store is set up (R2 variables)
  if (res.status === 415) throw new UploadProblem("type");
  throw new UploadProblem("server");
}

type Status = { kind: "idle" } | { kind: "busy"; text: string } | { kind: "done"; text: string } | { kind: "error"; text: string };

/** An upload's state for its parts (UploadPicker, UploadNotes): their ids, the status line, and the pick. */
export type ImageUploadState = {
  /** The ids' stem: the file field is `${id}-file`, its notes `${id}-hint` and `${id}-status`. */
  id: string;
  status: Status;
  busy: boolean;
  pick: (files: File[]) => void;
};

/**
 * The upload of ImageUpload, for a page that places its parts itself (Koolitaja's gallery grid, piece 4a R-g: the „+ Lisa“ tile among the pictures,
 * its notes under the grid): files picked while others are still uploading wait their turn (nothing is dropped), one queue, one counter; each one
 * made smaller and metadata-free, uploaded, and its key handed to `onUploaded` in the order picked.
 */
export function useImageUpload(onUploaded: (keys: string[]) => void): ImageUploadState {
  const t = adminEt.upload;
  const id = useId();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const queue = useRef<File[]>([]);
  const progress = useRef({ running: false, done: 0, total: 0, added: 0, problem: null as Problem | null });

  const run = async () => {
    const p = progress.current;
    p.running = true;
    while (queue.current.length) {
      const file = queue.current.shift()!;
      setStatus({ kind: "busy", text: p.total > 1 ? fill(t.uploading, { n: p.done + 1, total: p.total }) : t.preparing });
      try {
        const key = await send(await shrinkImage(file, SHRINK));
        p.added++;
        onUploaded([key]); // one by one, in the order picked; the gallery adds to its list as it is by then
      } catch (e) {
        p.problem = e instanceof UploadProblem || e instanceof ShrinkError ? e.problem : "server";
      }
      p.done++;
    }
    // the last problem is said; the images that did upload are already in the list
    if (p.problem) setStatus({ kind: "error", text: t[p.problem] });
    else setStatus({ kind: "done", text: p.added === 1 ? t.doneOne : fill(t.doneMany, { n: p.added }) });
    progress.current = { running: false, done: 0, total: 0, added: 0, problem: null };
  };

  const pick = (files: File[]) => {
    if (files.length === 0) return;
    queue.current.push(...files);
    progress.current.total += files.length;
    if (progress.current.running) setStatus({ kind: "busy", text: fill(t.queued, { n: files.length, total: progress.current.total }) });
    else void run();
  };
  return { id, status, busy: status.kind === "busy", pick };
}

/**
 * The upload's file field (hidden: its label is what is seen and pressed) and the label, with `children` as the label's words. `name`: the field's
 * own name for a screen reader, where the words seen are shorter („+ Lisa“, named „Lisa pilte“).
 */
export function UploadPicker({ upload, multiple, className, name, children }: { upload: ImageUploadState; multiple?: boolean; className?: string; name?: string; children: ReactNode }) {
  return (
    <>
      <input
        id={`${upload.id}-file`}
        type="file"
        accept={ACCEPT.join(",")}
        multiple={multiple}
        aria-label={name}
        aria-describedby={`${upload.id}-hint ${upload.id}-status`}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // reset at once, so the same file can be picked again (and a pick during an upload is not lost)
          e.target.value = "";
          upload.pick(files);
        }}
      />
      <label htmlFor={`${upload.id}-file`} className={className}>
        {children}
      </label>
    </>
  );
}

/** The upload's notes: what it takes (and what the browser does to a picture first), and how it went (the field's description). */
export function UploadNotes({ upload }: { upload: ImageUploadState }) {
  const t = adminEt.upload;
  const { id, status } = upload;
  return (
    <>
      <p id={`${id}-hint`} className={`${ui.muted} ${styles.uploadHint}`}>
        {t.hint}
      </p>
      <p id={`${id}-status`} role="status" className={status.kind === "error" ? ui.error : status.kind === "done" ? ui.success : ui.hint} data-upload-status={status.kind}>
        {status.kind === "idle" ? "" : status.text}
      </p>
    </>
  );
}

/**
 * "Lisa pilte": picks images, makes each smaller and metadata-free in the browser (lib/shrink-image.ts shrinkImage) and uploads it; the
 * keys of the stored images go to `onUploaded` in the order picked. The server checks type, size and content again.
 */
export function ImageUpload({ onUploaded, multiple = false, label }: { onUploaded: (keys: string[]) => void; multiple?: boolean; label?: string }) {
  const t = adminEt.upload;
  const upload = useImageUpload(onUploaded);
  return (
    <div className={styles.upload} data-image-upload="" aria-busy={upload.busy || undefined}>
      <UploadPicker upload={upload} multiple={multiple} className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}>
        {label ?? (multiple ? t.choose : t.chooseOne)}
      </UploadPicker>
      <UploadNotes upload={upload} />
    </div>
  );
}
