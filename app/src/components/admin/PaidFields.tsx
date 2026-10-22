import { paidMethodText, type ManualPaidMethod } from "@/domain/invoice";
import ui from "./ui.module.css";
import styles from "./InvoiceBlock.module.css";

/** The ways Maria records money she received (D6); Montonio's and Järelmaks (Inbank) are the site's own. */
export type ManualMethod = ManualPaidMethod;
export const MANUAL_METHODS: readonly ManualMethod[] = ["bank", "cash", "card"];

/**
 * The day money came in and the way, as „Juba tasutud“ (a receipt) and „Märgi tasutuks“ ask them (spec D5, D6): a date field (today unless she
 * changes it, never after today) and a choice of Pangaülekanne, Sularaha or Kaardimakse kohapeal. `name` makes the radio group's name unique on a
 * page that holds several invoices.
 */
export function PaidFields({
  name,
  date,
  method,
  today,
  onDate,
  onMethod,
  dateLabel,
  methodLabel,
}: {
  name: string;
  date: string;
  method: ManualMethod;
  today: string;
  onDate: (date: string) => void;
  onMethod: (method: ManualMethod) => void;
  dateLabel: string;
  methodLabel: string;
}) {
  return (
    <>
      <div className={ui.field}>
        <label htmlFor={`${name}-date`}>{dateLabel}</label>
        <input id={`${name}-date`} name="paidAt" className={`${ui.input} ${styles.date}`} type="date" required max={today} value={date} onChange={(e) => onDate(e.target.value)} data-paid-date="" />
      </div>
      <fieldset className={styles.fieldset}>
        <legend className={ui.legend}>{methodLabel}</legend>
        <div className={styles.choices}>
          {MANUAL_METHODS.map((m) => (
            <label key={m} className={styles.choice}>
              <input type="radio" name={`${name}-method`} value={m} checked={method === m} onChange={() => onMethod(m)} data-paid-method={m} />
              <span>{paidMethodText(m)}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );
}
