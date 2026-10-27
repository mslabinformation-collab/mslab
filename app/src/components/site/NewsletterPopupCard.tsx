import type { ReactNode } from "react";
import type { NewsletterPopupView } from "@/domain/campaign";
import type { Dict } from "@/i18n/locales";
import { keepNamesTogether } from "@/lib/typography";
import type { NewsletterFormTexts } from "./NewsletterForm";
import ui from "./ui.module.css";
import styles from "./NewsletterPopupCard.module.css";

/** The class for the form put in this card (NewsletterForm's `className`): the card's own gap above it, and no margin of the form's. */
export const POPUP_FORM_CLASS = styles.signupForm;

/**
 * The popup's sign-up words in a language (`d`, that language's dictionary): the footer form's, with the popup's own answer, and its button following
 * Seaded's welcome code (admin UX pass piece 4b, S4-Q4 A): „Saa kood“ / „Получить код“ while a code is set (`code`: one will come in the welcome mail),
 * else „Liitu“ / „Подписаться“. The footer's form keeps „Liitu“ in every case. The home page's popup and Hüpikaken's preview use the same words.
 */
export function popupFormTexts(d: Dict, code: boolean): NewsletterFormTexts {
  return {
    emailLabel: d.newsletter.emailLabel,
    emailPlaceholder: d.newsletter.emailPlaceholder,
    submit: code ? d.newsletter.popupSubmitCode : d.newsletter.submit,
    notice: d.newsletter.notice,
    privacy: d.footer.privacy,
    sentTitle: "",
    sentText: d.newsletter.popupSent,
    errorEmail: d.forms.errorEmail,
    errorTooMany: d.forms.errorTooMany,
    errorGeneric: d.forms.errorGeneric,
  };
}

/**
 * The newsletter popup's card (phase 2c): the picture, kicker, Jost title and text (NewsletterPopupCard.module.css, prototype D's campaign card), with the sign-up
 * form under them. Presentational only: the dialog is the popup's (NewsletterPopup), and `form` is given — the real NewsletterForm on the home page,
 * the same form inert in the admin's preview (Hüpikaken).
 */
export function NewsletterPopupCard({ n, titleId, close, form }: { n: NewsletterPopupView; titleId?: string; close?: ReactNode; form: ReactNode }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.camp} data-newsletter-card="">
        {close}
        <div className={styles.photo}>
          {/* eslint-disable-next-line @next/next/no-img-element -- an upload already resized in the browser (ImageUpload) and served by /media: next/image would add nothing */}
          {n.image && <img className={styles.image} src={n.image} alt="" />}
        </div>
        <div className={styles.body}>
          {n.kicker && <p className={`${ui.caps} ${styles.kicker}`}>{n.kicker}</p>}
          <h2 id={titleId} className={styles.title}>
            {keepNamesTogether(n.title)}
          </h2>
          {n.text && <p className={styles.text}>{n.text}</p>}
          <div className={styles.signup}>{form}</div>
        </div>
      </div>
    </div>
  );
}
