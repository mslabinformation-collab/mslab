import { answerText, FEEDBACK_ORDER, FEEDBACK_TEXTS, feedbackQuestions, type FeedbackAnswers as Answers } from "@/domain/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { et } from "@/i18n/dict/et";
import { fill, formatDate, formatTime } from "@/i18n/format";
import styles from "./FeedbackAnswers.module.css";

// The form's questions in Maria's own wording: its Estonian texts, the one place they are written (et.ts account.feedback).
const QUESTIONS = feedbackQuestions(et.account.feedback.questions);
const FREE: ReadonlySet<string> = new Set(FEEDBACK_TEXTS);

/** An average score as Maria reads it: one decimal, a comma ("7,5"). */
export const formatScore = (n: number): string => new Intl.NumberFormat("et-EE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);

/**
 * One student's answers (phase protocols, spec §7) in the paper form's order and Maria's wording, whatever language she answered in; a
 * question she left out is not shown; a free text as she wrote it. Under them, when it was sent and "Vastas vene keeles" for a Russian answer.
 * The Tagasiside page's drawer and the Õpilased and Registreerimised drawers.
 */
export function FeedbackAnswers({ answers, locale, submittedAt }: { answers: Answers; locale: "et" | "ru"; submittedAt: Date }) {
  const t = adminEt.feedback;
  return (
    <div className={styles.answers} data-feedback-answers="">
      <dl className={styles.list}>
        {FEEDBACK_ORDER.map((key) => {
          const value = answers[key];
          if (value === undefined) return null;
          return (
            <div key={key} data-answer={key}>
              <dt>{QUESTIONS[key].label}</dt>
              <dd className={FREE.has(key) ? styles.text : undefined}>{answerText(key, value, QUESTIONS)}</dd>
            </div>
          );
        })}
      </dl>
      <p className={styles.meta}>
        {fill(t.submitted, { date: `${formatDate(submittedAt, "et")} ${formatTime(submittedAt, "et")}` })}
        {locale === "ru" && ` · ${t.inRussian}`}
      </p>
    </div>
  );
}
