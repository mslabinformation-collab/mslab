"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import type { AccessState } from "@/domain/client-access";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { revokeCourseAccess, unlockNextLesson } from "@/server/actions/admin-clients";
import type { ClientResult } from "@/server/admin-clients";
import { ConfirmPanel } from "./ConfirmPanel";
import { ExtendAccess } from "./ExtendAccess";
import { MoreMenu, type MoreMenuItem } from "./MoreMenu";
import ui from "./ui.module.css";
import styles from "./AccessActions.module.css";

/**
 * The actions of one e-course card in a student's drawer (README A5, the Part 2 prototype's card): „Hinda“ (ink) while work waits for Maria,
 * „Pikenda ▾“ (ExtendAccess, B12) and „Veel ▾“ with the rarer ones —
 *
 * - „Ava järgmine õppetund“ (an open access with a lesson still locked for her) and „Lõpeta ligipääs“ (an open one; danger) ask with a ConfirmPanel under the
 *   buttons (P-13: the question, the consequence, „Jah, …“, „Katkesta“). „Katkesta“, Esc and a question that has become pointless (the page comes back
 *   with nothing locked) close it, and the focus goes back to „Veel ▾“;
 * - „Lisa protokoll“ / „Ava protokoll“ (her practical work's protocol: Maria may write it before the student sends), „Testi katsed“ (once she has an attempt)
 *   and „Vaata tema vaadet“ (her page of the course, read-only; an open access with lessons) are links.
 *
 * What the page cannot say for itself stays here: the line that says which lesson was opened ("Õppetund „…“ on avatud.", a status region from the start; it
 * takes the focus when it fills and is kept when the page comes back with nothing left to open), and the focus that goes to the card's state line once
 * the access was ended here (`stateId`; the phone card shows the state in its kicker, `${stateId}-phone`). An access an admin ended has no actions; this
 * stays mounted for it all the same, so that the page coming back with the end can still move the focus.
 */
export function AccessActions({
  clientId,
  accessId,
  courseId,
  course,
  state,
  expiresAt,
  extendMin,
  extendMax,
  assessHref,
  protocol,
  attemptsHref,
  viewHref,
  lesson,
  stateId,
}: {
  clientId: number;
  accessId: number;
  courseId: number;
  /** The course's title as the card shows it: it names the menus' triggers and the question of „Lõpeta ligipääs“. */
  course: string;
  state: AccessState;
  /** The end the card shows (ISO), and the bounds of „Pikenda ▾“'s day field (yyyy-mm-dd). */
  expiresAt: string;
  extendMin: string;
  extendMax: string;
  /** Where the work waiting for Maria is assessed („Hinda“), or null when none waits. */
  assessHref: string | null;
  protocol: { href: string; label: string };
  attemptsHref: string | null;
  viewHref: string | null;
  /** The first lesson she cannot open yet, or null when none is locked. */
  lesson: { id: number; title: string } | null;
  stateId: string;
}) {
  const t = adminEt.clients;
  const live = state !== "revoked";
  const [asking, setAsking] = useState<"unlock" | "revoke" | null>(null);
  /** A new object each time a question is closed by „Katkesta“ or Esc: the focus goes back to „Veel ▾“ (a flag could not say "again"). */
  const [back, setBack] = useState<object | null>(null);
  const [unlocked, unlockAction, unlocking] = useActionState<ClientResult | null, FormData>(unlockNextLesson, null);
  const [ended, revokeAction, revoking] = useActionState<ClientResult | null, FormData>(revokeCourseAccess, null);
  // the title of the lesson sent, and (once the answer is ok) the one that was opened: the page's `lesson` moves on at once
  const [sent, setSent] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [seenUnlock, setSeenUnlock] = useState(unlocked);
  const [seenState, setSeenState] = useState(state);
  const [focusState, setFocusState] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const doneLine = useRef<HTMLParagraphElement>(null);

  // A new answer to the unlock: ok closes the question and says what was opened, anything else says so in the question (state adjusted while rendering,
  // as RegistrationForms follows its saved values).
  if (unlocked !== seenUnlock) {
    setSeenUnlock(unlocked);
    setFailed(unlocked !== null && !unlocked.ok);
    if (unlocked?.ok) {
      setOpened(sent);
      setAsking(null);
    }
  }
  // Ended here (the page came back with the access ended): the question is gone with the actions, and the focus goes to the line that now says so.
  if (seenState !== state) {
    setSeenState(state);
    setAsking(null);
    setFocusState(state === "revoked" && ended?.ok === true);
  }
  // The page came back with no locked lesson (opened elsewhere, or hidden): a question left open ends with it, and must not come back asking by itself
  // when a lesson is locked again.
  if (!lesson && asking === "unlock") setAsking(null);

  useEffect(() => {
    if (back) box.current?.querySelector<HTMLElement>('[data-more="veel"] [data-more-menu] > button')?.focus();
  }, [back]);

  // the question is gone and the line that says what was opened is the place to be
  useEffect(() => {
    if (opened !== null) doneLine.current?.focus();
  }, [opened]);

  useEffect(() => {
    if (!focusState) return;
    // the pill on a wide card, the kicker on a phone's (the other is not drawn)
    const target = [stateId, `${stateId}-phone`].map((id) => document.getElementById(id)).find((el) => el && el.getClientRects().length > 0);
    target?.focus();
  }, [focusState, stateId]);

  if (!live) return null;

  const ask = (what: "unlock" | "revoke") => {
    setOpened(null);
    setFailed(false);
    setAsking(what);
  };
  const close = () => {
    setAsking(null);
    setBack({});
  };

  const yesUnlock = () => {
    if (unlocking || !lesson) return;
    setSent(lesson.title);
    const fd = new FormData();
    fd.set("clientId", String(clientId));
    fd.set("courseId", String(courseId));
    fd.set("lessonId", String(lesson.id));
    startTransition(() => unlockAction(fd));
  };
  const yesRevoke = () => {
    if (revoking) return;
    const fd = new FormData();
    fd.set("clientId", String(clientId));
    fd.set("accessId", String(accessId));
    startTransition(() => revokeAction(fd));
  };

  // README A5, in its order: Ava järgmine õppetund, Testi katsed, Vaata tema vaadet, Lõpeta ligipääs — and the protocol, which only an e-course access has,
  // beside Testi katsed
  const more: MoreMenuItem[] = [];
  if (state === "active" && lesson) more.push({ label: t.unlock.button, onSelect: () => ask("unlock") });
  more.push({ label: protocol.label, href: protocol.href });
  if (attemptsHref) more.push({ label: t.attempts, href: attemptsHref });
  // (her page of the course answers "not found" without an open access, as her own does)
  if (state === "active" && viewHref) more.push({ label: t.drawer.viewAs, href: viewHref });
  if (state === "active") more.push({ label: t.revoke.button, tone: "danger", onSelect: () => ask("revoke") });

  return (
    <div ref={box} className={styles.actions} data-access-actions="">
      <div className={styles.buttons}>
        {assessHref && (
          <Link className={`${ui.btn} ${ui.smallBtn}`} href={assessHref} data-access-assess="">
            {adminEt.assessment.assess}
          </Link>
        )}
        <ExtendAccess accessId={accessId} course={course} expiresAt={expiresAt} expired={state === "expired"} min={extendMin} max={extendMax} />
        <div data-more="veel">
          <MoreMenu items={more} buttonLabel={fill(t.drawer.moreLabel, { course })} />
        </div>
      </div>

      {asking === "unlock" && lesson && (
        <div className={styles.panel} data-unlock-panel="">
          <ConfirmPanel
            question={fill(t.unlock.question, { lesson: lesson.title })}
            lines={[t.unlock.line]}
            yesLabel={unlocking ? adminEt.common.saving : t.unlock.yes}
            tone="send"
            busy={unlocking}
            onYes={yesUnlock}
            onCancel={close}
          />
          {failed && (
            <p role="alert" className={ui.error}>
              {adminEt.common.saveError}
            </p>
          )}
        </div>
      )}

      {asking === "revoke" && (
        <div className={styles.panel} data-revoke-panel="">
          <ConfirmPanel
            question={fill(t.revoke.question, { course })}
            lines={[t.revoke.line]}
            yesLabel={revoking ? adminEt.common.saving : t.revoke.yes}
            tone="danger"
            busy={revoking}
            onYes={yesRevoke}
            onCancel={close}
          />
          {ended && !ended.ok && (
            <p role="alert" className={ui.error}>
              {adminEt.common.saveError}
            </p>
          )}
        </div>
      )}

      <p ref={doneLine} tabIndex={-1} role="status" className={`${ui.success} ${styles.done}`} data-unlock-done="">
        {opened === null ? "" : fill(t.unlock.done, { lesson: opened })}
      </p>
    </div>
  );
}
