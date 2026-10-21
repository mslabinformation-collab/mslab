"use client";

import { useId, useRef } from "react";
import { SITE_LIMITS, type ContactDraft, type PageDraft, type PrepaymentDraft } from "@/domain/site-editor";
import { WELCOME_CODE_MAX } from "@/domain/welcome-code";
import { adminEt } from "@/i18n/dict/admin";
import { saveSettings } from "@/server/actions/admin-site";
import type { SettingsValues } from "@/server/admin-site";
import { ContractPlaceholders } from "./ContractTexts";
import { LangSwitch } from "./EditLang";
import { I18nInput } from "./I18nInput";
import { SaveBar } from "./SaveBar";
import { TextField } from "./TextField";
import { useSiteDraft, type Loaded } from "./useSiteDraft";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./site-editor.module.css";

/**
 * Seaded: the contact details and social links (footer, contact page; social links https only), the newsletter's
 * welcome discount (footer text) and welcome code ("Tervituskood": mailed after the first confirmation, shown on the
 * confirmed notice; phase 2c), the prepayment instructions (where students pay; shown on their unpaid contact-course
 * cards only when the receiver and the IBAN are filled in), the legal pages (privacy, terms) in ET / RU, the e-course contract
 * („E-koolituse leping (tingimused)“: its title and the text a student accepts in the cart and at the terms gate, with the contact card's
 * placeholders hint, since both fill them; account-only, so no link to a public page) and the admin addresses, read-only. The contact course's contract has its own card after this form (ContractTexts, Seaded → Lepingud).
 */
export function SettingsEditor({ initial, admins }: { initial: Loaded<SettingsValues>; admins: string[] }) {
  const t = adminEt.settings;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const d = useSiteDraft(initial, saveSettings, form);
  const contact = d.draft.contact;
  const setContact = (patch: Partial<ContactDraft>) => d.set("contact", { ...contact, ...patch });
  const cErr = (f: string) => d.err(`contact.${f}`);
  const pay = d.draft.prepayment;
  const setPay = (patch: Partial<PrepaymentDraft>) => d.set("prepayment", { ...pay, ...patch });
  const pErr = (f: string) => d.err(`prepayment.${f}`);

  const legal = (key: "privacy" | "terms", title: string, href: string) => {
    const page: PageDraft = d.draft[key];
    return (
      <section className={ui.card} aria-labelledby={`${uid}-${key}`} data-legal-editor={key}>
        <div className={styles.cardHead}>
          <h2 id={`${uid}-${key}`} className={`${ui.h2} ${styles.cardTitle}`}>
            {title}
          </h2>
          <a className={ui.link} href={href} target="_blank" rel="noopener">
            {adminEt.editor.viewSite} ↗<span className={ui.sr}> ({adminEt.editor.newWindow})</span>
          </a>
        </div>
        <div className={styles.fields}>
          <I18nInput label={t.pageTitle} value={page.title} onChange={(v) => d.set(key, { ...page, title: v })} maxLength={SITE_LIMITS.legalTitle} error={d.err(`${key}.title`)} name={`${key}.title`} />
          <I18nInput label={t.pageBody} value={page.body} onChange={(v) => d.set(key, { ...page, body: v })} multiline rows={10} maxLength={SITE_LIMITS.legal} hint={t.pageHint} error={d.err(`${key}.body`)} name={`${key}.body`} />
        </div>
      </section>
    );
  };

  const courseTerms = d.draft.course_terms;

  return (
    <form ref={form} className={ui.page} onSubmit={d.submit} noValidate data-settings-editor="">
      <div className={ui.heading}>
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
          <p className={ui.lead}>{t.lead}</p>
        </div>
        <div className={ui.headAside}>
          <LangSwitch />
        </div>
      </div>

      <div className={styles.stack}>
        <section className={ui.card} aria-labelledby={`${uid}-contact`}>
          <h2 id={`${uid}-contact`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.contact}
          </h2>
          <p className={`${ui.muted} ${styles.cardLead}`}>{t.contactLead}</p>
          <div className={ed.grid}>
            <TextField label={t.email} type="email" inputMode="email" autoComplete="off" value={contact.email} onChange={(email) => setContact({ email })} maxLength={SITE_LIMITS.email} error={cErr("email")} name="contact.email" />
            <TextField label={t.phone} type="tel" inputMode="tel" value={contact.phone} onChange={(phone) => setContact({ phone })} maxLength={SITE_LIMITS.phone} error={cErr("phone")} name="contact.phone" />
            <TextField className={ed.wide} label={t.address} value={contact.address} onChange={(address) => setContact({ address })} maxLength={SITE_LIMITS.address} hint={t.addressHint} error={cErr("address")} name="contact.address" />
            <TextField label={t.instagram} type="url" inputMode="url" value={contact.instagram} onChange={(instagram) => setContact({ instagram })} maxLength={SITE_LIMITS.url} hint={t.socialHint} placeholder="https://" error={cErr("instagram")} name="contact.instagram" />
            <TextField label={t.facebook} type="url" inputMode="url" value={contact.facebook} onChange={(facebook) => setContact({ facebook })} maxLength={SITE_LIMITS.url} hint={t.socialHint} placeholder="https://" error={cErr("facebook")} name="contact.facebook" />
          </div>
        </section>

        <section className={ui.card} aria-labelledby={`${uid}-newsletter`}>
          <h2 id={`${uid}-newsletter`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.newsletter}
          </h2>
          <div className={ed.grid}>
            <TextField
              label={t.discount}
              value={d.draft.newsletter.discountLabel}
              onChange={(discountLabel) => d.set("newsletter", { ...d.draft.newsletter, discountLabel })}
              maxLength={SITE_LIMITS.discount}
              hint={t.discountHint}
              error={d.err("newsletter.discountLabel")}
              name="newsletter.discountLabel"
            />
            <TextField
              label={t.welcomeCode}
              value={d.draft.newsletter.welcomeCode}
              onChange={(welcomeCode) => d.set("newsletter", { ...d.draft.newsletter, welcomeCode })}
              maxLength={WELCOME_CODE_MAX}
              hint={t.welcomeCodeHint}
              error={d.err("newsletter.welcomeCode")}
              name="newsletter.welcomeCode"
            />
          </div>
        </section>

        <section id="ettemaks" className={ui.card} aria-labelledby={`${uid}-prepayment`} data-prepayment-editor="">
          <h2 id={`${uid}-prepayment`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.prepayment}
          </h2>
          <p className={`${ui.muted} ${styles.cardLead}`}>{t.prepaymentLead}</p>
          <p className={ui.notice}>{t.prepaymentHint}</p>
          <div className={ed.grid}>
            <TextField label={t.receiver} value={pay.receiver} onChange={(receiver) => setPay({ receiver })} maxLength={SITE_LIMITS.receiver} error={pErr("receiver")} name="prepayment.receiver" />
            <TextField label={t.iban} value={pay.iban} onChange={(iban) => setPay({ iban })} maxLength={SITE_LIMITS.iban} error={pErr("iban")} name="prepayment.iban" />
            <TextField label={t.bank} value={pay.bank} onChange={(bank) => setPay({ bank })} maxLength={SITE_LIMITS.bank} error={pErr("bank")} name="prepayment.bank" />
            <TextField
              label={t.referencePrefix}
              value={pay.referencePrefix}
              onChange={(referencePrefix) => setPay({ referencePrefix })}
              maxLength={SITE_LIMITS.referencePrefix}
              hint={t.referenceHint}
              error={pErr("referencePrefix")}
              name="prepayment.referencePrefix"
            />
          </div>
        </section>

        {legal("privacy", t.privacy, "/privaatsus")}
        {legal("terms", t.terms, "/tingimused")}

        <section className={ui.card} aria-labelledby={`${uid}-course_terms`} data-legal-editor="course_terms">
          <h2 id={`${uid}-course_terms`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.courseTerms}
          </h2>
          <p className={`${ui.muted} ${styles.cardLead}`}>{t.courseTermsLead}</p>
          <div className={styles.fields}>
            <I18nInput
              label={t.pageTitle}
              value={courseTerms.title}
              onChange={(title) => d.set("course_terms", { ...courseTerms, title })}
              maxLength={SITE_LIMITS.legalTitle}
              hint={adminEt.contracts.settings.ecourseTitleHint}
              error={d.err("course_terms.title")}
              name="course_terms.title"
            />
            <I18nInput
              label={t.pageBody}
              value={courseTerms.body}
              onChange={(body) => d.set("course_terms", { ...courseTerms, body })}
              multiline
              rows={10}
              maxLength={SITE_LIMITS.legal}
              hint={t.pageHint}
              error={d.err("course_terms.body")}
              name="course_terms.body"
            />
            <ContractPlaceholders />
          </div>
        </section>

        <section className={ui.card} aria-labelledby={`${uid}-admins`} data-admin-emails="">
          <h2 id={`${uid}-admins`} className={`${ui.h2} ${styles.cardTitle}`}>
            {t.admins}
          </h2>
          <p className={ui.muted}>{t.adminsLead}</p>
          <ul className={styles.admins}>
            {admins.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>
      </div>

      <SaveBar status={d.status} pending={d.pending} reloadHref="/admin/seaded" />
    </form>
  );
}
