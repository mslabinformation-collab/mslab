"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import { AREA_LIMITS, areaNameProblems } from "@/domain/course-areas";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { sendJson, type JsonAnswer } from "@/lib/json-request";
import type { AdminArea } from "@/server/course-areas";
import { ConfirmPanel } from "./ConfirmPanel";
import { DragList } from "./DragList";
import { reorder } from "./reorder";
import { TextField } from "./TextField";
import { pressFailedLine } from "./useEditorRestarts";
import { useSeadedPart, type StatusReport } from "./useSeadedPart";
import ui from "./ui.module.css";
import site from "./site-editor.module.css";
import styles from "./AreasSettings.module.css";

// Seaded → „Valdkonnad“ (course areas, spec 2026-11-11-course-areas-filter-design.md §4.1; UX pass 11.11 board 1, A6/A8): Maria's list of training
// areas, by which students choose courses in the calendar and on the catalogue page, and which a course's „Põhiinfo“ picks one of („Valdkond“).
// - The card's title and lead, the two names' column labels once, then one bordered box per area in her order (DragList: ⋮⋮ and ↑ / ↓, the house's
//   list rows), all on one grid: ⋮⋮ | „Nimi (eesti keeles)“ | „Nimi (vene keeles)“ | how many courses use it („2 koolitust“, „Pole kasutusel“) | ↑ ↓ |
//   „Kustuta“. The names autosave on the row's own route (api/admin/valdkond/<id>, useSeadedPart: 1.5 s after typing and at once when the row is
//   left) from the row's version, under the page's one SaveStatus (each row is its part, "area-<id>"); the browser holds a name back while it is
//   empty or too long (domain/course-areas.ts, the server's rule), the route says `taken` for another area's Estonian name.
// - „Kustuta“ is the one delete style of Seaded (red outline, the row's right end): it asks under the row (a ConfirmPanel: „Kas kustutan valdkonna
//   „{name}“?“). An area courses use (live or in a draft) is never deleted (the server refuses it as well): its „Kustuta“ is greyed (aria-disabled),
//   described by its count and the rule under the rows, „Kasutusel olevat valdkonda ei saa kustutada: …“.
// - The add row at the end: the same box, dashed, on the same grid — the two names (placeholders „Uus valdkond“ / „Новая область“) and „Lisa
//   valdkond +“ (POST api/admin/valdkond/uus).
// - The adds, moves and deletes are presses (the moves shown at once); each answer is the list as it is after it, which the card takes as it comes (a
//   row's own names stay what its fields hold). While one is on its way the chip says „Salvestan…“ (part "areas") and another press does nothing; a
//   refused move goes back with the list's words for it under its row (adminEt.courses.moveError), any other failure says the admin's save line.

const t = adminEt.settings.areas;

/** A name's words for the route's or the browser's code (required, tooLong, taken). */
const errorText = (code: string | undefined): string | undefined => (code === undefined ? undefined : ((t.errors as Record<string, string>)[code] ?? adminEt.editor.invalid));

/** The list an answer brings (the routes' `areas`), or null when it brings none. */
function areasOf(answer: JsonAnswer): AdminArea[] | null {
  const list = answer.data.areas;
  return Array.isArray(list) && list.every((a) => typeof a === "object" && a !== null && typeof (a as AdminArea).id === "number") ? (list as AdminArea[]) : null;
}

/** The row's count: „{n} koolitust“ (one: „1 koolitus“), or „Pole kasutusel“. */
const usedLine = (n: number): string => (n === 0 ? t.unused : n === 1 ? t.usedOne : fill(t.usedMany, { n }));

const SAVING: AutosaveStatus = { kind: "saving" };
/** A press that is over: its time when it went through; none when it did not (its row says why). */
const over = (ok: boolean): AutosaveStatus => ({ kind: "saved", at: ok ? new Date() : null });

type RowProps = {
  area: AdminArea;
  handle: ReactNode;
  arrows: ReactNode;
  onStatus?: StatusReport;
  /** Tells the card the Estonian name as its field has it now (the handle's and the arrows' names, the question). */
  onName: (id: number, name: string) => void;
  /** The line under the row: a refused move or delete. */
  error: string | null;
  busy: boolean;
  onDelete: (discardCopy: () => void) => void;
  /** The id of the rule under the rows (a used area's greyed „Kustuta“ points to it). */
  ruleId: string;
};

/** One area's box: ⋮⋮, its two names (autosaved), how many courses use it, ↑ ↓ and „Kustuta“ (greyed while it is used). */
function AreaRow({ area, handle, arrows, onStatus, onName, error, busy, onDelete, ruleId }: RowProps) {
  const part = `area-${area.id}`;
  const usedId = useId();
  const fields = useMemo(() => ({ et: area.name.et, ru: area.name.ru }), []); // eslint-disable-line react-hooks/exhaustive-deps -- the engine starts from the first read
  const nameNow = useRef(area.name.et);
  const label = useCallback((f: string) => `${nameNow.current.trim() || t.unnamed}: ${f === "ru" ? t.nameRu : t.nameEt}`, []);
  const focusField = useCallback((f: string) => document.querySelector<HTMLElement>(`[data-field="${part}.${f}"]`)?.focus(), [part]);
  const row = useSeadedPart({ part, url: `/api/admin/valdkond/${area.id}`, version: area.version, fields, label, focusField, onStatus, validate: areaNameProblems });
  const et = String(row.text("et") ?? "");
  useEffect(() => {
    nameNow.current = et;
    onName(area.id, et.trim());
  }, [onName, area.id, et]);
  // a row that goes (deleted) leaves the page's chip as it found it
  useEffect(() => () => onStatus?.(part, { kind: "saved", at: null }), [onStatus, part]);

  const [asking, setAsking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  /** „Katkesta“ was pressed: the button comes back with the focus (README §1.6). */
  const refocus = useRef(false);
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    opener.current?.focus();
  }, [asking]);
  // a delete refused because a course uses it: the question closes, the row says how many (the list's new `used`)
  const [usedSeen, setUsedSeen] = useState(area.used);
  if (usedSeen !== area.used) {
    setUsedSeen(area.used);
    if (area.used > 0) setAsking(false);
  }

  const field = (name: "et" | "ru") => ({
    label: name === "et" ? t.nameEt : t.nameRu,
    labelHidden: true,
    value: String(row.text(name) ?? ""),
    onChange: (v: string) => row.type(name, v),
    error: errorText(row.codeOf(name)),
    name: `${part}.${name}`,
    maxLength: AREA_LIMITS.name,
    className: name === "et" ? styles.et : styles.ru,
  });
  const used = area.used > 0;

  return (
    <div className={styles.row} data-area={area.id} onBlur={() => void row.flush()}>
      <div className={styles.grid}>
        <span className={styles.handle}>{handle}</span>
        <TextField {...field("et")} />
        <TextField {...field("ru")} />
        <span id={usedId} className={styles.use} data-area-used="">
          {usedLine(area.used)}
        </span>
        <span className={styles.arrows}>{arrows}</span>
        <span className={styles.del}>
          <button
            ref={opener}
            type="button"
            className={`${ui.btn} ${ui.danger} ${ui.smallBtn} ${ui.held}`}
            aria-disabled={used || undefined}
            aria-describedby={used ? `${usedId} ${ruleId}` : undefined}
            aria-expanded={used ? undefined : asking}
            onClick={() => {
              if (!used) setAsking(true);
            }}
            data-area-delete=""
          >
            {t.remove}
          </button>
        </span>
      </div>
      {row.conflict !== null && (
        <p className={styles.line}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => void row.restore()} data-area-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
      {asking && !used && (
        <ConfirmPanel
          question={fill(t.removeQuestion, { name: et.trim() || area.name.et })}
          yesLabel={t.removeYes}
          tone="danger"
          busy={busy}
          onYes={() => onDelete(row.discardCopy)}
          onCancel={() => {
            refocus.current = true;
            setAsking(false);
          }}
        />
      )}
      {error && (
        <p role="alert" className={`${ui.error} ${styles.line}`} data-area-error="">
          {error}
        </p>
      )}
    </div>
  );
}

/** The dashed add row at the end: the two names and „Lisa valdkond +“; emptied once the area is there, the route's words at a name it refused. */
function AddArea({ busy, onAdd }: { busy: boolean; onAdd: (name: { et: string; ru: string }) => Promise<Record<string, string> | "failed" | null> }) {
  const uid = useId();
  const [name, setName] = useState({ et: "", ru: "" });
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const field = (lang: "et" | "ru") => ({
    label: lang === "et" ? t.newEt : t.newRu,
    labelHidden: true,
    placeholder: lang === "et" ? t.newTitle : t.newRuPlaceholder,
    value: name[lang],
    onChange: (v: string) => {
      setName((n) => ({ ...n, [lang]: v }));
      // (typed again: its words go until the next press)
      setCodes((c) => Object.fromEntries(Object.entries(c).filter(([f]) => f !== lang)));
    },
    error: errorText(codes[lang]),
    name: `area-new.${lang}`,
    maxLength: AREA_LIMITS.name,
    className: lang === "et" ? styles.et : styles.ru,
  });
  return (
    <form
      className={`${styles.row} ${styles.add}`}
      aria-labelledby={`${uid}-title`}
      noValidate
      data-area-add=""
      data-add-row=""
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        // the browser's own check first (the server's rule): an empty or too long name is said at once, nothing sent
        const own = areaNameProblems(name);
        if (Object.keys(own).length > 0) return setCodes(own);
        setFailed(null);
        void onAdd(name).then((refused) => {
          if (refused === null) {
            setName({ et: "", ru: "" });
            setCodes({});
          } else if (refused === "failed") setFailed(adminEt.common.saveError);
          else setCodes(refused);
        });
      }}
    >
      <h3 id={`${uid}-title`} className={ui.sr}>
        {t.newTitle}
      </h3>
      <div className={styles.grid}>
        <TextField {...field("et")} />
        <TextField {...field("ru")} />
        <span className={styles.addGo}>
          <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={busy || undefined}>
            {busy ? adminEt.common.saving : t.add}
          </button>
        </span>
      </div>
      {failed && (
        <p role="alert" className={`${ui.error} ${styles.line}`}>
          {failed}
        </p>
      )}
    </form>
  );
}

/**
 * „Valdkonnad“ (see the top of the file): `initial`, the list as the page read it (server/course-areas.ts readAdminAreas); `onStatus`, the page's one
 * SaveStatus.
 */
export function AreasSettings({ initial, onStatus }: { initial: AdminArea[]; onStatus?: StatusReport }) {
  const uid = useId();
  const [areas, setAreas] = useState(initial);
  const [busy, setBusy] = useState(false);
  const pressing = useRef(false);
  const [rowError, setRowError] = useState<{ id: number; text: string } | null>(null);
  /** Each row's Estonian name as its field has it now (typed, not yet read back). */
  const [names, setNames] = useState<Record<number, string>>({});
  const nameOf = useCallback((id: number, name: string) => setNames((all) => (all[id] === name ? all : { ...all, [id]: name })), []);

  /** One press at a time: the chip says „Salvestan…“ until its answer; null while another is on its way. */
  const press = async (url: string, body: object): Promise<JsonAnswer | null> => {
    if (pressing.current) return null;
    pressing.current = true;
    setBusy(true);
    onStatus?.("areas", SAVING);
    try {
      return await sendJson(url, body);
    } finally {
      pressing.current = false;
      setBusy(false);
    }
  };

  const move = (from: number, to: number) => {
    if (pressing.current) return;
    const id = areas[from].id;
    const before = areas;
    setRowError(null);
    setAreas(reorder(areas, from, to));
    void press(`/api/admin/valdkond/${id}/liiguta`, { index: to }).then((answer) => {
      const list = answer?.status === 200 ? areasOf(answer) : null;
      onStatus?.("areas", over(list !== null));
      if (list) return setAreas(list);
      setAreas(before);
      setRowError({ id, text: answer?.status === 401 ? pressFailedLine(true) : adminEt.courses.moveError });
    });
  };

  const remove = (id: number, discardCopy: () => void) => {
    setRowError(null);
    void press(`/api/admin/valdkond/${id}/kustuta`, {}).then((answer) => {
      if (!answer) return;
      const list = areasOf(answer);
      onStatus?.("areas", over(answer.status === 200 && list !== null));
      if (answer.status === 200 && list) {
        discardCopy();
        setAreas(list);
        // its row is gone: the focus goes to the field for a new one (as a deleted module's, LessonsEditor.tsx)
        return void requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-field="area-new.et"]')?.focus());
      }
      // used meanwhile: the list says by how many (the row's line in place of „Kustuta“); gone meanwhile: the row's words
      if (answer.status === 409 && list) return setAreas(list);
      setRowError({ id, text: answer.status === 404 ? t.errors.notFound : pressFailedLine(answer.status === 401) });
    });
  };

  const add = async (name: { et: string; ru: string }): Promise<Record<string, string> | "failed" | null> => {
    setRowError(null);
    const answer = await press("/api/admin/valdkond/uus", name);
    if (!answer) return "failed";
    const list = areasOf(answer);
    onStatus?.("areas", over(answer.status === 200 && list !== null));
    if (answer.status === 200 && list) {
      setAreas(list);
      return null;
    }
    const fields = answer.data.fields;
    if (answer.status === 400 && typeof fields === "object" && fields !== null) return fields as Record<string, string>;
    return "failed";
  };

  return (
    <section className={ui.card} aria-labelledby={`${uid}-title`} data-areas-card="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {t.title}
      </h2>
      <p className={`${ui.muted} ${site.cardLead}`}>{t.lead}</p>
      <div className={styles.list}>
        {areas.length === 0 ? (
          <p className={`${ui.muted} ${styles.empty}`}>{t.empty}</p>
        ) : (
          <>
            {/* (each field keeps its own name for a screen reader: the labels are said once, over the columns) */}
            <div className={`${styles.grid} ${styles.columns}`} aria-hidden="true" data-area-columns="">
              <span className={styles.et}>{t.nameEt}</span>
              <span className={styles.ru}>{t.nameRu}</span>
            </div>
            <DragList<AdminArea>
              items={areas}
              keyOf={(a) => String(a.id)}
              label={(a) => names[a.id] ?? a.name.et}
              onMove={move}
              className={styles.rows}
              rowClassName={styles.item}
              renderRow={(a, _i, handle, arrows) => (
                <AreaRow
                  area={a}
                  handle={handle}
                  arrows={arrows}
                  onStatus={onStatus}
                  onName={nameOf}
                  error={rowError?.id === a.id ? rowError.text : null}
                  busy={busy}
                  onDelete={(discardCopy) => remove(a.id, discardCopy)}
                  ruleId={`${uid}-rule`}
                />
              )}
            />
          </>
        )}
        <AddArea busy={busy} onAdd={add} />
        {areas.length > 0 && (
          <p id={`${uid}-rule`} className={`${ui.hint} ${styles.rule}`} data-area-rule="">
            {t.rule}
          </p>
        )}
      </div>
    </section>
  );
}
