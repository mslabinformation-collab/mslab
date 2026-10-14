"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/site/Icon";
import { Notice } from "@/components/site/Notice";
import ui from "@/components/site/ui.module.css";
import { PHOTOS_PER_POINT, type PracticalStatus } from "@/domain/completion";
import { pick } from "@/i18n/field";
import { fill, formatDate } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import { preparePhoto, ShrinkError, type PreparedPhoto } from "@/lib/shrink-image";
import type { PhotoView, PointView, PracticalView } from "@/server/practical";
import { AccountLoader, type Reload } from "./AccountLoader";
import { GreetingSkeleton } from "./CardSkeleton";
import { uploadPhoto } from "./photo-upload";
import { AddPhoto, PhotoSlot, photoUrl, stopped, type PendingState } from "./PhotoSlot";
import type { PracticalTexts } from "./texts";
import page from "./EcoursePage.module.css";
import styles from "./PracticalPage.module.css";

/** GET /api/konto/kursus/<slug>/praktiline's answer (server/practical.ts PracticalView). */
type PracticalAnswer = PracticalView & { ok: true };

/**
 * A photo picked on the page and not stored yet: the picked file, its made-smaller copy once made (kept, so "Proovi uuesti" sends the same
 * photo again without picking it), where it is, the share sent, and the local address of its thumbnail shown in its row.
 */
type Pending = { id: number; stage: number; file: File; prepared: PreparedPhoto | null; state: PendingState; progress: number; preview: string | null };

/** A ref that focuses its element once, when it appears. */
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/** A local address for a prepared thumbnail, shown while it uploads; null where the browser gives none. */
function previewOf(blob: Blob): string | null {
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/** Frees a thumbnail's local address. */
function forget(url: string | null): void {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // nothing to free
  }
}

/**
 * The personal part of /konto/kursus/<slug>/praktiline (e-course completion, spec §4.3; the page is a static shell, the same for every
 * visitor): loads GET /api/konto/kursus/<slug>/praktiline in the browser (AccountLoader: skeleton, signed out → the login page, another
 * device, error + retry), then the practical work (PracticalBody). Not open yet: "Praktiline töö avaneb, kui eelnevad sammud on tehtud.";
 * none for her (no access, a revoked one, no points and no notes sent): "Praktilist tööd ei leitud."; both with the way back to the course.
 */
export function PracticalPage({ slug, locale, t }: { slug: string; locale: Locale; t: PracticalTexts }) {
  const back = (
    <Link className={ui.btn} href={href(locale, `/konto/kursus/${slug}`)}>
      {t.back}
      <Icon name="arrow" />
    </Link>
  );
  return (
    <AccountLoader<PracticalAnswer>
      path={`/api/konto/kursus/${encodeURIComponent(slug)}/praktiline`}
      locale={locale}
      t={{ ...t.loader, loading: t.loading }}
      skeleton={
        <div className={`${ui.wrap} ${page.wait}`}>
          <GreetingSkeleton />
        </div>
      }
      notFound={
        <div data-account-state="notFound">
          <Notice title={t.notFound}>{back}</Notice>
        </div>
      }
      render={(data, reload) =>
        data.locked ? (
          <div data-account-state="locked">
            <Notice title={t.locked}>{back}</Notice>
          </div>
        ) : (
          <PracticalBody data={data} slug={slug} locale={locale} t={t} reload={reload} />
        )
      }
    />
  );
}

/**
 * The practical work, top to bottom: the eyebrow, the course, the one sentence for the status (or, after the access ended, that it is
 * read-only); "Lõpetatud {date}" once all is approved and the course completed; Maria's points (PointCard); her general notes and the day
 * she sent them; the one button ("Saada hindamiseks", or "Saada uuesti" in a "Paranda" round) with its confirmation, why it waits, and why
 * a step failed; the quiet way back.
 * Uploads (spec §4.3, Review Focus 1): each picked photo is made smaller (lib/shrink-image.ts preparePhoto) and sent (photo-upload.ts) one
 * at a time for the whole page, in the order picked; a failure keeps the prepared copy for "Proovi uuesti" and the queue goes on. A 401, a
 * 404 or a "closed" (sent from another device) loads the page again quietly, which then shows what is true now. Leaving the page stops
 * the upload under way.
 */
function PracticalBody({ data, slug, locale, t, reload }: { data: PracticalAnswer; slug: string; locale: Locale; t: PracticalTexts; reload: Reload }) {
  const api = `/api/konto/kursus/${encodeURIComponent(slug)}/praktiline`;
  const [view, setView] = useState<PracticalAnswer>(data);
  const [loaded, setLoaded] = useState(data);
  if (loaded !== data) {
    // a quiet reload brought what is true now: it replaces the page's copy (React's way of resetting state from a new prop, in the render)
    setLoaded(data);
    setView(data);
  }
  const [items, setItems] = useState<Pending[]>([]);
  const [removing, setRemoving] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lead = useRef<HTMLParagraphElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const generalId = useId();
  const confirmId = useId();
  const hintId = useId();
  // The queue's working state, read and written by the handlers only (never in the render): the list as last set, the next local id,
  // whether the queue runs, the upload it may stop, the page still there, a send or a removal under way, and where the focus goes next.
  const work = useRef({ items: [] as Pending[], next: 1, running: false, alive: true, abort: null as AbortController | null, sending: false, removing: false, sent: false, refocus: false });

  useEffect(() => {
    const w = work.current;
    w.alive = true;
    return () => {
      // the page is left: the upload under way stops, and the thumbnails' local addresses are freed
      w.alive = false;
      w.abort?.abort();
      for (const p of w.items) forget(p.preview);
    };
  }, []);

  useEffect(() => {
    const w = work.current;
    if (w.sent && view.status === "review") {
      // sent just now: the sentence that says so takes the focus (a screen reader reads it)
      w.sent = false;
      lead.current?.focus();
    }
  }, [view.status]);

  useEffect(() => {
    const w = work.current;
    if (!confirming && w.refocus) {
      w.refocus = false;
      submitButton.current?.focus();
    }
  }, [confirming]);

  const update = (change: (list: Pending[]) => Pending[]) => {
    const w = work.current;
    w.items = change(w.items);
    setItems(w.items);
  };
  const patch = (id: number, change: Partial<Pending>) => update((list) => list.map((p) => (p.id === id ? { ...p, ...change } : p)));
  const drop = (id: number) =>
    update((list) => {
      forget(list.find((p) => p.id === id)?.preview ?? null);
      return list.filter((p) => p.id !== id);
    });
  const addStored = (stage: number, photo: PhotoView) =>
    setView((v) => ({ ...v, points: v.points.map((p) => (p.index === stage ? { ...p, photos: [...p.photos, photo] } : p)) }));

  /** One photo: made smaller (once), then sent with its progress; the answer decides what stays. */
  const send = async (item: Pending): Promise<void> => {
    const w = work.current;
    let prepared = item.prepared;
    if (!prepared) {
      patch(item.id, { state: "preparing" });
      try {
        prepared = await preparePhoto(item.file);
      } catch (e) {
        if (w.alive) patch(item.id, { state: e instanceof ShrinkError && e.problem === "size" ? "tooBig" : "decode" });
        return;
      }
      if (!w.alive) return;
      patch(item.id, { prepared, preview: previewOf(prepared.thumb) });
    }
    patch(item.id, { state: "uploading", progress: 0 });
    const form = new FormData();
    form.set("stage", String(item.stage));
    form.set("width", String(prepared.width));
    form.set("height", String(prepared.height));
    // Files with a neutral name, made here (not `set(name, blob, filename)`, which happy-dom's FormData ignores on a new key)
    form.set("full", new File([prepared.full], "foto.jpg", { type: "image/jpeg" }));
    form.set("thumb", new File([prepared.thumb], "pisi.jpg", { type: "image/jpeg" }));
    const abort = new AbortController();
    w.abort = abort;
    const answer = await uploadPhoto(`${api}/foto`, form, (fraction) => patch(item.id, { progress: fraction }), abort.signal);
    w.abort = null;
    if (!w.alive) return;
    const photo = answer.data.photo as PhotoView | undefined;
    if (answer.status === 200 && answer.data.ok === true && photo) {
      drop(item.id);
      addStored(item.stage, photo);
    } else if (answer.status === 400 || answer.status === 413) patch(item.id, { state: "refused" });
    else if (answer.status === 409 && answer.data.error === "full") patch(item.id, { state: "full" });
    else if (answer.status === 401 || answer.status === 404 || answer.status === 409) {
      // signed out, the access gone, or sent or closed meanwhile (another device): the page shows what is true now
      drop(item.id);
      void reload({ quiet: true });
    } else patch(item.id, { state: "failed" }); // no answer, a refusal for now (429), a server or storage failure: "Proovi uuesti"
  };

  /** The queue: one photo at a time for the whole page, in the order picked, so a weak connection is not split between uploads. */
  const run = async () => {
    const w = work.current;
    if (w.running) return;
    w.running = true;
    try {
      for (let next = w.items.find((p) => p.state === "waiting"); next && w.alive; next = w.items.find((p) => p.state === "waiting")) await send(next);
    } finally {
      w.running = false;
    }
  };

  const pickFiles = (stage: number, files: File[]) => {
    const w = work.current;
    update((list) => [...list, ...files.map((file) => ({ id: w.next++, stage, file, prepared: null, state: "waiting" as const, progress: 0, preview: null }))]);
    setError(null);
    void run();
  };

  const retry = (id: number) => {
    patch(id, { state: "waiting", progress: 0 });
    void run();
  };

  const removePhoto = async (photoId: number) => {
    const w = work.current;
    if (w.removing) return;
    w.removing = true;
    setRemoving(photoId);
    setError(null);
    const answer = await sendJson(`${api}/foto/${photoId}`, {}, { method: "DELETE" });
    w.removing = false;
    setRemoving(null);
    if (isDone(answer)) setView((v) => ({ ...v, points: v.points.map((p) => ({ ...p, photos: p.photos.filter((ph) => ph.id !== photoId) })) }));
    else if (answer.status === 401 || answer.status === 404 || answer.status === 409) void reload({ quiet: true });
    else setError(t.removeFailed);
  };

  const submit = async () => {
    const w = work.current;
    if (w.sending) return;
    if (w.items.length > 0) {
      // a photo was picked after the button was pressed: it goes first
      setConfirming(false);
      setError(t.waitUploads);
      return;
    }
    w.sending = true;
    setSending(true);
    setError(null);
    const answer = await sendJson(`${api}/saada`, {});
    w.sending = false;
    setSending(false);
    setConfirming(false);
    if (isDone(answer)) {
      w.sent = true;
      setView(answer.data as unknown as PracticalAnswer);
    } else if (answer.status === 409 && answer.data.error === "missing" && Array.isArray(answer.data.points)) {
      // the points are 0-based, as the stages; she reads them from 1
      setError(fill(t.missing, { points: (answer.data.points as number[]).map((i) => i + 1).join(", ") }));
      void reload({ quiet: true });
    } else if (answer.status === 401 || answer.status === 404 || answer.status === 409) void reload({ quiet: true });
    else setError(answer.status === 429 ? t.rate : t.failed);
  };

  const cancel = () => {
    if (work.current.sending) return;
    work.current.refocus = true;
    setConfirming(false);
  };

  const { status } = view;
  const canAct = status === "open" || status === "fix";
  const editing = canAct && !view.readOnly && !view.notesOnly; // a notes-only protocol (no points) has nothing to send
  /** A point that takes photos now: every point in the first round, the "Paranda" points in a fix round. */
  const takes = (p: PointView) => editing && (status === "open" || p.verdict === "fix");
  const needed = view.points.filter(takes);
  const moving = items.some((p) => !stopped(p.state));
  const ready = needed.length > 0 && needed.every((p) => p.photos.length > 0) && items.length === 0;
  const hint = ready ? "" : moving ? t.waitUploads : items.length > 0 ? t.clearFailed : status === "fix" ? t.needFixPhotos : t.needPhotos;
  const leadText = view.notesOnly
    ? null
    : view.readOnly && canAct
      ? t.readOnly
      : status === "open"
        ? t.leadOpen
        : status === "review"
          ? t.leadReview
          : status === "fix"
            ? t.leadFix
            : t.leadPassed;

  return (
    <div className={`${ui.wrap} ${page.page}`} data-practical-page="" data-practical-status={status}>
      <div className={styles.column}>
        <p className={styles.eyebrow}>{view.notesOnly ? t.protocolTitle : t.title}</p>
        <h1 className={page.title}>{pick(view.course.title, locale)}</h1>
        {leadText && (
          <p ref={lead} className={styles.lead} tabIndex={-1} data-practical-lead="">
            {leadText}
          </p>
        )}
        {status === "passed" && view.completedAt && (
          <p className={styles.completed} data-practical-completed="">
            <Icon name="check" size={18} />
            {fill(t.completed, { date: formatDate(new Date(view.completedAt), locale) })}
          </p>
        )}
        {view.points.length > 0 && (
          <ol className={styles.points}>
            {view.points.map((p) => (
              <PointCard
                key={p.index}
                point={p}
                status={status}
                takes={takes(p)}
                pending={items.filter((i) => i.stage === p.index)}
                removing={removing}
                t={t}
                onPick={pickFiles}
                onRetry={retry}
                onDrop={drop}
                onRemove={(id) => void removePhoto(id)}
              />
            ))}
          </ol>
        )}
        {view.generalNote.trim() !== "" && (
          <section className={styles.general} aria-labelledby={generalId} data-general-note="">
            <h2 id={generalId} className={styles.generalTitle}>
              {t.general}
            </h2>
            <p className={styles.note}>{view.generalNote}</p>
          </section>
        )}
        {view.sentAt && (status === "fix" || status === "passed" || view.notesOnly) && (
          <p className={styles.sent}>{fill(t.sent, { date: formatDate(new Date(view.sentAt), locale) })}</p>
        )}
        {editing && (
          <div className={styles.actions}>
            {confirming ? (
              <div className={styles.confirm} role="group" aria-labelledby={confirmId}>
                <p id={confirmId} className={styles.confirmText}>
                  {t.confirm}
                </p>
                <div className={styles.confirmButtons}>
                  <button
                    ref={focusOnMount}
                    type="button"
                    className={`${ui.btn} ${styles.send}`}
                    aria-disabled={sending || undefined}
                    onClick={() => void submit()}
                    data-practical-confirm=""
                  >
                    {sending ? t.sending : t.confirmYes}
                  </button>
                  <button type="button" className={`${ui.btnOutline} ${styles.send}`} onClick={cancel}>
                    {t.cancel}
                  </button>
                </div>
              </div>
            ) : (
              <button
                ref={submitButton}
                type="button"
                className={`${ui.btn} ${styles.send}`}
                aria-disabled={!ready || undefined}
                aria-describedby={hint ? hintId : undefined}
                onClick={() => {
                  if (!ready) return;
                  setError(null);
                  setConfirming(true);
                }}
                data-practical-submit=""
              >
                {status === "fix" ? t.resubmit : t.submit}
              </button>
            )}
            <p id={hintId} className={styles.hint}>
              {confirming ? "" : hint}
            </p>
            <p className={styles.error} role="alert" data-practical-error="">
              {error ?? ""}
            </p>
          </div>
        )}
        <p className={styles.back}>
          <Link className={ui.link} href={href(locale, `/konto/kursus/${slug}`)} data-practical-back="">
            {t.back}
          </Link>
        </p>
      </div>
    </div>
  );
}

type PointProps = {
  point: PointView;
  status: PracticalStatus;
  takes: boolean;
  pending: Pending[];
  removing: number | null;
  t: PracticalTexts;
  onPick(stage: number, files: File[]): void;
  onRetry(id: number): void;
  onDrop(id: number): void;
  onRemove(photoId: number): void;
};

/**
 * One of Maria's points: its number and title as she wrote it; her verdict — "Kinnitatud" always (an approved point stays approved),
 * "Paranda" only while the status is fix (after the resubmission it belongs to the round she is looking at again) — with her note; the
 * photos (stored, then on their way); "Lisa foto" while the point takes photos and has a free place; "Varasemad fotod" folded.
 */
function PointCard({ point, status, takes, pending, removing, t, onPick, onRetry, onDrop, onRemove }: PointProps) {
  const shown = point.verdict === "ok" || (point.verdict === "fix" && status === "fix");
  const count = point.photos.length + pending.length;
  return (
    <li className={styles.point} data-point={point.index}>
      <h2 className={styles.pointTitle}>
        <span className={styles.num}>{point.index + 1}</span>
        <span>{point.title}</span>
      </h2>
      {shown && point.verdict && (
        <p className={styles.verdict} data-point-verdict={point.verdict}>
          {point.verdict === "ok" && <Icon name="check" size={18} />}
          {point.verdict === "ok" ? t.approved : t.fix}
        </p>
      )}
      {shown && point.note.trim() !== "" && (
        <p className={styles.note} data-point-note="">
          {point.note}
        </p>
      )}
      {count > 0 && (
        <ul className={styles.photos}>
          {point.photos.map((photo, i) => (
            <PhotoSlot key={`s${photo.id}`} kind="photo" photo={photo} n={i + 1} onRemove={takes ? () => onRemove(photo.id) : null} busy={removing === photo.id} t={t} />
          ))}
          {pending.map((p) => (
            <PhotoSlot key={`p${p.id}`} kind="pending" state={p.state} progress={p.progress} preview={p.preview} onRetry={() => onRetry(p.id)} onRemove={() => onDrop(p.id)} t={t} />
          ))}
        </ul>
      )}
      {takes && count < PHOTOS_PER_POINT && <AddPhoto free={PHOTOS_PER_POINT - count} onPick={(files) => onPick(point.index, files)} t={t} />}
      {point.earlier.length > 0 && (
        <details className={styles.earlier} data-earlier="">
          <summary>{t.earlier}</summary>
          <ul className={styles.earlierList}>
            {point.earlier.map((photo) => (
              <li key={photo.id}>
                <a className={styles.earlierLink} href={photoUrl(photo.id)} target="_blank" rel="noopener noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind her session (a 302 to a signed address) */}
                  <img src={photoUrl(photo.id, true)} alt={fill(t.earlierPhoto, { round: photo.round })} width={56} height={56} loading="lazy" decoding="async" />
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
