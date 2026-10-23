"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate } from "@/i18n/format";
import { extendAccessAction } from "@/server/actions/admin-clients";
import { MoreMenu } from "./MoreMenu";
import { useUndo } from "./UndoBar";
import ui from "./ui.module.css";
import forms from "./RegistrationForms.module.css";
import styles from "./ExtendAccess.module.css";

/**
 * „Pikenda ▾“ of one e-course access (README A5, B12; the Part 2 prototype's outlined pill): a menu of +1 kuu / +3 kuud / +6 kuud / „Kuupäev…“ under the
 * title „Pikenda ligipääsu (praegu kuni {date})“ — „(lõppes {date})“ once the access ran out (S3-h). A pick applies at once (extendAccessAction): the
 * server counts the months from the later of the end the screen showed and today, and the UndoBar says „Ligipääs pikendatud kuni {date}.“ with „Võta
 * tagasi“, which puts the previous end back only while the end is still the one this pick set (the server refuses it otherwise, and the bar says so).
 * „Kuupäev…“ opens a field instead (S3-i): „Ligipääs kuni“, „Pikenda“, „Katkesta“; a day that is not later than the current end is refused with
 * „Vali kuupäev, mis on hilisem kui praegune lõpp.“. The page is refreshed by the action, so this card then shows the new end.
 *
 * `expiresAt` is the end the card shows (ISO): what every request is made against. `min` and `max` (yyyy-mm-dd) bound the day field: the first day the server takes
 * (domain/client-access.ts extendMinDay: the day after the end), and the grant form's 10 years. Not drawn for an access an admin ended: the „Ava ligipääs e-koolitusele“ row opens it again.
 * The focus goes back to the pill when the field is closed.
 */
export function ExtendAccess({ accessId, course, expiresAt, expired, min, max }: { accessId: number; course: string; expiresAt: string; expired: boolean; min: string; max: string }) {
  const t = adminEt.clients.extend;
  const uid = useId();
  const undo = useUndo();
  const [asking, setAsking] = useState(false);
  const [date, setDate] = useState("");
  /** The answer the card is showing: the day was refused ("date": under the field), or the pick could not be made ("failed": by the button). */
  const [refused, setRefused] = useState<"date" | "failed" | null>(null);
  const [pending, start] = useTransition();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  /** A new object each time the field is closed by a button or Esc: the focus goes back to the pill (a flag could not say "again"). */
  const [back, setBack] = useState<object | null>(null);
  const end = formatDate(new Date(expiresAt), "et");

  useEffect(() => {
    if (asking) input.current?.focus();
  }, [asking]);

  useEffect(() => {
    if (back) box.current?.querySelector<HTMLElement>("[data-more-menu] > button")?.focus();
  }, [back]);

  const close = () => {
    setAsking(false);
    setRefused(null);
    setBack({});
  };

  const apply = (body: { months: 1 | 3 | 6 } | { date: string }) => {
    if (pending) return;
    setRefused(null);
    start(async () => {
      const r = await extendAccessAction({ accessId, expected: expiresAt, ...body });
      if (!r.ok) {
        setRefused(r.error === "date" && "date" in body ? "date" : "failed");
        return;
      }
      const { previous, until } = r;
      setAsking(false);
      setDate("");
      if ("date" in body) setBack({});
      undo.show({
        text: fill(t.done, { date: formatDate(new Date(until), "et") }),
        // asks for the end this pick set: the server puts `previous` back only if the end is still that one
        undo: async () => (await extendAccessAction({ accessId, expected: until, restore: previous })).ok,
      });
    });
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    // (no day is the same answer as a day that is not later: the server would call it invalid)
    if (!date) setRefused("date");
    else apply({ date });
  };

  const onKey = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Escape") return;
    // only this field: the drawer around it stays open
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const dateError = refused === "date";
  return (
    <div ref={box} className={styles.box} data-extend="">
      <MoreMenu
        variant="pill"
        label={t.button}
        buttonLabel={fill(t.buttonLabel, { course })}
        title={fill(expired ? t.titleExpired : t.titleOpen, { date: end })}
        items={[
          { label: t.plus1, onSelect: () => apply({ months: 1 }) },
          { label: t.plus3, onSelect: () => apply({ months: 3 }) },
          { label: t.plus6, onSelect: () => apply({ months: 6 }) },
          {
            label: t.pickDate,
            onSelect: () => {
              setRefused(null);
              setAsking(true);
            },
          },
        ]}
      />
      {refused === "failed" && !asking && (
        <p role="alert" className={`${ui.error} ${styles.alert}`}>
          {adminEt.common.saveError}
        </p>
      )}
      {asking && (
        <form className={styles.form} onSubmit={submit} onKeyDown={onKey} noValidate data-extend-form="">
          <div className={ui.field}>
            <label htmlFor={`${uid}-date`}>{t.until}</label>
            <input
              ref={input}
              id={`${uid}-date`}
              name="until"
              type="date"
              min={min}
              max={max}
              className={`${ui.input} ${styles.date}`}
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setRefused(null);
              }}
              aria-invalid={dateError || undefined}
              aria-describedby={`${uid}-msg`}
            />
          </div>
          <div className={forms.actions}>
            <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined}>
              {pending ? adminEt.common.saving : t.submit}
            </button>
            <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={close}>
              {adminEt.common.cancel}
            </button>
          </div>
          <p id={`${uid}-msg`} role="status" className={ui.error}>
            {dateError ? t.date : ""}
          </p>
          {refused === "failed" && (
            <p role="alert" className={ui.error}>
              {adminEt.common.saveError}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
