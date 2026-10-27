"use client";

import { useId } from "react";
import styles from "./Switch.module.css";

/**
 * A two-state switch (admin UX pass; the Part 3 frame "B2 Course editor" L111, the Part 4 phone frame L61: „Avalikul lehel“, „Näidissisu“; Task 10's
 * „Õpilastele nähtav“): a row with the label at the left and a 48×28 pill with its knob at the right, on in the admin's green, off in grey. It is a
 * real checkbox with `role="switch"`, so the keyboard (Space), the label tap and the screen reader's on / off all come with it; the row is at least
 * 44 px tall, the focus ring is the admin's, and the knob does not move with an animation under prefers-reduced-motion.
 *
 * - `label`: the switch's name (the row's visible text).
 * - `checked`, `onChange(on)`: the state is the caller's (an instant switch saves in its handler).
 * - `disabled`; `describedBy`: the id(s) of what describes it (a refusal under it).
 * - `ariaLabel`: a fuller name for a screen reader than the visible label, when one switch of many in a list says the same (Tagasiside's „Avalehel:
 *   {name}“ on each card, piece 4c); without it the visible label is the name.
 * - Any `data-*` attribute goes on the input (the screens' hooks).
 */
export function Switch({
  label,
  checked,
  onChange,
  disabled,
  describedBy,
  ariaLabel,
  ...data
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  describedBy?: string;
  ariaLabel?: string;
} & { [attribute: `data-${string}`]: string | undefined }) {
  const id = useId();
  return (
    <label className={styles.row} htmlFor={id} data-switch-row="">
      <span className={styles.label}>{label}</span>
      <span className={styles.control}>
        <input
          {...data}
          id={id}
          type="checkbox"
          role="switch"
          className={styles.input}
          checked={checked}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={styles.track} aria-hidden="true">
          <span className={styles.knob} />
        </span>
      </span>
    </label>
  );
}
