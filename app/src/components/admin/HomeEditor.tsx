"use client";

import Link from "next/link";
import { useId, useRef } from "react";
import { SITE_LIMITS } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { saveHome } from "@/server/actions/admin-site";
import type { HomeValues } from "@/server/admin-site";
import { LangSwitch } from "./EditLang";
import { FaqEditor } from "./FaqEditor";
import { I18nInput } from "./I18nInput";
import { SaveBar } from "./SaveBar";
import { SlidesEditor } from "./SlidesEditor";
import { useSiteDraft, type Loaded } from "./useSiteDraft";
import ui from "./ui.module.css";
import styles from "./site-editor.module.css";

/**
 * Avaleht: the hero slides (image, focal points, tone, texts, button, order, on / off), D's statement line, the text of
 * the trainer card (C26) and the FAQ,
 * saved together with "Salvesta" (only the changed parts are sent). The home page's trainer block uses the trainer page's
 * data (Koolitaja), so it has a pointer there instead of fields of its own.
 */
export function HomeEditor({ initial, links }: { initial: Loaded<HomeValues>; links: string[] }) {
  const t = adminEt.home;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const d = useSiteDraft(initial, saveHome, form);

  return (
    <form ref={form} className={ui.page} onSubmit={d.submit} noValidate data-home-editor="">
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
        <div className={ui.headAside}>
          <LangSwitch />
          <a className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href="/" target="_blank" rel="noopener">
            {adminEt.editor.viewSite} ↗<span className={ui.sr}> ({adminEt.editor.newWindow})</span>
          </a>
        </div>
      </div>

      <div className={styles.stack}>
        <section className={ui.card} aria-labelledby={`${uid}-slides`}>
          <h2 id={`${uid}-slides`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.slides.title}
          </h2>
          <p className={`${ui.muted} ${styles.cardLead}`}>{t.slides.lead}</p>
          <SlidesEditor slides={d.draft.slides} update={(fn) => d.update("slides", fn)} err={d.err} hasErrors={d.hasErrors} links={links} />
        </section>

        <section className={ui.card} aria-labelledby={`${uid}-statement`}>
          <h2 id={`${uid}-statement`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.statement.title}
          </h2>
          <p className={`${ui.muted} ${styles.cardLead}`}>{t.statement.lead}</p>
          <I18nInput
            label={t.statement.field}
            value={d.draft.statement.body}
            onChange={(body) => d.set("statement", { body })}
            multiline
            rows={3}
            maxLength={SITE_LIMITS.statement}
            hint={t.statement.hint}
            error={d.err("statement.body")}
            name="statement.body"
          />
        </section>

        <section className={ui.card} aria-labelledby={`${uid}-teaser`} data-teaser-editor="">
          <h2 id={`${uid}-teaser`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.teaser.title}
          </h2>
          <p className={`${ui.muted} ${styles.cardLead}`}>{t.teaser.lead}</p>
          <I18nInput
            label={t.teaser.field}
            value={d.draft.teaser.body}
            onChange={(body) => d.set("teaser", { body })}
            multiline
            rows={3}
            maxLength={SITE_LIMITS.teaser}
            hint={t.teaser.hint}
            error={d.err("teaser.body")}
            name="teaser.body"
          />
        </section>

        <section className={ui.card} aria-labelledby={`${uid}-faq`}>
          <h2 id={`${uid}-faq`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.faq.title}
          </h2>
          <p className={`${ui.muted} ${styles.cardLead}`}>{t.faq.lead}</p>
          <FaqEditor items={d.draft.faq} onChange={(faq) => d.set("faq", faq)} err={d.err} />
        </section>

        <section className={ui.card} aria-labelledby={`${uid}-trainer`} data-trainer-note="">
          <h2 id={`${uid}-trainer`} className={`${ui.h3} ${styles.cardTitle}`}>
            {t.trainer.title}
          </h2>
          <p className={ui.muted}>{t.trainer.text}</p>
          <Link className={ui.link} href="/admin/koolitaja">
            {t.trainer.link}
          </Link>
        </section>
      </div>

      <SaveBar status={d.status} pending={d.pending} reloadHref="/admin/avaleht" />
    </form>
  );
}
