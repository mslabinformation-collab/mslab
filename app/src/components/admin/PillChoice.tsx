"use client";

import { Choice } from "./Choice";
import styles from "./PillChoice.module.css";

/**
 * A choice of one among a few, drawn as pills (the A screens, Task 1; the prototype's „Ootab ettemaksu“ / „Kinnitatud“ status pills): native radios of
 * one `name` inside a `fieldset`, so the browser gives the keyboard (the group is one tab stop, the arrow keys move the choice and choose, as they
 * do for any radios) and the screen reader its „1 of 2“. Each radio is named by its visible label (Choice).
 *
 * - Controlled: the chosen pill is `value` (null: none). A click on another pill calls `onChange(value)` and the pill stays as it is until the
 *   parent changes `value`. Clicking the chosen pill says nothing (a radio does not change).
 * - `legend` names the group for the screen reader and is not drawn: the page has its own heading above the pills („Staatus ja märkus“).
 * - `disabled` disables every pill.
 * - `plain`: no dot, the chosen pill's words bold (the Part 2 prototype's amount and method pills of „Lisa laekumine“, Task 5).
 * - An option's `data`: `data-*` hooks put on its radio (for the screen's tests and specs).
 *
 * "use client" because of the handler it takes; the page that uses it is a client component already (a form part with autosave).
 */
export function PillChoice({
  name,
  legend,
  options,
  value,
  onChange,
  disabled,
  plain = false,
}: {
  name: string;
  legend: string;
  options: { value: string; label: string; data?: Record<`data-${string}`, string> }[];
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  plain?: boolean;
}) {
  return (
    <fieldset className={plain ? `${styles.set} ${styles.plain}` : styles.set} data-pill-choice="">
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.pills}>
        {options.map((o) => (
          <Choice
            key={o.value}
            className={styles.pill}
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
            label={o.label}
            {...o.data}
          />
        ))}
      </div>
    </fieldset>
  );
}
