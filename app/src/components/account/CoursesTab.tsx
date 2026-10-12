"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import filters from "@/components/site/CatalogueFilters.module.css";
import { Icon } from "@/components/site/Icon";
import ui from "@/components/site/ui.module.css";
import { cardKey, filterCards, firstName, isPastCard, showFilters, type CardFilter, type ContactCard, type EcourseCard } from "@/domain/account-cards";
import { fill } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";
import { AccountCourseCard } from "./AccountCourseCard";
import { AccountLoader, type Reload } from "./AccountLoader";
import { CardSkeleton, GreetingSkeleton } from "./CardSkeleton";
import { ChangeRequestDialog, type ChangeRequestEnd } from "./ChangeRequestDialog";
import { FeedbackCard } from "./FeedbackCard";
import { ResumeCard, type ResumeProgress } from "./ResumeCard";
import { isSent, pruneChangeRequests, rememberChangeRequest, sentChangeRequests, type SentRequest } from "./sent-requests";
import type { CoursesTexts } from "./texts";
import styles from "./CoursesTab.module.css";

const FILTERS: CardFilter[] = ["all", "upcoming", "past"];

/** How long after a refused request the reloaded cards may still take the focus. */
const FOCUS_WAIT_MS = 10_000;

type Props = {
  locale: Locale;
  t: CoursesTexts;
  /** The time the cards are judged at (ISO), for a server render that must match its hydration; default: now. */
  now?: string;
} & (
  | {
      /** The dashboard as the server loaded it (the admin's read-only "view as client"). */
      data: Dashboard;
      /** Every button and link that would act is aria-disabled and does nothing; nothing is fetched or sent. */
      readOnly?: boolean;
    }
  | {
      /** Without data the page loads GET /api/konto itself; read-only needs data. */
      data?: undefined;
      readOnly?: false;
    }
);

/**
 * "Minu koolitused" (/konto): the greeting, the dark 'Pooleli' card of the e-course she was busy with last (phase 2c), the filter
 * chips, the course cards (each with its one sentence and at most one button), the empty state. With `data` it shows that (the
 * admin's view, server-rendered); otherwise AccountLoader loads the signed-in client's dashboard in the browser — the page itself is
 * a static shell, the same for every visitor.
 */
export function CoursesTab(props: Props) {
  const { locale, t, now } = props;
  if (props.data) return <CoursesView data={props.data} locale={locale} t={t} readOnly={props.readOnly ?? false} at={now} />;
  return (
    <AccountLoader<Dashboard>
      path="/api/konto"
      locale={locale}
      t={{ ...t.loader, loading: t.loading }}
      skeleton={<CoursesSkeleton />}
      render={(data, reload) => <CoursesView data={data} locale={locale} t={t} readOnly={false} at={now} reload={reload} />}
    />
  );
}

/** While the dashboard loads: the greeting's stand-in and two skeleton cards. */
function CoursesSkeleton() {
  return (
    <div className={`${ui.wrap} ${styles.page}`}>
      <GreetingSkeleton />
      <div className={styles.list}>
        <CardSkeleton />
        <CardSkeleton />
      </div>
    </div>
  );
}

/** The card and progress of the e-course the "Pooleli" card is for (the dashboard's `resume`), when it has a next lesson. */
function resumeOf(data: Dashboard): { card: EcourseCard; progress: ResumeProgress } | null {
  const card = data.resume === null ? undefined : data.cards.find((c): c is EcourseCard => c.kind === "ecourse" && c.course.slug === data.resume);
  const progress = card?.progress;
  return card && progress?.next ? { card, progress: { ...progress, next: progress.next } } : null;
}

function CoursesView({ data, locale, t, readOnly, at, reload }: { data: Dashboard; locale: Locale; t: CoursesTexts; readOnly: boolean; at?: string; reload?: Reload }) {
  // judged once, so the cards do not change under the student's hands
  const [now] = useState(() => (at ? new Date(at) : new Date()));
  const [filter, setFilter] = useState<CardFilter>("all");
  // read once: this view is first drawn in the browser (after the dashboard loaded), never on the server unless read-only
  const [sent, setSent] = useState<SentRequest[]>(() => (readOnly || typeof window === "undefined" ? [] : sentChangeRequests()));
  const [dialog, setDialog] = useState<{ card: ContactCard; opener: HTMLElement } | null>(null);
  const [justSent, setJustSent] = useState<number | null>(null);
  /**
   * The card to put the focus on once the dashboard has been loaded again (after a refused request), until when: a quiet
   * reload that fails changes nothing, and a later, unrelated reload must not move the focus.
   */
  const focusAfterReload = useRef<{ key: string; until: number } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // the feedback forms' cards (phase protocols): one dismissed here ("Ei soovi") is gone at once
  const [dismissed, setDismissed] = useState<number[]>([]);
  const prompts = (data.feedback ?? []).filter((p) => !dismissed.includes(p.registrationId));

  // What no longer counts as sent (another date now, or a day old) is dropped from this tab's memory.
  useEffect(() => {
    if (!readOnly) pruneChangeRequests(data.cards);
  }, [data, readOnly]);

  // After a quiet reload: the focus on the card the student was dealing with (or the page heading, if it is not shown now).
  useEffect(() => {
    const pending = focusAfterReload.current;
    if (!pending) return;
    focusAfterReload.current = null;
    if (Date.now() > pending.until) return;
    const cardHeading = document.querySelector<HTMLElement>(`[data-card="${pending.key}"] h2`);
    (cardHeading ?? heading.current)?.focus();
  }, [data]);

  const openDialog = useCallback((card: ContactCard, opener: HTMLElement) => setDialog({ card, opener }), []);

  const endDialog = (end: ChangeRequestEnd) => {
    const card = dialog?.card;
    setDialog(null);
    if (!card) return;
    if (end === "sent") {
      // "Saadetud …" takes the place (and the focus) of the card's button
      const entry = rememberChangeRequest(card);
      setSent((list) => [...list.filter((e) => e.id !== entry.id), entry]);
      setJustSent(card.registrationId);
    } else if (end === "stale") {
      // the registration changed meanwhile: load the cards again behind the page, keeping the chips and the place
      focusAfterReload.current = { key: cardKey(card), until: Date.now() + FOCUS_WAIT_MS };
      reload?.({ quiet: true });
    }
  };

  // A pay start the server refused as out of date (401, 404, nothing to pay): the cards are loaded again behind the page, like a refused
  // change request, with the focus on the card the student was dealing with. Not in the admin's view (no reload there).
  const reloadForCard = reload
    ? (card: ContactCard) => {
        focusAfterReload.current = { key: cardKey(card), until: Date.now() + FOCUS_WAIT_MS };
        return reload({ quiet: true });
      }
    : undefined;

  const name = firstName(data.client.name);
  const resume = resumeOf(data);
  // The chips show only while they can change what is seen; without them (the cards changed under a chosen chip, e.g.
  // a refused request turned the last upcoming one into a cancelled one) everything is shown, never an empty list.
  const chips = showFilters(data.cards, now);
  const active: CardFilter = chips ? filter : "all";
  const cards = filterCards(data.cards, active, now);
  // Phones: a row to swipe through when two or more of the cards shown are still ahead (CSS; a computer shows a grid).
  const swipe = cards.filter((card) => !isPastCard(card, now)).length >= 2;

  return (
    <div className={`${ui.wrap} ${styles.page}`} data-account-dashboard="">
      <h1 ref={heading} className={styles.title} tabIndex={-1}>
        {name ? fill(t.hello, { name }) : t.helloNoName}
      </h1>

      {data.cards.length === 0 ? (
        <div className={`${filters.empty} ${styles.empty}`} data-account-empty="">
          <p className={filters.emptyTitle}>{t.empty}</p>
          {readOnly ? (
            <a className={ui.btn} role="link" aria-disabled="true">
              {t.browse}
              <Icon name="arrow" />
            </a>
          ) : (
            <Link className={ui.btn} href={href(locale, "/koolitused")}>
              {t.browse}
              <Icon name="arrow" />
            </Link>
          )}
        </div>
      ) : (
        <>
          <p className={styles.lead}>{t.lead}</p>
          {resume && <ResumeCard card={resume.card} progress={resume.progress} locale={locale} t={t} readOnly={readOnly} />}
          {prompts.length > 0 && (
            <ul className={styles.prompts} aria-label={t.feedbackCard.question} data-feedback-prompts="">
              {prompts.map((p) => (
                <li key={p.registrationId}>
                  <FeedbackCard prompt={p} locale={locale} t={t} readOnly={readOnly} onDismissed={(id) => setDismissed((list) => [...list, id])} />
                </li>
              ))}
            </ul>
          )}
          {chips && (
            <div className={`${filters.pills} ${styles.chips}`} role="group" aria-label={t.filterLabel} data-account-filters="">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={filters.pill}
                  aria-pressed={active === f}
                  onClick={() => {
                    setFilter(f);
                    setJustSent(null);
                  }}
                  data-filter={f}
                >
                  {t[f]}
                </button>
              ))}
            </div>
          )}
          <ul
            className={swipe ? `${styles.list} ${styles.swipe}` : styles.list}
            aria-label={t.listLabel}
            // a row that scrolls sideways can be focused, so the arrow keys scroll it (BlogCarousel's track)
            tabIndex={swipe ? 0 : undefined}
            data-account-cards={swipe ? "swipe" : "list"}
          >
            {cards.map((card) => (
              <li key={cardKey(card)} className={styles.item}>
                <AccountCourseCard
                  card={card}
                  now={now}
                  locale={locale}
                  t={t}
                  pay={data.prepayment}
                  payOnline={data.payOnline === true}
                  readOnly={readOnly}
                  sent={isSent(sent, card)}
                  focusSent={card.kind === "contact" && justSent === card.registrationId}
                  onChangeRequest={openDialog}
                  onStale={reloadForCard}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {dialog && !readOnly && <ChangeRequestDialog card={dialog.card} opener={dialog.opener} locale={locale} t={t} onEnd={endDialog} />}
    </div>
  );
}
