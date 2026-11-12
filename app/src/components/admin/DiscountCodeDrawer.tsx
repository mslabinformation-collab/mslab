"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import {
  CEILING_FIELDS,
  changedCodeFields,
  CODE_FIELDS,
  codeFieldProblems,
  discountGiven,
  normalizedValue,
  emptyCodeFields,
  highestListCents,
  type CodeField,
  type CodeFieldError,
  type CodeFields,
} from "@/domain/discount-code-fields";
import { formatEUR } from "@/domain/money";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate } from "@/i18n/format";
import { createCodeAction, deleteCodeAction, setCodeActiveAction } from "@/server/actions/admin-discounts";
import type { CodeCourse, CodeUse, CodeValue } from "@/server/discount-code-admin";
import { SAVE_TIMEOUT_MS } from "./autosave/constants";
import { patchSender, type Fields, type SendPatch } from "./autosave/engine";
import { useAutosave } from "./autosave/useAutosave";
import { Choice } from "./Choice";
import { ConfirmPanel } from "./ConfirmPanel";
import { PillChoice } from "./PillChoice";
import { SaveStatus, StatusLine } from "./SaveStatus";
import { Switch } from "./Switch";
import { useUndo } from "./UndoBar";
import { focusFormField, useNewRecord } from "./useNewRecord";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./DiscountCodeDrawer.module.css";

// The Sooduskoodid drawer (F1 Task 13, spec §4.10 and §5; Dim's approved canvas „Haldus-paneel“; the page is app/admin/(panel)/sooduskoodid). Two drawers, as
// the Kalender's (SessionForm.tsx):
// - DiscountCodeDrawer, a stored code (?kood=<id>), top to bottom: the chip (SaveStatus, left of the drawer's ✕), the code in Jost 28 with the switch
//   „Aktiivne“ — instant, with the UndoBar „Sooduskood peatatud.“ (CampaignEditor.tsx's pattern: the press flips at once, rolls back when the server refuses, and
//   „Võta tagasi“ switches it on again from the version the pause left) —, the fields, autosaved on POST /api/admin/sooduskood/<id> (server/discount-code-admin.ts
//   writeCode; useAutosave), „Kasutused ({n}) · Soodustust kokku: {amount}“ (R20: the sum of the uses that count) and last „Kustuta sooduskood“ behind a
//   ConfirmPanel — only while the code has no use at all —, else the line „Koodi on kasutatud — kustutada ei saa. Peata see.“ (R19: when none of the uses counts,
//   „… tühistatud või pooleli jäänud tellimustel …“ instead, so „Kasutatud 0“ never contradicts it).
// - NewDiscountCode (?kood=uus, or ?kood=tervituskood for the welcome row, R11): the same fields, no switch, no uses; the one explicit „Lisa sooduskood“ creates it
//   (createCodeAction) and the drawer goes on at ?kood=<n>&lisatud=<n>, autosaving. Typed and not created: leaving asks („Sooduskoodi pole veel lisatud.“) and the
//   typed text stays in this browser until the next visit (useNewRecord).
// The value (R17): Protsent | Eurod empties the field of the kind switched to, and the kind is saved only together with a valid value (the screen holds the kind
// back with its value: clicking the choice alone sends nothing); switching back to the stored kind brings its stored value back. The same holding together:
// the scope with its chosen courses, the two days, and R18's ceiling (a euro amount above the highest list price in scope: the amount, the kind and the scope
// wait together). The client's checks are the server's own rules (domain/discount-code-fields.ts), never a copy.

const t = adminEt.discounts;
const e = adminEt.courseEditor.errors;

/** The engines' copies in this browser: `mslab-draft:sooduskood:<id>:<tab>`. */
const OWNER = "sooduskood";
/** This browser's copy of a new code typed and not created yet (one per browser and kind; dropped once it is created). */
export const NEW_CODE_COPY = "mslab-draft:sooduskood:uus";
export const NEW_WELCOME_COPY = "mslab-draft:sooduskood:tervituskood";

/** The visible names of the fields (the leave guard's notice and SaveStatus's „Näita“ name them). */
const LABELS: Record<CodeField, string> = {
  code: t.form.code,
  kind: t.form.value,
  percent: t.form.valuePercent,
  amount: t.form.valueEuro,
  scope: t.form.scope,
  courseIds: t.form.courses,
  startsOn: t.form.startsOn,
  endsOn: t.form.endsOn,
  maxUses: t.form.maxUses,
  audience: t.form.audience,
  oncePerPerson: t.form.oncePerPerson,
  daysAfterSignup: t.form.days,
  note: t.form.note,
};
const labelOf = (field: string): string => LABELS[field as CodeField] ?? field;

/** A refused field's words, and the id of the code that has the text when it is `codeTaken:<id>` (R20: the field then says „Ava see kood“). */
type Words = { text: string; takenId?: number };
function wordsOf(code: string): Words {
  const taken = /^codeTaken:(\d{1,10})$/.exec(code);
  if (taken) return { text: e.codeTaken, takenId: Number(taken[1]) };
  const words = (e as Record<string, string>)[code];
  return { text: words === undefined ? adminEt.courseEditor.invalid : words };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const codeHref = (id: number) => `/admin/sooduskoodid?kood=${id}`;

/** The drawer's field `name` (the first in the open drawer's form, else any): SaveStatus's „Näita“ and the guard's „Jää siia“. */
const focusField = (name: string): void => focusFormField("[data-code-form]", name);

/**
 * The problems of `v` as the server finds them (domain/discount-code-fields.ts), as the autosave's `validate` holds fields back: the value's and the courses'
 * problems hold the kind and the scope with them (the kind is saved only together with a valid value, R17), the ceiling holds the euros, the kind and the
 * scope together (R18), the dates' order holds both days. `stored`: the code as the page read it: the ceiling is looked at only when the kind, the euros or
 * the scope are changed (a price that fell later stops no note from saving).
 */
function problemsOf(v: CodeFields, stored: CodeFields | null, at: { welcome: boolean; courses: readonly CodeCourse[] }): Partial<Record<CodeField, CodeFieldError>> {
  const matters = stored === null || changedCodeFields(v, stored).some((f) => CEILING_FIELDS.includes(f));
  const highestCents = matters ? highestListCents(v.scope, v.courseIds, at.courses) : null;
  return codeFieldProblems(v, { welcome: at.welcome, highestCents });
}

/** The fields a save must hold back together with the ones refused (`problems`), by the pairs above. */
function heldWith(problems: Partial<Record<CodeField, CodeFieldError>>): Record<string, string> {
  const out: Record<string, string> = { ...(problems as Record<string, string>) };
  if (problems.percent) out.kind ??= problems.percent;
  if (problems.amount) out.kind ??= problems.amount;
  if (problems.courseIds) out.scope ??= problems.courseIds;
  if (problems.amount === "amountTooHigh") {
    out.scope ??= problems.amount;
    out.courseIds ??= problems.amount;
  }
  if (problems.endsOn === "endBeforeStart") out.startsOn ??= problems.endsOn;
  return out;
}

// ---------- the fields (both drawers) ----------

type FieldView = {
  fields: CodeFields;
  welcome: boolean;
  /** The code has a use: its text cannot change (the field says so). */
  used: boolean;
  /** A used code: „Muudatus kehtib uutele registreeringutele ja ostudele.“ under its value. */
  valueNote: boolean;
  courses: readonly CodeCourse[];
  set: (f: CodeField, value: unknown) => void;
  chooseKind: (kind: "percent" | "euro") => void;
  chooseScope: (scope: CodeFields["scope"]) => void;
  chooseAudience: (audience: CodeFields["audience"]) => void;
  /** A field left (any field: the form's focusout). */
  onLeave: () => void;
  error: (f: CodeField) => Words | undefined;
  /** Nothing can be typed (a new code's create on its way). */
  busy?: boolean;
};

/**
 * The code's fields in the canvas's order: Kood, Soodustus (Protsent | Eurod over its field), Kehtib (its pills, and the courses' checklist for „Valitud
 * koolitustele“), Algab | Lõpeb, Kasutuskordi kokku, Kellele, Üks kord inimese kohta, the welcome row's days and fixed rules, Märkus. Each field's words under
 * it, named by aria-describedby: its hint and its error.
 */
function CodeFieldList({ view }: { view: FieldView }) {
  const uid = useId();
  const id = (f: string) => `${uid}-${f}`;
  const f = view.fields;
  const error = (field: CodeField) => {
    const words = view.error(field);
    if (!words) return null;
    return (
      <p id={id(`${field}-error`)} className={ui.error} data-field-error={field}>
        {words.text}
        {words.takenId !== undefined && (
          <>
            {" "}
            <Link className={styles.takenLink} href={codeHref(words.takenId)} scroll={false} data-open-taken="">
              {t.form.openTaken}
            </Link>
          </>
        )}
      </p>
    );
  };
  const describedBy = (field: CodeField, hint?: boolean) => [hint && id(`${field}-hint`), view.error(field) && id(`${field}-error`)].filter(Boolean).join(" ") || undefined;
  const text = (field: CodeField, label: string, input: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {}, hint?: string) => (
    <div className={ui.field} data-field={field}>
      <label htmlFor={id(field)}>{label}</label>
      <input
        id={id(field)}
        name={field}
        className={ui.input}
        autoComplete="off"
        value={String(f[field])}
        readOnly={view.busy || undefined}
        onChange={(ev) => view.set(field, ev.target.value)}
        aria-invalid={view.error(field) ? true : undefined}
        aria-describedby={describedBy(field, hint !== undefined)}
        {...input}
      />
      {hint !== undefined && (
        <p id={id(`${field}-hint`)} className={ui.hint}>
          {hint}
        </p>
      )}
      {error(field)}
    </div>
  );
  const valueField: CodeField = f.kind === "percent" ? "percent" : "amount";
  const scopes = (["all", "ecourse", "contact", "courses"] as const).map((s) => ({ value: s, label: t.scope[s] }));
  const audiences = (["all", "first", "returning"] as const).map((a) => ({ value: a, label: t.form.audiences[a] }));
  return (
    <div className={styles.fields} onBlur={view.onLeave} aria-busy={view.busy || undefined} data-code-form="">
      <div className={ui.field} data-field="code">
        <label htmlFor={id("code")}>{t.form.code}</label>
        <input
          id={id("code")}
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={60}
          value={f.code}
          disabled={view.used}
          readOnly={view.busy || undefined}
          onChange={(ev) => view.set("code", ev.target.value)}
          aria-invalid={view.error("code") ? true : undefined}
          aria-describedby={describedBy("code", true)}
          className={view.used ? `${ui.input} ${styles.locked}` : ui.input}
        />
        <p id={id("code-hint")} className={ui.hint} data-code-hint="">
          {view.used ? t.form.codeUsedHint : view.welcome ? `${t.form.codeHint} ${t.form.codeWelcomeHint}` : t.form.codeHint}
        </p>
        {error("code")}
      </div>

      <div className={styles.group} data-field="kind">
        <span className={styles.name}>{t.form.value}</span>
        <PillChoice
          name={`${uid}-kind`}
          legend={t.form.value}
          options={[
            { value: "percent", label: t.form.percent },
            { value: "euro", label: t.form.euro },
          ]}
          value={f.kind}
          onChange={(k) => view.chooseKind(k as "percent" | "euro")}
          disabled={view.busy}
        />
        <div className={ui.field} data-field={valueField}>
          <label htmlFor={id(valueField)} className={styles.sub}>
            {f.kind === "percent" ? t.form.valuePercent : t.form.valueEuro}
          </label>
          <input
            id={id(valueField)}
            name={valueField}
            className={`${ui.input} ${styles.short}`}
            autoComplete="off"
            inputMode={f.kind === "percent" ? "numeric" : "decimal"}
            maxLength={f.kind === "percent" ? 3 : 12}
            value={String(f[valueField])}
            readOnly={view.busy || undefined}
            onChange={(ev) => view.set(valueField, ev.target.value)}
            aria-invalid={view.error(valueField) ? true : undefined}
            aria-describedby={describedBy(valueField, true)}
          />
          <p id={id(`${valueField}-hint`)} className={ui.hint}>
            {[f.kind === "euro" ? t.form.euroHint : null, view.valueNote ? t.form.valueChanged : null].filter(Boolean).join(" ") || " "}
          </p>
          {error(valueField)}
        </div>
      </div>

      <div className={styles.group} data-field="scope">
        <span className={styles.name}>{t.form.scope}</span>
        <PillChoice name={`${uid}-scope`} legend={t.form.scope} options={scopes} value={f.scope} onChange={(s) => view.chooseScope(s as CodeFields["scope"])} disabled={view.busy} />
        {f.scope === "courses" && (
          <fieldset className={styles.courses} data-field="courseIds" data-code-courses="" aria-describedby={describedBy("courseIds")}>
            <legend>{t.form.courses}</legend>
            {view.courses.length === 0 && <p className={ui.hint}>{t.form.noCourses}</p>}
            {view.courses.map((c) => (
              <Choice
                key={c.id}
                className={ed.check}
                type="checkbox"
                name="courseIds"
                value={c.id}
                checked={f.courseIds.includes(c.id)}
                disabled={view.busy}
                onChange={(ev) => view.set("courseIds", ev.target.checked ? [...f.courseIds, c.id].sort((a, b) => a - b) : f.courseIds.filter((x) => x !== c.id))}
                label={c.title}
              />
            ))}
          </fieldset>
        )}
        {error("courseIds")}
      </div>

      <div className={styles.group}>
        <div className={styles.pair} data-pair="">
          {text("startsOn", t.form.startsOn, { type: "date", className: `${ui.input} ${ed.dateTime}` })}
          {text("endsOn", t.form.endsOn, { type: "date", className: `${ui.input} ${ed.dateTime}` })}
        </div>
        <p className={ui.hint}>{t.form.dates}</p>
      </div>

      {text("maxUses", t.form.maxUses, { inputMode: "numeric", maxLength: 7, className: `${ui.input} ${styles.short}` }, t.form.maxUsesHint)}

      {view.welcome ? (
        <>
          {text("daysAfterSignup", t.form.days, { inputMode: "numeric", maxLength: 3, className: `${ui.input} ${styles.short}` }, t.form.daysHint)}
          <p className={styles.fixed} data-welcome-rules="">
            {t.form.welcomeRules}
          </p>
        </>
      ) : (
        <>
          <div className={styles.group} data-field="audience">
            <span className={styles.name}>{t.form.audience}</span>
            <PillChoice name={`${uid}-audience`} legend={t.form.audience} options={audiences} value={f.audience} onChange={(a) => view.chooseAudience(a as CodeFields["audience"])} disabled={view.busy} />
          </div>
          <div className={styles.group} data-field="oncePerPerson">
            <Choice
              className={ed.check}
              type="checkbox"
              name="oncePerPerson"
              checked={f.oncePerPerson}
              disabled={view.busy}
              onChange={(ev) => view.set("oncePerPerson", ev.target.checked)}
              label={t.form.oncePerPerson}
              hint={t.form.oncePerPersonHint}
              hintClassName={ui.hint}
            />
          </div>
        </>
      )}

      <div className={ui.field} data-field="note">
        <label htmlFor={id("note")}>{t.form.note}</label>
        <textarea
          id={id("note")}
          name="note"
          className={ui.textarea}
          rows={2}
          value={f.note}
          readOnly={view.busy || undefined}
          onChange={(ev) => view.set("note", ev.target.value)}
          aria-invalid={view.error("note") ? true : undefined}
          aria-describedby={describedBy("note", true)}
        />
        <p id={id("note-hint")} className={ui.hint}>
          {t.form.noteHint}
        </p>
        {error("note")}
      </div>
    </div>
  );
}

/** What the choice of a kind does to the fields (R17): the value of the kind switched to is emptied; `stored` brings the stored value back for the stored kind. */
function kindFields(kind: "percent" | "euro", storedKind: "percent" | "euro", stored: { percent: string; amount: string }): Partial<CodeFields> {
  const field = kind === "percent" ? "percent" : "amount";
  return { kind, [field]: kind === storedKind ? stored[field] : "" };
}

// ---------- a stored code ----------

type DrawerProps = {
  id: number;
  /** The code's version as the page read it (server/discount-code-admin.ts readCode: its fields, its courses and its switch). */
  version: string;
  /** The code as stored (readCode's value): its fields as typed, the switch, whether it is the welcome row, whether any use exists. */
  value: CodeValue;
  /** Every course, for the checklist and R18's ceiling. */
  courses: readonly CodeCourse[];
  /** Its uses, newest first (codeUses). */
  uses: readonly CodeUse[];
  /** The list's address (the delete goes back to it). */
  listHref: string;
  /** Just created by „Lisa sooduskood“ (?lisatud=<n>): „Sooduskood lisatud.“ at the top. */
  added?: boolean;
};

/** The versions the drawer knows (as SessionForm's: one version for the fields and the switch). */
type Versions = { known: string; same: Set<string> };

/** An action's answer within SAVE_TIMEOUT_MS, or null (late: its answer is still taken when it comes). */
async function bounded<R>(call: Promise<R>): Promise<R | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SAVE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The fields of a stored value (without the switch and the flags). */
function fieldsOf(v: CodeValue): CodeFields {
  return {
    code: v.code,
    kind: v.kind,
    percent: v.percent,
    amount: v.amount,
    scope: v.scope,
    courseIds: v.courseIds,
    startsOn: v.startsOn,
    endsOn: v.endsOn,
    maxUses: v.maxUses,
    audience: v.audience,
    oncePerPerson: v.oncePerPerson,
    daysAfterSignup: v.daysAfterSignup,
    note: v.note,
  };
}

export function DiscountCodeDrawer(p: DrawerProps) {
  const router = useRouter();
  const nav = useRef(router);
  const stored = useMemo(() => fieldsOf(p.value), [p.value]);
  /** The page's latest read: the field check reads it, as the server checks against the row as it is. */
  const live = useRef({ stored, courses: p.courses, welcome: p.value.welcome });
  useLayoutEffect(() => {
    nav.current = router;
    live.current = { stored, courses: p.courses, welcome: p.value.welcome };
  });
  const versions = useRef<Versions>({ known: p.version, same: new Set([p.version]) });
  /** The switch's action on its way (until its answer, at most SAVE_TIMEOUT_MS): a field save waits for it, then goes from the version it left. */
  const flight = useRef<Promise<void> | null>(null);
  /** The route's refusal codes (400) by field, until the field is typed in again or saved. */
  const [refused, setRefused] = useState<Partial<Record<CodeField, string>>>({});
  /** The switch met another tab's change: the chip says so until the next save. */
  const [switchConflict, setSwitchConflict] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  /** The form's fields and its `adopt` as of the newest render, for the save (which runs after renders; the engine is made after it). */
  const latest = useRef<CodeFields>(stored);
  const adopt = useRef<(name: string, value: unknown) => boolean>(() => false);
  /** The adoptions waiting for the engine to take a save's answer (below): cleared when the drawer goes (P27). */
  const adoptions = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const waiting = adoptions.current;
    return () => {
      for (const timer of waiting) clearTimeout(timer);
      waiting.clear();
    };
  }, []);
  const save = useMemo<SendPatch>(() => {
    const base = patchSender(`/api/admin/sooduskood/${p.id}`);
    return async (body, opts) => {
      // (a field typed while the switch saves: after it, so the two never cross on the server and make a conflict of their own)
      const waiting = flight.current;
      if (waiting) await waiting;
      const v = versions.current;
      const version = v.same.has(body.version) ? v.known : body.version;
      // I-1: a kind goes with its value, always (the engine may think the value confirmed while the server cleared it when the kind last changed: the server
      // checks the stored row merged with the patch, and a kind alone would meet the empty value). The value the engine sent with it first (P27: a text typed
      // while this save waited for the switch is the engine's next save, not this one's), else the field as it is now.
      const kind = body.patch.kind;
      const valueField = kind === "percent" ? "percent" : kind === "euro" ? "amount" : null;
      const patch: Fields = valueField ? { ...body.patch, [valueField]: body.patch[valueField] ?? latest.current[valueField] } : body.patch;
      const answer = await base({ ...body, patch, version }, opts);
      const reply = answer && isRecord(answer.body) ? answer.body : null;
      if (answer?.status === 200 && reply?.ok === true && typeof reply.version === "string") {
        versions.current = { known: reply.version, same: new Set([reply.version]) };
        // after a save that changed the kind the server holds no value for the other one: the engine takes that as confirmed (nothing is sent for it); and
        // every field saved is taken over as the server stores it (M-3), unless it was typed in again meanwhile (adopt's own rule)
        const taken: [string, unknown][] = [];
        if (kind === "percent" || kind === "euro") taken.push([kind === "percent" ? "amount" : "percent", ""]);
        for (const [name, value] of Object.entries(patch)) {
          const norm = normalizedValue(name as CodeField, value);
          if (norm !== value) taken.push([name, norm]);
        }
        // (after the engine has taken this answer: a field it has just sent is not yet its confirmed text before that)
        if (taken.length > 0) {
          const timer = setTimeout(() => {
            adoptions.current.delete(timer);
            taken.forEach(([name, value]) => adopt.current(name, value));
          }, 0);
          adoptions.current.add(timer);
        }
        setRefused({});
        setSwitchConflict(false);
        if (reply.version !== version) startTransition(() => nav.current.refresh());
      } else if (answer?.status === 409 && reply?.error === "conflict" && typeof reply.version === "string") {
        versions.current = { known: reply.version, same: new Set([reply.version]) };
      } else if (answer?.status === 400 && reply?.error === "invalid" && isRecord(reply.fields)) {
        const codes: Partial<Record<CodeField, string>> = {};
        for (const f of CODE_FIELDS) if (typeof reply.fields[f] === "string") codes[f] = reply.fields[f] as string;
        setRefused(codes);
        // a refusal by the code as it is now (a use written meanwhile: the text is locked): the page is read again
        startTransition(() => nav.current.refresh());
      }
      return answer;
    };
  }, [p.id]);
  const validate = useCallback(
    (f: Fields): Record<string, string> => heldWith(problemsOf(f as CodeFields, live.current.stored, { welcome: live.current.welcome, courses: live.current.courses })),
    [],
  );
  const auto = useAutosave({ owner: OWNER, key: String(p.id), version: p.version, fields: { ...stored }, save, validate, label: labelOf, focusField });
  const { setField, flush, restore } = auto;
  const fields = auto.fields as CodeFields;
  useLayoutEffect(() => {
    latest.current = fields;
    adopt.current = auto.adopt;
  });

  const held = auto.status.kind === "invalid";
  const local = problemsOf(fields, stored, { welcome: p.value.welcome, courses: p.courses });
  const codeOf = (f: CodeField): string | undefined => (held ? (local[f] ?? refused[f]) : undefined);

  const view: FieldView = {
    fields,
    welcome: p.value.welcome,
    // (T13-3: the welcome row's text stays changeable whatever its uses: the lock is for the other codes)
    used: p.value.used && !p.value.welcome,
    valueNote: p.value.used,
    courses: p.courses,
    set: (f, value) => {
      setRefused((r) => (r[f] ? { ...r, [f]: undefined } : r));
      setField(f, value);
    },
    chooseKind: (kind) => {
      if (kind === fields.kind) return;
      // R17: the value of the kind switched to is empty (the stored one again for the stored kind); nothing is sent until it is valid
      const next = kindFields(kind, stored.kind, { percent: auto.confirmedValue("percent") as string, amount: auto.confirmedValue("amount") as string });
      setRefused((r) => ({ ...r, kind: undefined, percent: undefined, amount: undefined }));
      for (const [k, v] of Object.entries(next)) setField(k, v);
      void flush();
    },
    chooseScope: (scope) => {
      if (scope === fields.scope) return;
      setRefused((r) => ({ ...r, scope: undefined, courseIds: undefined, amount: undefined }));
      setField("scope", scope);
      // (the chosen courses belong to „Valitud koolitustele“ alone: the server keeps none for another scope)
      if (scope !== "courses") setField("courseIds", []);
      void flush();
    },
    chooseAudience: (audience) => {
      setField("audience", audience);
      void flush();
    },
    onLeave: () => void flush(),
    error: (f) => {
      const code = codeOf(f);
      return code === undefined ? undefined : wordsOf(code);
    },
  };
  const showInvalid = () => focusField(CODE_FIELDS.find((f) => codeOf(f) !== undefined || (held && local[f] !== undefined)) ?? "code");

  const sw = useSwitch(p, versions, flight, flush, setSwitchConflict, setSavedAt);
  // one chip for the drawer (README §1.4): the switch is one of its saves (an instant field)
  const chip: AutosaveStatus = sw.pending
    ? { kind: "saving" }
    : switchConflict
      ? { kind: "conflict" }
      : auto.status.kind === "saved" && savedAt && (!auto.status.at || savedAt > auto.status.at)
        ? { kind: "saved", at: savedAt }
        : auto.status;

  const given = discountGiven(p.uses);
  const counting = p.uses.some((u) => u.mark === "counts");
  return (
    <div className={styles.drawer} data-code-drawer={p.id}>
      <header className={styles.head} data-code-head="">
        <div className={styles.chipRow}>
          <SaveStatus status={chip} thing={t.drawer.thing} onShowInvalid={showInvalid} />
        </div>
        <div className={styles.titleRow}>
          <h2 className={`${ui.h2} ${styles.title}`}>
            <span data-code-title="">{p.value.code}</span>
            {p.value.welcome && <span className={`${ui.tag} ${styles.neutral}`}>{t.welcomeTag}</span>}
          </h2>
          <div className={styles.switch}>
            <Switch label={t.form.active} checked={sw.shown} onChange={sw.press} describedBy={sw.line ? sw.lineId : undefined} data-code-switch="" />
          </div>
        </div>
        {sw.line && (
          <p id={sw.lineId} role="alert" className={ui.error} data-switch-error="">
            {sw.line}
          </p>
        )}
      </header>
      {p.added && (
        <p className={`${ui.notice} ${styles.notice}`} role="status" data-flash="added">
          {t.added}
        </p>
      )}
      <CodeFieldList view={view} />
      {auto.conflict && (
        <p className={styles.restore}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => void restore()} data-code-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
      <section className={styles.uses} data-code-uses="">
        <h3 className={`${ui.h3} ${styles.usesTitle}`}>
          {fill(t.uses.title, { n: p.uses.length })}
          {p.uses.length > 0 && <span data-uses-total=""> · {fill(t.uses.total, { amount: formatEUR(given, "et") })}</span>}
        </h3>
        {p.uses.length === 0 && <p className={ui.hint}>{t.uses.none}</p>}
        {p.uses.map((u) => (
          <UseRow key={u.id} use={u} />
        ))}
      </section>
      <CodeDelete id={p.id} code={p.value.code} used={p.value.used} counting={counting} listHref={p.listHref} />
    </div>
  );
}

/** One use: the day, the name (a link to its registration or payment) over the course, and the −sum with the marks that say why it does not count. */
function UseRow({ use }: { use: CodeUse }) {
  const marks = [use.mark !== "counts" ? t.uses.marks[use.mark] : null, use.via === "admin" ? t.uses.marks.admin : null].filter((m): m is string => m !== null);
  const who = (
    <>
      <span>{use.name}</span>
      <span className={styles.useCourse}>{use.course}</span>
    </>
  );
  return (
    <div className={styles.use} data-code-use={use.id} data-use-mark={use.mark}>
      <span>{formatDate(use.at, "et")}</span>
      {use.href !== null ? (
        <Link className={styles.useWho} href={use.href}>
          {who}
        </Link>
      ) : (
        <span className={styles.useWho}>{who}</span>
      )}
      <span className={styles.useSum}>
        <span>−{formatEUR(use.cents, "et")}</span>
        {marks.map((m) => (
          <span key={m} className={styles.mark} data-use-tag="">
            {m}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * „Aktiivne“, instant (CampaignEditor.tsx's pattern): the press flips the switch at once and sends `{ id, active, version }` (setCodeActiveAction) from the version
 * after the fields' waiting save; refused (stale: another tab saved first; a failure), it rolls back and says so (stale is the chip's „Muudeti teises aknas —
 * vaata üle“ and the page is read again). Off: the UndoBar „Sooduskood peatatud.“, whose „Võta tagasi“ switches it on again from the version the pause left; on:
 * no bar (it is its own reverse). Bounded by SAVE_TIMEOUT_MS: a late answer says „Salvestamine ei õnnestunud. Proovi uuesti.“ and is still taken when it comes.
 */
function useSwitch(
  p: DrawerProps,
  versionsRef: React.RefObject<Versions>,
  flightRef: React.RefObject<Promise<void> | null>,
  flush: () => Promise<boolean>,
  setConflict: (on: boolean) => void,
  setSavedAt: (at: Date) => void,
) {
  const router = useRouter();
  const undo = useUndo();
  const lineId = useId();
  const [pending, start] = useTransition();
  const [asked, setAsked] = useState<boolean | null>(null);
  const [line, setLine] = useState<string | null>(null);
  /** The state the action stored, over the page's `over` (until the page's read moves). */
  const [said, setSaid] = useState<{ active: boolean; over: boolean } | null>(null);
  if (said && p.value.active !== said.over) setSaid(null);
  const stored = said?.active ?? p.value.active;
  const shown = asked ?? stored;
  /** The page's switch as of now, for the undo (which runs after renders). */
  const now = useRef({ stored, router });
  useEffect(() => {
    now.current = { stored, router };
  });

  /** Sends one press; true when it went through. `fromUndo`: no bar and no line (the bar says its own failure). */
  const send = async (on: boolean, fromUndo: boolean): Promise<boolean | string> => {
    await flush();
    const from = versionsRef.current.known;
    let land = () => {};
    flightRef.current = new Promise<void>((resolve) => (land = resolve));
    const call = (async () => {
      try {
        return await setCodeActiveAction({ id: p.id, active: on, version: from });
      } catch {
        return { ok: false as const, error: "server" as const };
      }
    })();
    const result = await bounded(call);
    const take = (r: Awaited<typeof call>) => {
      if (r.ok) {
        const same = versionsRef.current.known === from ? versionsRef.current.same : new Set<string>();
        versionsRef.current = { known: r.version, same: new Set([...same, r.version]) };
      } else if (r.error === "stale") versionsRef.current = { known: "", same: new Set() };
    };
    if (result === null) {
      // late: said not saved for now; the answer still counts when it comes
      void call.then((r) => {
        take(r);
        if (r.ok) {
          setSaid({ active: on, over: now.current.stored });
          setSavedAt(new Date());
          setLine(null);
          startTransition(() => now.current.router.refresh());
        }
      });
    } else take(result);
    flightRef.current = null;
    land();
    if (result?.ok) {
      setLine(null);
      setConflict(false);
      setSavedAt(new Date());
      setSaid({ active: on, over: now.current.stored });
      startTransition(() => now.current.router.refresh());
      return true;
    }
    if (result && !result.ok && result.error === "stale") {
      setConflict(true);
      startTransition(() => now.current.router.refresh());
      return fromUndo ? adminEt.autosave.conflict : false;
    }
    const words = result && !result.ok && result.error === "notFound" ? t.drawer.notFound : adminEt.common.saveError;
    if (!fromUndo) setLine(words);
    return fromUndo ? words : false;
  };

  const press = (on: boolean) => {
    if (pending || asked !== null) return;
    setAsked(on);
    setLine(null);
    start(async () => {
      const ok = await send(on, false);
      setAsked(null);
      if (ok === true && !on) {
        // the bar: its undo switches the code on again from the version the pause left
        undo.show({ text: t.paused, undo: () => send(true, true) });
      }
    });
  };

  return { shown, pending, line, lineId, press };
}

/**
 * „Kustuta sooduskood“ (spec §4.10): only while the code has no use at all (`used`: any, a cancelled or abandoned booking's too), behind a ConfirmPanel
 * „Kas kustutan sooduskoodi {code}?“ · „Jah, kustuta“ / „Katkesta“ („Katkesta“ gives the button back with the focus). Otherwise the line „Koodi on kasutatud —
 * kustutada ei saa. Peata see.“ (R19: when none of the uses counts, its own „… tühistatud või pooleli jäänud tellimustel …“). Deleted, the page goes back to
 * the list with „Sooduskood kustutatud.“; a booking that came meanwhile (`used`) says the line and the page is read again.
 */
function CodeDelete({ id, code, used, counting, listHref }: { id: number; code: string; used: boolean; counting: boolean; listHref: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState<"used" | "notFound" | "server" | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    opener.current?.focus();
  }, [asking]);
  const refusal = used || failed === "used";
  if (refusal)
    return (
      <p className={styles.refusal} data-delete-refusal="">
        {used && !counting ? t.remove.usedNoCount : t.remove.used}
      </p>
    );
  const remove = () => {
    if (pending) return;
    start(async () => {
      let r: Awaited<ReturnType<typeof deleteCodeAction>>;
      try {
        r = await deleteCodeAction({ id });
      } catch {
        r = { ok: false, error: "server" };
      }
      if (r.ok) {
        router.replace(`${listHref}${listHref.includes("?") ? "&" : "?"}kustutatud=1`, { scroll: false });
        return;
      }
      setAsking(false);
      setFailed(r.error === "used" ? "used" : r.error === "notFound" ? "notFound" : "server");
      if (r.error === "used") router.refresh();
    });
  };
  const error = failed === "notFound" ? t.drawer.notFound : failed === "server" || failed === "used" ? adminEt.common.saveError : null;
  return (
    <section className={styles.removeRow} data-code-delete="">
      {asking ? (
        <ConfirmPanel
          question={fill(t.remove.question, { code })}
          yesLabel={t.remove.yes}
          tone="danger"
          busy={pending}
          onYes={remove}
          onCancel={() => {
            refocus.current = true;
            setAsking(false);
          }}
        />
      ) : (
        <button ref={opener} type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} onClick={() => setAsking(true)}>
          {t.remove.button}
        </button>
      )}
      {error && (
        <p role="alert" className={ui.error}>
          {error}
        </p>
      )}
    </section>
  );
}

// ---------- a new code ----------

/** A kept copy's fields: each of the right kind over a new code's. */
function readCopy(raw: Record<string, unknown>, welcome: boolean): CodeFields {
  const out: CodeFields = { ...emptyCodeFields(welcome) };
  const mut = out as Record<string, unknown>;
  for (const f of CODE_FIELDS) {
    const v = raw[f];
    if (f === "courseIds") {
      if (Array.isArray(v) && v.every((x) => typeof x === "number")) out.courseIds = v as number[];
    } else if (f === "oncePerPerson") {
      if (typeof v === "boolean") out.oncePerPerson = v;
    } else if (typeof v === "string") mut[f] = v;
  }
  if (out.kind !== "percent" && out.kind !== "euro") out.kind = "percent";
  if (!["all", "ecourse", "contact", "courses"].includes(out.scope)) out.scope = "all";
  if (!["all", "first", "returning"].includes(out.audience)) out.audience = welcome ? "first" : "all";
  return out;
}

/** The list's address with the new code's drawer open on it and the „Sooduskood lisatud.“ of ?lisatud=. */
const createdHref = (id: number) => `/admin/sooduskoodid?kood=${id}&lisatud=${id}`;

type CreateResult = Awaited<ReturnType<typeof createCodeAction>>;

export function NewDiscountCode({ welcome, courses }: { welcome: boolean; courses: readonly CodeCourse[] }) {
  const router = useRouter();
  const empty = useMemo(() => emptyCodeFields(welcome), [welcome]);
  // the fields, their refusals, this browser's copy and the leave guard's „Sooduskoodi pole veel lisatud.“ (useNewRecord)
  const record = useNewRecord({
    copyKey: welcome ? NEW_WELCOME_COPY : NEW_CODE_COPY,
    empty,
    read: (raw) => readCopy(raw, welcome),
    order: CODE_FIELDS,
    thing: t.drawer.newThing,
    label: labelOf,
    focus: focusField,
  });
  const { fields, refused: errors } = record;
  const [failed, setFailed] = useState<"invalid" | "server" | null>(null);
  const [pending, start] = useTransition();

  const refuse = (codes: Partial<Record<CodeField, string>>) => {
    record.refuse(codes);
    setFailed("invalid");
  };
  const problems = () => problemsOf(fields, null, { welcome, courses }) as Partial<Record<CodeField, string>>;
  const create = () => {
    // (created: the drawer is on its way to the new code; a second press would make another)
    if (pending || record.finished()) return;
    const found = problems();
    if (Object.keys(found).length > 0) return refuse(found);
    const sent = { ...fields };
    setFailed(null);
    start(async () => {
      let r: CreateResult;
      try {
        r = await createCodeAction({ fields: sent, welcome });
      } catch {
        r = { ok: false, error: "server" };
      }
      if (r.ok) {
        record.finish();
        router.replace(createdHref(r.id), { scroll: false });
        return;
      }
      if (r.error === "invalid") refuse(r.fields as Partial<Record<CodeField, string>>);
      else setFailed("server");
    });
  };

  const ready = Object.keys(problems()).length === 0;
  const view: FieldView = {
    fields,
    welcome,
    used: false,
    valueNote: false,
    courses,
    set: (f, value) => {
      if (pending) return; // (the create is on its way: the fields are read-only)
      record.setField(f, value as never);
    },
    chooseKind: (kind) => {
      if (pending || kind === fields.kind) return;
      // R17 here too: the value of the kind switched to starts empty
      record.setFields((f) => ({ ...f, kind, ...(kind === "percent" ? { percent: "" } : { amount: "" }) }));
    },
    chooseScope: (scope) => {
      if (pending) return;
      record.setFields((f) => ({ ...f, scope, courseIds: scope === "courses" ? f.courseIds : [] }));
    },
    chooseAudience: (audience) => {
      if (!pending) record.setField("audience", audience);
    },
    onLeave: () => {},
    error: (f) => {
      const code = errors[f];
      return code === undefined ? undefined : wordsOf(code);
    },
    busy: pending,
  };
  const marked = Object.values(errors).some((c) => c !== undefined);
  const general = failed === "server" ? adminEt.common.saveError : failed === "invalid" && marked ? adminEt.courseEditor.invalid : null;

  return (
    <div className={styles.drawer} data-new-code={welcome ? "welcome" : ""}>
      <header className={styles.head} data-code-head="">
        <div className={styles.chipRow}>
          {/* a new record's line in the chip's place, as every other drawer's (SessionForm.tsx NewSession) */}
          <StatusLine data-new-code-line="">{ready ? fill(adminEt.courseEditor.newReady, { button: t.create }) : adminEt.courseEditor.newRequired}</StatusLine>
        </div>
        <h2 className={`${ui.h2} ${styles.title}`}>{welcome ? t.drawer.newWelcomeLabel : t.drawer.newLabel}</h2>
      </header>
      <CodeFieldList view={view} />
      <div className={styles.createRow}>
        <button type="button" className={ui.btn} aria-disabled={pending || undefined} onClick={create} data-create-code="">
          {t.create}
        </button>
        {general && (
          <p role="alert" className={ui.error} data-new-code-error="">
            {general}
          </p>
        )}
      </div>
    </div>
  );
}
