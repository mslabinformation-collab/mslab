import Link from "next/link";
import { adminEt } from "@/i18n/dict/admin";
import { RequestToggle } from "./RequestToggle";
import type { RequestView } from "./request-view";
import ui from "./ui.module.css";
import styles from "./RequestCard.module.css";

/**
 * One request of Päringud (admin UX pass, README A7, the Part 2 prototype's compact card): the name in Jost 20 with „{date} · {lang} · {email}“ under it, the
 * type tag at the right, the message, one muted facts line (piece2-texts S3-j), then „Märgi tehtuks“ (instant, with an UndoBar) and „Vasta e-kirjaga ↗“
 * (a `mailto:` with the subject filled in, S3-k). A waitlist entry adds „Ava toimumine →“, a change request „Ava registreering →“. A done request, in the
 * fold „Tehtud ({n})“, has „Märgi tegemata“ in place of the first button.
 *
 * `id="p-{id}"` is the card's address: a link to `…?liik={tab}#p-{id}` (the Õpilased drawer's „Vaata päringutes“) is taken to it by RequestTarget.
 * On a phone the header's line is the short „{dd.mm} · {lang}“ and the reply button says „Vasta ↗“ (the Part 2 phone frame): the page holds the long words,
 * and the stylesheet puts the short ones in their place from `data-short` (so whoever reads the page's text sees one label, not two).
 *
 * No state and no "use client" line: a server page draws it as it is (tests/unit/old-safari.test.ts lists it); the button is RequestToggle.
 */
export function RequestCard({ view }: { view: RequestView }) {
  const t = adminEt.requests;
  return (
    <article
      id={`p-${view.id}`}
      className={styles.card}
      data-request={view.id}
      data-handled={view.handled ? "1" : "0"}
      data-request-tab={view.tab}
      aria-labelledby={`req-${view.id}`}
    >
      <header className={styles.head}>
        <div className={styles.who}>
          <h3 id={`req-${view.id}`} className={ui.h3}>
            {view.title}
          </h3>
          {view.meta && (
            <p className={styles.meta} data-request-meta="">
              <span className={styles.swap} data-swap="" data-short={view.metaShort}>
                <span className={styles.wide}>{view.meta}</span>
              </span>
            </p>
          )}
        </div>
        <span className={styles.tag} data-request-tag="" data-interest={view.interest ? "" : undefined}>
          {view.tag}
        </span>
      </header>
      {view.message && (
        <p className={styles.message} data-request-message="">
          {view.message}
        </p>
      )}
      {view.facts && (
        <p className={styles.facts} data-request-facts="">
          {view.facts}
        </p>
      )}
      <div className={styles.actions}>
        <RequestToggle id={view.id} handled={view.handled} />
        {view.reply && (
          <a className={`${ui.btn} ${ui.smallBtn} ${ui.secondary}`} href={view.reply} data-request-reply="">
            <span className={styles.swap} data-swap="" data-short={t.replyShort}>
              <span className={styles.wide}>{t.reply}</span>
            </span>
          </a>
        )}
        {view.go && (
          <Link className={`${ui.link} ${styles.go}`} href={view.go.href} data-request-go="">
            {view.go.text}
          </Link>
        )}
      </div>
    </article>
  );
}
