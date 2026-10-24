"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import { formatDuration } from "@/domain/lessons";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { checkLessonVideo, createLessonVideo } from "@/server/actions/admin-lessons";
import type { AdminVideo, VideoCheckResult, VideoTicketResult } from "@/server/lesson-videos";
import { useGuardSource } from "./LeaveGuard";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import cd from "./ClientDrawer.module.css";
import styles from "./LessonsEditor.module.css";

// The lesson drawer's video field, for a video lesson (spec 3a sections 4 and 7). A picked file goes from the browser straight to
// Bunny Stream with tus (tus-js-client, loaded only here and only when a file is picked: no other page's bundle carries it),
// resumably and with retries; the server only signs the upload (createLessonVideo: the API key never comes here). Then Bunny encodes
// it: "Töötlemisel…", asked every 5 s (checkLessonVideo) until "Valmis · 12:34" or "Töötlemine ebaõnnestus": not while the tab is
// hidden (asked again as soon as it is shown), and every 30 s once it has gone on for 10 minutes. A status change refreshes the page,
// so the tag in the list behind the drawer follows.
//
// Admin UX pass piece 3a, Task 10 (README B2 lesson drawer; piece3-texts S3-P3-e; the Part 4 frame „B2 Lesson drawer“):
// - the progress line: the upload's „Laen üles… {n} %“, then „Töötlemisel {n}%“ with Bunny's figure (the lesson's `progress`, R-g; Task 11 reads it)
//   or „Töötlemisel…“ without one, over a bar (at the figure, or one that only moves), and „Võid lehelt lahkuda — töötlemine jätkub.“ while it
//   processes; the file's name beside it while this page knows it (it picked it);
// - when the file input goes (the pick starts the upload, or a read shows it processing) while it had the focus, the focus goes to that line instead
//   of being lost to the page;
// - a screen reader is told the upload's progress only at 25 % steps (0, 25, 50, 75, 100), and Bunny's figure the same way: the line she sees
//   follows every percent, the status region under it says the step;
// - a running upload is a leave-guard source (reason `upload`, „Üleslaadimine käib.“): ✕, Back or a menu link ask in the guard's notice, and the
//   guard's beforeunload covers closing the tab (the field has none of its own any more).

const t = adminEt.lessons.video;
/** How often the editor asks while Bunny encodes; after POLL_SLOW_AFTER_MS of it, every POLL_SLOW_MS (a long encode is no news every 5 s). */
const POLL_MS = 5000;
const POLL_SLOW_MS = 30_000;
const POLL_SLOW_AFTER_MS = 10 * 60_000;
/** tus-js-client tries again after these pauses (ms) when the network or Bunny fails; the upload goes on from where it stopped. */
const RETRY_DELAYS = [0, 3000, 5000, 10000, 20000, 60000];
/** What is announced of a percent: its step (README B2 „announce upload progress only at 25 % steps“). */
const STEP = 25;
const stepOf = (percent: number) => Math.floor(Math.min(100, Math.max(0, percent)) / STEP) * STEP;

type Phase = { kind: "idle" } | { kind: "starting" } | { kind: "uploading"; percent: number } | { kind: "error"; text: string };
const IDLE: Phase = { kind: "idle" };

const sameVideo = (a: AdminVideo, b: AdminVideo) => a.status === b.status && a.durationSec === b.durationSec && a.replacing === b.replacing;
const inProgress = (status: AdminVideo["status"]) => status === "uploading" || status === "processing";

type Props = {
  lessonId: number;
  /** Bunny is configured on the server (bunnyConfig() !== null): else only "Video seadistamata". */
  bunnyReady: boolean;
  /** The lesson's video as the page was rendered. */
  video: AdminVideo;
  /** Bunny's encode progress in percent while it processes (AdminLesson.videoProgress, R-g): null (or 0) when Bunny gave none. */
  progress: number | null;
};

export function LessonVideoField({ lessonId, bunnyReady, video: given, progress }: Props) {
  const uid = useId();
  const router = useRouter();
  const [video, setVideo] = useState(given);
  const [stored, setStored] = useState(given);
  // the page came back with the stored lesson (a refresh): the field follows it
  if (!sameVideo(stored, given)) {
    setStored(given);
    setVideo(given);
  }
  const [phase, setPhase] = useState<Phase>(IDLE);
  /** The server said Bunny is not set up after all (createLessonVideo or checkLessonVideo answered `setup`). */
  const [setupMissing, setSetupMissing] = useState(false);
  /** This page sent the whole file: Bunny saying "created" a moment longer still means it is on its way to processing. */
  const [sent, setSent] = useState(false);
  /** The picked file's name, while this page knows it (the Part 4 frame's „intro.mp4“ beside the line). */
  const [fileName, setFileName] = useState<string | null>(null);
  const notSetUp = !bunnyReady || setupMissing;
  const busy = phase.kind === "starting" || phase.kind === "uploading";
  const shown: AdminVideo["status"] = sent && video.status === "uploading" ? "processing" : video.status;

  const current = useRef(video);
  const routerRef = useRef(router);
  useEffect(() => {
    current.current = video;
    routerRef.current = router;
  });
  const alive = useRef(true);
  const upload = useRef<{ abort: () => unknown } | null>(null);
  const asking = useRef(false);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  /** The file input had the focus last (nothing else took it since): when it goes, the focus goes to the progress line. */
  const pickerHadFocus = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // the drawer closed (or the page moved on) during an upload: it stops; the lesson then reads "Üleslaadimine katkes"
      void upload.current?.abort();
      upload.current = null;
    };
  }, []);

  // the focus moving anywhere but the file input: the input no longer had it
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      if (e.target !== picker.current) pickerHadFocus.current = false;
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  // while it uploads, leaving asks (README §1.5): ✕, Back and a menu link in the guard's notice, closing the tab through its beforeunload
  useGuardSource({
    id: `${uid}-upload`,
    label: () => t.title,
    flush: async () => false,
    unconfirmed: () => (busy ? { reason: "upload" } : null),
    focus: () => statusLine.current?.focus(),
  });

  /** A status from the server: shown, and on a change of status the page is refreshed once (the list's tag). */
  const receive = useCallback((next: AdminVideo) => {
    const before = current.current;
    current.current = next;
    setVideo(next);
    if (next.status !== before.status) routerRef.current.refresh();
  }, []);

  /** One status read (Bunny through the server). A failed one is ignored: the next one tries again. One at a time. */
  const check = useCallback(async () => {
    if (asking.current) return;
    asking.current = true;
    let answer: VideoCheckResult | null = null;
    try {
      answer = await checkLessonVideo(lessonId);
    } catch {
      answer = null;
    }
    asking.current = false;
    if (!alive.current) return;
    if (answer?.ok) receive(answer.video);
    else if (answer?.error === "setup") setSetupMissing(true);
  }, [lessonId, receive]);

  // on opening: an upload in progress is asked about once (an interrupted one may have arrived at Bunny after all)
  useEffect(() => {
    if (bunnyReady && inProgress(current.current.status)) void check();
  }, [bunnyReady, check]);

  // while Bunny encodes: every 5 s (30 s after 10 minutes), until ready, failed or none, or until the field goes away. Nothing is
  // asked while the tab is hidden; when it is shown again the poll asks at once and goes on. One timer at a time, and none while a
  // read is on its way (a read can take up to 10 s, and the tab can be hidden and shown meanwhile).
  useEffect(() => {
    if (notSetUp || busy || shown !== "processing") return;
    const began = Date.now();
    const hidden = () => document.visibilityState === "hidden";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let stopped = false;
    const arm = () => {
      if (stopped || reading || timer !== undefined || hidden()) return;
      timer = setTimeout(() => void tick(), Date.now() - began >= POLL_SLOW_AFTER_MS ? POLL_SLOW_MS : POLL_MS);
    };
    const tick = async () => {
      timer = undefined;
      reading = true;
      await check();
      reading = false;
      arm();
    };
    const onVisibility = () => {
      if (hidden()) {
        clearTimeout(timer);
        timer = undefined;
      } else if (timer === undefined && !reading && !stopped) void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    arm();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [notSetUp, busy, shown, check]);

  const start = async (file: File) => {
    if (!file.type.startsWith("video/") || file.size === 0) return setPhase({ kind: "error", text: t.type });
    setPhase({ kind: "starting" });
    setSent(false);
    setFileName(file.name);
    let answer: VideoTicketResult | null = null;
    try {
      answer = await createLessonVideo(lessonId);
    } catch {
      answer = null;
    }
    if (!alive.current) return;
    if (!answer?.ok) {
      if (answer?.error === "setup") {
        setSetupMissing(true);
        return setPhase(IDLE);
      }
      return setPhase({ kind: "error", text: answer?.error === "notFound" ? adminEt.lessons.errors.notFound : t.error });
    }
    const ticket = answer.ticket;
    // the lesson is "uploading" on the server now; a ready video stays as the one students watch
    const before = current.current;
    const uploading: AdminVideo = { status: "uploading", durationSec: before.durationSec, replacing: before.status === "ready" || before.replacing };
    current.current = uploading;
    setVideo(uploading);
    let Upload: typeof import("tus-js-client").Upload;
    try {
      ({ Upload } = await import("tus-js-client"));
    } catch {
      if (alive.current) setPhase({ kind: "error", text: t.error });
      return;
    }
    if (!alive.current) return;
    const tus = new Upload(file, {
      endpoint: ticket.endpoint,
      retryDelays: RETRY_DELAYS,
      // a new video each time: nothing to resume from another visit
      storeFingerprintForResuming: false,
      headers: { AuthorizationSignature: ticket.signature, AuthorizationExpire: String(ticket.expires), VideoId: ticket.videoId, LibraryId: ticket.libraryId },
      // Bunny wants both
      metadata: { filetype: file.type, title: ticket.title },
      onProgress: (bytesSent, total) => {
        if (alive.current) setPhase({ kind: "uploading", percent: total > 0 ? Math.min(100, Math.floor((bytesSent / total) * 100)) : 0 });
      },
      onError: () => {
        upload.current = null;
        if (alive.current) setPhase({ kind: "error", text: t.error });
      },
      onSuccess: () => {
        upload.current = null;
        if (!alive.current) return;
        setPhase(IDLE);
        setSent(true);
        const processing: AdminVideo = { ...current.current, status: "processing" };
        current.current = processing;
        setVideo(processing);
        void check();
      },
    });
    upload.current = tus;
    tus.start();
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // reset at once, so the same file can be picked again
    e.target.value = "";
    if (!file || busy) return;
    void start(file);
  };

  const pickLabel = shown === "none" ? t.choose : shown === "uploading" ? t.retry : shown === "ready" ? t.replace : shown === "failed" ? t.reupload : null;
  const showPicker = !notSetUp && !busy && pickLabel !== null;

  // the file input went (the pick started the upload; a read shows it processing) while it had the focus: the focus goes to the progress line
  // (README B2), not to the page behind the drawer
  useLayoutEffect(() => {
    if (showPicker || !pickerHadFocus.current) return;
    pickerHadFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) statusLine.current?.focus();
  }, [showPicker]);

  if (notSetUp)
    return (
      <section className={cd.section} aria-labelledby={`${uid}-h`} data-lesson-video="setup">
        <h3 id={`${uid}-h`} className={styles.drawerLabel}>
          {t.title}
        </h3>
        <p role="status" className={ui.notice}>
          {t.notSetUp}
        </p>
        <p className={`${ui.muted} ${ui.small}`}>{t.notSetUpHint}</p>
      </section>
    );

  const percent = phase.kind === "uploading" ? phase.percent : 0;
  /** Bunny's figure while it processes (none, or 0: „Töötlemisel…“ and a bar that only moves). */
  const figure = shown === "processing" && !busy && progress !== null && progress > 0 ? Math.min(100, Math.round(progress)) : null;
  const statusText = busy
    ? fill(t.uploading, { percent })
    : shown === "processing"
      ? figure !== null
        ? fill(adminEt.lessons.videoProgress, { n: figure })
        : t.processing
      : shown === "ready"
        ? fill(t.ready, { duration: formatDuration(video.durationSec ?? 0) })
        : shown === "uploading"
          ? t.interrupted
          : shown === "failed"
            ? t.failed
            : "";
  // what a screen reader is told: a percent only at its 25 % step (Bunny's figure from its first step), every other state as it reads
  const spoken = busy
    ? fill(t.uploading, { percent: stepOf(percent) })
    : figure !== null && stepOf(figure) > 0
      ? fill(adminEt.lessons.videoProgress, { n: stepOf(figure) })
      : statusText;
  // "Üleslaadimine katkes" (an upload that stopped, with its retry button) is an error state like "Töötlemine ebaõnnestus"
  const statusTone = shown === "ready" && !busy ? ui.success : (shown === "failed" || shown === "uploading") && !busy ? ui.error : ui.hint;
  /** The upload, or Bunny encoding: the progress box with its bar (the Part 4 frame). */
  const progressing = busy || shown === "processing";
  // nothing for students to watch (no old video playing meanwhile): they see "Video lisandub peagi" and the next lesson stays locked
  const waiting = shown !== "ready" && !video.replacing;
  const hints = [
    (busy || shown === "none") && { id: `${uid}-hint`, text: t.hint },
    (shown === "ready" || video.replacing) && { id: `${uid}-replace`, text: t.replaceHint },
  ].filter((h): h is { id: string; text: string } => Boolean(h));

  return (
    <section className={cd.section} aria-labelledby={`${uid}-h`} data-lesson-video={shown}>
      <h3 id={`${uid}-h`} className={styles.drawerLabel}>
        {t.title}
      </h3>
      <div className={showPicker ? ed.upload : styles.videoBody} aria-busy={busy || undefined}>
        <div className={progressing ? styles.progressBox : styles.statusBox} data-video-progress={progressing ? "" : undefined}>
          <div className={styles.progressHead}>
            {progressing && fileName && (
              <b className={styles.progressName} data-video-file="">
                {fileName}
              </b>
            )}
            <p id={`${uid}-status`} ref={statusLine} tabIndex={-1} className={`${statusTone} ${styles.statusLine}`} data-video-status="">
              {statusText}
            </p>
          </div>
          {progressing && (
            // the line's picture (its words say the percent): not a second thing for a screen reader to follow
            <progress className={styles.progress} max={100} value={busy ? percent : (figure ?? undefined)} aria-hidden="true" />
          )}
          {shown === "processing" && !busy && (
            <p className={`${ui.muted} ${ed.uploadHint}`} data-video-leave="">
              {t.leave}
            </p>
          )}
        </div>
        <p role="status" className={ui.sr} data-video-announce="">
          {spoken}
        </p>
        {showPicker && (
          <>
            <input
              ref={picker}
              id={`${uid}-file`}
              type="file"
              accept="video/*"
              aria-describedby={hints.map((h) => h.id).join(" ") || undefined}
              onFocus={() => void (pickerHadFocus.current = true)}
              onChange={onPick}
            />
            <label htmlFor={`${uid}-file`} className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} data-video-pick="">
              {pickLabel}
            </label>
          </>
        )}
        {phase.kind === "error" && (
          <p role="alert" className={ui.error}>
            {phase.text}
          </p>
        )}
        {hints.map((h) => (
          <p key={h.id} id={h.id} className={`${ui.muted} ${ed.uploadHint}`}>
            {h.text}
          </p>
        ))}
        {waiting && (
          <p className={`${ui.muted} ${ed.uploadHint}`} data-video-waiting="">
            {t.waitingHint}
          </p>
        )}
      </div>
    </section>
  );
}
