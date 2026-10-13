"use client";

import Link from "next/link";
import ui from "@/components/site/ui.module.css";
import type { StudentProtocol } from "@/db/queries/protocols";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { AccountLoader } from "./AccountLoader";
import { AccountNotFound } from "./AccountNotFound";
import { GreetingSkeleton } from "./CardSkeleton";
import type { ProtocolTexts } from "./texts";
import { useHashId } from "./useHashId";
import page from "./AccountPage.module.css";
import styles from "./ProtocolPage.module.css";

/** GET /api/konto/protokoll's answer: the sent copy. */
type ProtocolAnswer = StudentProtocol & { ok: true };

/**
 * The personal part of /konto/protokoll#id=<registration> (phase protocols, spec §5; the page is a static shell, the same for every visitor):
 * the registration from the fragment, its protocol from GET /api/konto/protokoll?id= (AccountLoader: signed out → the login page, another
 * device, error + retry). Not hers, or none sent: "Seda protokolli ei leitud." with the way back to Minu koolitused, as an address without an id.
 */
export function ProtocolPage({ locale, t }: { locale: Locale; t: ProtocolTexts }) {
  const id = useHashId();
  const notFound = <AccountNotFound state="noProtocol" title={t.notFound} back={t.back} locale={locale} />;
  if (id === undefined) return <div className={`${ui.wrap} ${page.wait}`} aria-busy="true" />;
  if (id === null) return notFound;
  return (
    <AccountLoader<ProtocolAnswer>
      key={id}
      path={`/api/konto/protokoll?id=${id}`}
      locale={locale}
      t={{ ...t.loader, loading: t.loading }}
      skeleton={
        <div className={`${ui.wrap} ${page.wait}`}>
          <GreetingSkeleton />
        </div>
      }
      notFound={notFound}
      render={(data) => <ProtocolView data={data} locale={locale} t={t} />}
    />
  );
}

/** The sent protocol: the course and its day, the stages that have a note, the general notes, when it was sent. Maria's text as she wrote it. */
function ProtocolView({ data, locale, t }: { data: ProtocolAnswer; locale: Locale; t: ProtocolTexts }) {
  const stages = data.stages.filter((s) => s.note.trim() !== "");
  const start = data.session ? new Date(data.session.startsAt) : null;
  const place = data.session ? [data.session.city, data.session.venue].filter(Boolean).join(", ") : "";
  return (
    <article className={`${ui.wrap} ${page.page}`} data-protocol-page="">
      <div className={page.column}>
        <p className={styles.eyebrow}>{t.title}</p>
        <h1 className={page.title}>{pick(data.course.title, locale)}</h1>
        {start && (
          <p className={styles.when} data-protocol-when="">
            {[`${formatDate(start, locale)} · ${formatTime(start, locale)}`, place].filter(Boolean).join(" · ")}
          </p>
        )}
        {stages.length > 0 && (
          <section className={styles.part} aria-labelledby="protocol-practice">
            <h2 id="protocol-practice" className={styles.partTitle}>
              {t.practice}
            </h2>
            {stages.map((s, i) => (
              <div key={i} className={styles.stage} data-protocol-stage={i}>
                <h3 className={styles.stageTitle}>{s.title}</h3>
                <p className={styles.note}>{s.note}</p>
              </div>
            ))}
          </section>
        )}
        {data.generalNote.trim() !== "" && (
          <section className={styles.part} aria-labelledby="protocol-general">
            <h2 id="protocol-general" className={styles.partTitle}>
              {t.general}
            </h2>
            <p className={styles.note} data-protocol-general="">
              {data.generalNote}
            </p>
          </section>
        )}
        <p className={styles.sent}>{fill(t.sent, { date: formatDate(new Date(data.sentAt), locale) })}</p>
        <Link className={ui.btnOutline} href={href(locale, "/konto")} data-protocol-back="">
          {t.back}
        </Link>
      </div>
    </article>
  );
}
