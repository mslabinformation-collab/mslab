"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { HOME_REVIEWS_MAX, starsOf, type ReviewStatus } from "@/domain/review";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate } from "@/i18n/format";
import { decideReviewAction, removeReviewAction, setFeaturedAction, undoDecisionAction, undoRemoveReviewAction } from "@/server/actions/admin-reviews";
import { focusFell } from "./focus-fell";
import { ListEmpty } from "./ListStates";
import { courseLabel, REVIEWS_HREF, reviewCardId, spokenScore, type ReviewRowView } from "./review-view";
import { Switch } from "./Switch";
import { useUndo } from "./UndoBar";
import ui from "./ui.module.css";
import styles from "./ReviewsPanel.module.css";

// „Arvustused“ (student reviews, Task 4; spec D2, D4, §4, §5; admin UX pass piece 4c, Task 2: README C6, the Part 4 frame „C6 Tagasiside“, S4-36 …
// S4-38, rulings R-a, R-b, R-d): the reviews of Tagasiside's second view as cards in a 2-column grid (one on a phone), a waiting one first and with an
// ink border. A card: the stars of the student's „Hinne“ (domain/review.ts starsOf; none on a review Maria added; aria-hidden, a visually hidden
// „Hinne 9/10“ says the score instead, Dim 29.10), the status pill (and „Lisatud
// käsitsi“, and „Avalehel“ on a hidden review that keeps it), the words in quotes, „{nimi} · {koolitus} · {dd.mm.yyyy}“, the language and what Maria
// judges a student by (the registration's status and whether a protocol was sent, or the day an e-course was completed) or her note; then the
// buttons by status — waiting „Avalda“ (ink) and „Peida“, published „Peida“ with the „Avalehel“ switch, hidden „Avalda“ — and on a review she added
// „Muuda“ (its autosave drawer, ?id=<id>) and „Kustuta“. A student's words have no edit or delete control at all.
// - „Avalda“ and „Peida“ act at once, and the UndoBar says „Arvustus avaldatud.“ / „Arvustus peidetud.“ with „Võta tagasi“, which sends back what
//   the decision answered (undoDecisionAction, R-a): refused because the review moved meanwhile, the bar says so in its words. „Avalehel“ shows no bar.
// - „Kustuta“ asks nothing: the card goes at once (the review is only marked, R-b) and the bar says „Arvustus kustutatud.“; „Võta tagasi“ brings it back.
// - The page is refreshed by the actions, so the cards show the new state; a review that is not there any more is answered in words (the status
//   line) and its card goes.
// - The focus (D5) stays on the card acted on (`id="arvustus-<id>"`, the address's anchor too, R-d), or, when the refresh takes it out of a
//   status-filtered list or „Kustuta“ took it, goes to the next card (else the one before; with none left, the empty list's words, which are drawn
//   and can hold it: Task 2 review I-2). After „Võta tagasi“ it goes back to the card when it fell with the bar, never from where she has moved it since.
// A review of a draft course says „(mustand)“ after the course; a quiet hint says that the home page shows the newest six. This file runs on old iPads:
// no regular expression with a lookbehind, here or in anything it imports (tests/unit/old-safari.test.ts).

type Line = { tone: "idle" | "busy" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const STATUS_TONE: Record<ReviewStatus, string> = { pending: ui.warn, published: ui.ok, hidden: ui.bad };

type Outcome = { ok: true } | { ok: false; error: string; text: string };

/** How long after an action a refresh of the cards may still take the focus (ms): a refresh long after is some other change of the page. */
const FOCUS_WAIT_MS = 5000;

/**
 * Where the focus goes once the cards show an action's result: the card `id`, or when it is gone, the `neighbours` (the next ones first, then the ones
 * before), else any card, else the empty list's words. `ifFell` (an undo pressed in the bar): it waits for the card, which the refresh brings back,
 * and takes the focus only when it has nowhere to be — never from where she has moved it since.
 */
type FocusWant = { id: number; neighbours: number[]; until: number; ifFell: boolean };
const focusWant = (id: number, o: { neighbours?: number[]; ifFell?: boolean } = {}): FocusWant => ({
  id,
  neighbours: o.neighbours ?? [],
  until: Date.now() + FOCUS_WAIT_MS,
  ifFell: o.ifFell ?? false,
});

/** The proof of a student's review, in words: the registration's status and the protocol line, or the day the e-course was completed. */
function proofText(proof: NonNullable<ReviewRowView["proof"]>): string {
  const t = adminEt.reviews;
  if (proof.kind === "completed") return fill(adminEt.feedback.completed, { date: formatDate(new Date(proof.completedAt), "et") });
  const status = (adminEt.registrations.status as Record<string, string>)[proof.status] ?? proof.status;
  return fill(t.proof.registration, { status, protocol: proof.protocolSent ? t.proof.protocolSent : t.proof.protocolNotSent });
}

export function ReviewsPanel({
  rows,
  filtered,
  listHref,
}: {
  rows: ReviewRowView[];
  /** The list is narrowed by a status: an empty list then says so in the list frame's words, with the way back to every review. */
  filtered: boolean;
  /** The view's own address (its status filter kept): „Muuda“ opens its drawer on it (`&id=<id>`). */
  listHref: string;
}) {
  const t = adminEt.reviews;
  const undo = useUndo();
  const [line, setLine] = useState<Line>(IDLE);
  const [pending, start] = useTransition();
  /** The cards taken away before the page's refresh: a review „Kustuta“ removed, or one that is not there any more. */
  const [gone, setGone] = useState<ReadonlySet<number>>(() => new Set());
  /** „Avalehel“ pressed, shown as asked until the refreshed cards come (`over`: the cards it was pressed on). */
  const [featuring, setFeaturing] = useState<{ id: number; on: boolean; over: ReviewRowView[] } | null>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  /** The empty list's words: where the focus goes when the last card has gone (the status line is not drawn while it is empty). */
  const emptyState = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<FocusWant | null>(null);

  // a refusal in words takes the focus: the card it was about may be gone
  useEffect(() => {
    if (line.tone === "error") statusLine.current?.focus();
  }, [line]);

  const visible = rows.filter((r) => !gone.has(r.id));

  /**
   * Puts the focus where an action left it (FocusWant). `refreshed`: the cards have just been replaced (or taken away), so a decision is settled; else it
   * is settled only if its card is gone. An undo's want waits for its card (it comes back with the refresh) until its time is up.
   */
  const placeFocus = useCallback((refreshed: boolean) => {
    const want = focusAfter.current;
    if (!want) return;
    if (Date.now() > want.until) {
      focusAfter.current = null;
      return;
    }
    const card = (id: number) => document.getElementById(reviewCardId(id));
    const own = card(want.id);
    if (want.ifFell) {
      if (!own) return;
      focusAfter.current = null;
      if (focusFell()) own.focus();
      return;
    }
    if (refreshed || !own) focusAfter.current = null;
    const left = want.neighbours.map(card).find((el) => el !== null) ?? document.querySelector<HTMLElement>("[data-review-list] [data-review]");
    (own ?? left ?? emptyState.current)?.focus();
  }, []);
  useEffect(() => placeFocus(true), [rows, gone, placeFocus]);

  /** The cards around `id` on the screen: the next ones first, then the ones before (where the focus goes if the card goes). */
  const neighboursOf = (id: number) => {
    const at = visible.findIndex((r) => r.id === id);
    return [...visible.slice(at + 1), ...visible.slice(0, Math.max(at, 0)).reverse()].map((r) => r.id);
  };
  const wantFocus = (id: number, o: { neighbours?: number[]; ifFell?: boolean } = {}) => {
    focusAfter.current = focusWant(id, o);
  };

  const run = <R extends Outcome>(id: number, work: () => Promise<R>, after: (r: Extract<R, { ok: true }>) => void) => {
    if (pending) return;
    setLine({ tone: "busy", text: t.working });
    start(async () => {
      // (a lost connection rejects the call: words, not an error page)
      const r = await work().catch((): Outcome => ({ ok: false, error: "server", text: t.errors.server }));
      if (r.ok) {
        setLine(IDLE);
        after(r as Extract<R, { ok: true }>);
        return;
      }
      setFeaturing(null);
      setLine({ tone: "error", text: r.text });
      if (r.error === "gone" || r.error === "manualGone") setGone((g) => new Set(g).add(id));
    });
  };

  /** „Võta tagasi“'s answer as the bar takes it: done, or the refusal's own words; done, the card takes the focus back if it fell with the bar. */
  const undone = (id: number, answer: Outcome): true | string => {
    if (!answer.ok) return answer.text;
    wantFocus(id, { ifFell: true });
    placeFocus(false);
    return true;
  };

  const decide = (id: number, decision: "publish" | "hide") => {
    const neighbours = neighboursOf(id);
    run(
      id,
      () => decideReviewAction({ id, decision }),
      (r) => {
        wantFocus(id, { neighbours });
        placeFocus(false);
        undo.show({
          text: decision === "publish" ? t.bar.published : t.bar.hidden,
          undo: async () => undone(id, await undoDecisionAction({ id, expected: r.expected })),
        });
      },
    );
  };
  const feature = (r: ReviewRowView, on: boolean) => {
    if (pending) return;
    setFeaturing({ id: r.id, on, over: rows });
    run(r.id, () => setFeaturedAction({ id: r.id, featured: on }), () => {});
  };
  const remove = (id: number) => {
    const neighbours = neighboursOf(id);
    run(
      id,
      () => removeReviewAction({ id }),
      () => {
        wantFocus(id, { neighbours });
        setGone((g) => new Set(g).add(id));
        undo.show({
          text: t.bar.removed,
          undo: async () => {
            const answer = await undoRemoveReviewAction({ id });
            // back: the card is the refreshed page's again
            if (answer.ok) setGone((g) => new Set([...g].filter((x) => x !== id)));
            return undone(id, answer);
          },
        });
      },
    );
  };

  // the hint belongs near the „Avalehel“ switches: while a published review has one, or a hidden one still carries the setting
  const homeHint = visible.some((r) => r.status === "published" || (r.status === "hidden" && r.featured));
  const featuredOf = (r: ReviewRowView) => (featuring && featuring.id === r.id && featuring.over === rows ? featuring.on : r.featured);

  return (
    <section className={styles.panel} aria-label={t.title} data-reviews-panel="">
      <p ref={statusLine} tabIndex={-1} role="status" className={`${styles.status} ${line.tone === "error" ? ui.error : ui.hint}`} data-reviews-status="">
        {line.text}
      </p>

      {homeHint && (
        <p id="reviews-home-hint" className={ui.hint} data-review-home-hint="">
          {fill(t.homeHint, { n: HOME_REVIEWS_MAX })}
        </p>
      )}

      {visible.length === 0 ? (
        <div ref={emptyState} tabIndex={-1} className={styles.empty} data-reviews-empty="">
          {filtered ? <ListEmpty things={t.things} filtered clearHref={REVIEWS_HREF} /> : <p className={ui.empty}>{t.empty}</p>}
        </div>
      ) : (
        <ul className={styles.grid} data-review-list="">
          {visible.map((r) => {
            const label = (action: string) => fill(t.label, { action, name: r.name });
            const manual = r.kind === "manual";
            const stars = starsOf(r.score);
            const cardId = reviewCardId(r.id);
            return (
              <li
                key={r.id}
                id={cardId}
                tabIndex={-1}
                className={styles.card}
                data-review={r.id}
                data-review-kind={r.kind}
                data-review-status={r.status}
                data-review-featured={r.featured || undefined}
              >
                <div className={styles.top}>
                  {stars > 0 && r.score !== null && (
                    <>
                      <span className={styles.stars} aria-hidden="true" data-review-stars={stars}>
                        {"★".repeat(stars)}
                      </span>
                      <span className={styles.srOnly} data-review-score="">
                        {spokenScore(r.score)}
                      </span>
                    </>
                  )}
                  <span className={styles.tags}>
                    <span className={`${ui.tag} ${styles.state} ${STATUS_TONE[r.status]}`} data-review-tag="">
                      {t.status[r.status]}
                    </span>
                    {manual && (
                      <span className={`${ui.tag} ${styles.state}`} data-review-manual="">
                        {t.manual}
                      </span>
                    )}
                    {r.status === "hidden" && r.featured && (
                      <span className={`${ui.tag} ${styles.state}`} title={t.featuredKept} data-review-featured-tag="">
                        {t.featured}
                      </span>
                    )}
                  </span>
                </div>
                <p className={styles.quote} data-review-text="">
                  {r.text}
                </p>
                <p id={`${cardId}-who`} className={styles.who} data-review-who="">
                  {[r.name, courseLabel(r.course.title, r.course.published), formatDate(new Date(r.writtenAt), "et")].join(" · ")}
                </p>
                <p className={styles.meta} data-review-facts="">
                  <span>{fill(t.language, { locale: adminEt.common.locale[r.locale] })}</span>
                  {r.proof && <span data-review-proof="">{proofText(r.proof)}</span>}
                  {manual && r.note && <span data-review-note="">{fill(t.source, { note: r.note })}</span>}
                </p>
                <div className={styles.foot}>
                  <div className={styles.buttons}>
                    {r.status !== "published" && (
                      <button type="button" className={`${ui.btn} ${ui.smallBtn}`} aria-label={label(t.publish)} aria-disabled={pending || undefined} onClick={() => decide(r.id, "publish")} data-review-publish="">
                        {t.publish}
                      </button>
                    )}
                    {r.status !== "hidden" && (
                      <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} aria-label={label(t.hide)} aria-disabled={pending || undefined} onClick={() => decide(r.id, "hide")} data-review-hide="">
                        {t.hide}
                      </button>
                    )}
                    {manual && (
                      <Link
                        id={`${cardId}-muuda`}
                        className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
                        href={`${listHref}&id=${r.id}`}
                        scroll={false}
                        aria-label={label(t.edit)}
                        data-review-edit=""
                      >
                        {t.edit}
                      </Link>
                    )}
                    {manual && (
                      <button type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} aria-label={label(t.delete)} aria-disabled={pending || undefined} onClick={() => remove(r.id)} data-review-delete="">
                        {t.delete}
                      </button>
                    )}
                  </div>
                  {r.status === "published" && (
                    <div className={styles.featured}>
                      <Switch
                        label={t.featured}
                        ariaLabel={label(t.featured)}
                        checked={featuredOf(r)}
                        onChange={(on) => feature(r, on)}
                        describedBy={`${cardId}-who${homeHint ? " reviews-home-hint" : ""}`}
                        data-review-featured-toggle=""
                      />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
