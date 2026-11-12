import { seatFill, seatsLeft } from "@/domain/sessions";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import ui from "./ui.module.css";
import styles from "./SeatsMeter.module.css";

/**
 * A session's seats in the admin's one wording (UX pass 11.11 A2, the Kohad board): the free seats of the capacity, „2 vaba 6-st“ (free as the
 * public pages count them: confirmed registrations and live holds take a seat), or the tag „Täis“ when none is left. Ülevaade and Kalender both.
 */
export function SeatsWords({ capacity, taken }: { capacity: number; taken: number }) {
  const t = adminEt.seats;
  const left = seatsLeft(capacity, taken);
  if (left === 0)
    return (
      <span className={`${ui.tag} ${styles.full}`} data-seats-full="">
        {t.full}
      </span>
    );
  return (
    <span className={styles.free}>
      <b>{fill(t.free, { n: left })}</b> <span className={styles.of}>{fill(t.of, { cap: capacity })}</span>
    </span>
  );
}

/** The words over a bar that fills with the taken seats (seatFill; the warning colour when full). The bar is a picture of the words: hidden from a reader. */
export function SeatsMeter({ capacity, taken }: { capacity: number; taken: number }) {
  const full = seatsLeft(capacity, taken) === 0;
  return (
    <span className={styles.meter}>
      <span data-session-seats="">
        <SeatsWords capacity={capacity} taken={taken} />
      </span>
      <span className={styles.bar} data-seats-bar="" data-full={full ? "" : undefined} aria-hidden="true">
        <span style={{ width: `${seatFill(capacity, taken)}%` }} />
      </span>
    </span>
  );
}
