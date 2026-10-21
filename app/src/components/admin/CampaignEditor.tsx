"use client";

import { useId, useRef, useState } from "react";
import { CampaignCard } from "@/components/site/CampaignCard";
import { NewsletterForm, type NewsletterFormTexts } from "@/components/site/NewsletterForm";
import { NewsletterPopupCard, POPUP_FORM_CLASS } from "@/components/site/NewsletterPopupCard";
import { popupFlags, popupShown, type PopupChoice } from "@/domain/campaign";
import { CAMPAIGN_CTA, SITE_LIMITS, type CampaignDraft, type NewsletterPopupDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { getDict } from "@/i18n/locales";
import { pick } from "@/i18n/field";
import { mediaUrl } from "@/lib/media";
import { saveCampaign } from "@/server/actions/admin-site";
import { Choice } from "./Choice";
import { LangSwitch } from "./EditLang";
import { I18nInput, PreviewLangSwitch, type Lang } from "./I18nInput";
import { SaveBar } from "./SaveBar";
import { SingleImage } from "./SingleImage";
import { TextField } from "./TextField";
import { useSiteDraft, type Loaded } from "./useSiteDraft";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./site-editor.module.css";

const CHOICES: PopupChoice[] = ["campaign", "newsletter", "off"];

/**
 * Hüpikaken (prototype D's adminCamp, Maria C38/C42; phase 2c): at the top "Lehel näidatakse" — Kampaania, Uudiskiri or Väljas, one
 * popup at a time (the save switches the two rows' flags together) — then the two popups' editors, each with the card as a live
 * preview (ET or RU): the campaign (kicker, title, text, code, the button's text and link, the picture; the button says "Leia enda
 * koolitus", M4; no "Mitte praegu", M3) and the newsletter sign-up (kicker, title, text, picture; its form is the footer's). The home
 * page's popups (components/site/CampaignPopup.tsx, NewsletterPopup.tsx) show these same cards, so the previews are what visitors see.
 */
export function CampaignEditor({ initial, links }: { initial: Loaded<{ campaign: CampaignDraft; newsletter: NewsletterPopupDraft }>; links: string[] }) {
  const t = adminEt.campaign;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const d = useSiteDraft(initial, saveCampaign, form);
  const c = d.draft.campaign;
  const n = d.draft.newsletter;
  const shown = popupShown(c.active, n.active);
  const show = (choice: PopupChoice) => {
    const on = popupFlags(choice);
    d.update("campaign", (x) => ({ ...x, active: on.campaign }));
    d.update("newsletter", (x) => ({ ...x, active: on.newsletter }));
  };
  const setC = (patch: Partial<CampaignDraft>) => d.update("campaign", (x) => ({ ...x, ...patch }));
  const setN = (patch: Partial<NewsletterPopupDraft>) => d.update("newsletter", (x) => ({ ...x, ...patch }));
  const errC = (f: string) => d.err(`campaign.${f}`);
  const errN = (f: string) => d.err(`newsletter.${f}`);
  const [langC, setLangC] = useState<Lang>("et");
  const [langN, setLangN] = useState<Lang>("et");

  const campaignPreview = {
    image: c.imageKey ? mediaUrl(c.imageKey) : "",
    kicker: pick(c.kicker, langC),
    title: pick(c.title, langC),
    text: pick(c.text, langC),
    code: c.code.trim().toUpperCase(),
    ctaLabel: pick(c.ctaLabel, langC) || CAMPAIGN_CTA,
    ctaHref: c.ctaHref,
  };
  const newsletterPreview = { image: n.imageKey ? mediaUrl(n.imageKey) : "", kicker: pick(n.kicker, langN), title: pick(n.title, langN), text: pick(n.text, langN) };
  // the form's own words in the previewed language: the ones the home page's popup shows (no answers: nothing is sent from here)
  const site = getDict(langN);
  const formTexts: NewsletterFormTexts = {
    emailLabel: site.newsletter.emailLabel,
    emailPlaceholder: site.newsletter.emailPlaceholder,
    submit: site.newsletter.submit,
    notice: site.newsletter.notice,
    privacy: site.footer.privacy,
    sentTitle: "",
    sentText: site.newsletter.popupSent,
    errorEmail: "",
    errorTooMany: "",
    errorGeneric: "",
  };

  return (
    <form ref={form} className={ui.page} onSubmit={d.submit} noValidate data-campaign-editor="">
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

      <section className={ui.card} aria-labelledby={`${uid}-shown`}>
        <fieldset className={ed.fieldset} data-popup-shown={shown}>
          <legend id={`${uid}-shown`} className={ui.legend}>
            {t.shown}
          </legend>
          <div className={ed.choices}>
            {CHOICES.map((choice) => (
              <Choice
                key={choice}
                className={ed.choice}
                label={t.shownOptions[choice]}
                type="radio"
                name={`${uid}-shown`}
                value={choice}
                checked={shown === choice}
                onChange={() => show(choice)}
                data-popup-choice={choice}
              />
            ))}
          </div>
        </fieldset>
      </section>

      <div className={styles.cols} data-popup-section="campaign">
        <section className={ui.card} aria-labelledby={`${uid}-form`}>
          <h2 id={`${uid}-form`} className={ui.h3}>
            {t.form}
          </h2>
          <div className={styles.fields}>
            <I18nInput label={t.kicker} value={c.kicker} onChange={(kicker) => setC({ kicker })} maxLength={SITE_LIMITS.campaignKicker} error={errC("kicker")} name="campaign.kicker" />
            <I18nInput label={t.titleField} value={c.title} onChange={(title) => setC({ title })} maxLength={SITE_LIMITS.campaignTitle} error={errC("title")} name="campaign.title" />
            <I18nInput label={t.text} value={c.text} onChange={(text) => setC({ text })} multiline rows={3} maxLength={SITE_LIMITS.campaignText} error={errC("text")} name="campaign.text" />
            <div className={styles.pair}>
              <TextField label={t.code} value={c.code} onChange={(code) => setC({ code })} maxLength={SITE_LIMITS.code} hint={t.codeHint} error={errC("code")} name="campaign.code" />
              <I18nInput label={t.ctaLabel} value={c.ctaLabel} onChange={(ctaLabel) => setC({ ctaLabel })} maxLength={SITE_LIMITS.ctaLabel} hint={t.ctaLabelHint} placeholder={CAMPAIGN_CTA} error={errC("ctaLabel")} name="campaign.ctaLabel" />
            </div>
            <TextField label={t.ctaHref} value={c.ctaHref} onChange={(ctaHref) => setC({ ctaHref })} maxLength={SITE_LIMITS.href} hint={t.ctaHrefHint} error={errC("ctaHref")} inputMode="url" suggestions={links} name="campaign.ctaHref" />
            <SingleImage label={t.image} value={c.imageKey} onChange={(imageKey) => setC({ imageKey })} error={errC("imageKey")} ratio="16 / 9" name="campaign" />
          </div>
        </section>

        <div className={styles.aside}>
          <section className={ui.card} aria-labelledby={`${uid}-preview`}>
            <div className={styles.previewHead}>
              <h2 id={`${uid}-preview`} className={ui.h3}>
                {t.preview}
              </h2>
              <PreviewLangSwitch lang={langC} onChange={setLangC} label={t.preview} missingRu={false} />
            </div>
            {shown !== "campaign" && <p className={`${ui.notice} ${styles.cardLead}`}>{t.off}</p>}
            {/* inert: the preview's button and copy button are pictures of the real ones */}
            <div className={styles.previewBox} inert data-campaign-preview="" data-off={shown === "campaign" ? undefined : ""} lang={langC}>
              <CampaignCard
                c={campaignPreview}
                locale={langC}
                codeAction={
                  <button type="button" tabIndex={-1}>
                    {t.copy}
                  </button>
                }
              />
            </div>
            <p className={`${ui.muted} ${ui.small} ${styles.previewNote}`}>{t.previewNote}</p>
          </section>
          <section className={ui.card} aria-labelledby={`${uid}-rules`}>
            <h2 id={`${uid}-rules`} className={ui.h3}>
              {t.rules}
            </h2>
            <ul className={styles.rules}>
              {t.rulesList.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      <div className={styles.cols} data-popup-section="newsletter">
        <section className={ui.card} aria-labelledby={`${uid}-nl`}>
          <h2 id={`${uid}-nl`} className={ui.h3}>
            {t.newsletterForm}
          </h2>
          <p className={`${ui.muted} ${styles.cardLead}`}>{t.newsletterLead}</p>
          <div className={styles.fields}>
            <I18nInput label={t.kicker} value={n.kicker} onChange={(kicker) => setN({ kicker })} maxLength={SITE_LIMITS.campaignKicker} error={errN("kicker")} name="newsletter.kicker" />
            <I18nInput label={t.titleField} value={n.title} onChange={(title) => setN({ title })} maxLength={SITE_LIMITS.campaignTitle} error={errN("title")} name="newsletter.title" />
            <I18nInput label={t.text} value={n.text} onChange={(text) => setN({ text })} multiline rows={3} maxLength={SITE_LIMITS.campaignText} error={errN("text")} name="newsletter.text" />
            <SingleImage label={t.image} value={n.imageKey} onChange={(imageKey) => setN({ imageKey })} error={errN("imageKey")} ratio="16 / 9" name="newsletter" />
          </div>
        </section>
        <div className={styles.aside}>
          <section className={ui.card} aria-labelledby={`${uid}-nl-preview`}>
            <div className={styles.previewHead}>
              <h2 id={`${uid}-nl-preview`} className={ui.h3}>
                {t.preview}
              </h2>
              <PreviewLangSwitch lang={langN} onChange={setLangN} label={`${t.preview}: ${t.newsletterForm}`} missingRu={false} />
            </div>
            {shown !== "newsletter" && <p className={`${ui.notice} ${styles.cardLead}`}>{t.off}</p>}
            {/* inert: the form in the preview is a picture of the real one (`preview`: no <form> inside this editor's form, nothing is sent from here) */}
            <div className={styles.previewBox} inert data-newsletter-preview="" data-off={shown === "newsletter" ? undefined : ""} lang={langN}>
              <NewsletterPopupCard n={newsletterPreview} form={<NewsletterForm locale={langN} preview className={POPUP_FORM_CLASS} t={formTexts} />} />
            </div>
          </section>
        </div>
      </div>

      <SaveBar status={d.status} pending={d.pending} reloadHref="/admin/kampaania" />
    </form>
  );
}
