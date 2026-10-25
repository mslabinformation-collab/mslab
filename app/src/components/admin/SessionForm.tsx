"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import { CALENDAR_CITIES } from "@/domain/calendar";
import { COURSE_LANGUAGES } from "@/domain/course-editor";
import { SESSION_FIELDS, SESSION_LIMITS, sessionFieldProblems, type SessionField, type SessionFields, type SessionStatus } from "@/domain/session-fields";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { createSessionAction, deleteSession, setSessionStatusAction } from "@/server/actions/admin-content";
import type { EditResult } from "@/server/edit-check";
import { SAVE_TIMEOUT_MS } from "./autosave/constants";
import { patchSender, type Fields, type SendPatch } from "./autosave/engine";
import { useAutosave } from "./autosave/useAutosave";
import { Choice } from "./Choice";
import { ConfirmPanel } from "./ConfirmPanel";
import { focusFell } from "./focus-fell";
import { useGuardSource } from "./LeaveGuard";
import { SaveStatus } from "./SaveStatus";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import styles from "./SessionForm.module.css";

// The Kalender drawer (admin UX pass piece 3b, Task 3; README B3, the Part 3 frame „B3 Kalender“ and the Part 4 „B3 Session drawer“; piece3-texts
// S3-P3-g, S3-P3-i, P-2, P-7, P-8; rulings R-a, R-b, R-c). Two drawers:
// - SessionDrawer, a stored session (?id=<n>), top to bottom: the header — SaveStatus left of the drawer's ✕, the course (Jost 28), „{dd.mm.yyyy} ·
//   {linn} · {k}/{cap} kinnitatud · ootab ettemaksu {a} · ootenimekirjas {n}“ (the awaiting registrations' part Dim's 25.10, the waitlist's P-7, each
//   only when there is one; the phone's „… · {k}/{cap} · ootab ettemaksu {a} · ootel {n}“, Part 4's with that part, which fits its line) and „Protokollid“, the first button; with registrations the notice „{n} õpilast on registreerunud. Muudatusest neile kirja ei saadeta.“; the
//   fields, autosaved (useAutosave on POST /api/admin/toimumine/<id>, server/session-edit.ts writeSession) — „Kuupäev“ or „Algus (Eesti aeg)“ changed on a
//   booked session says „Muudetud — teavita {n} õpilast ise.“ (#6b4f5c), „Kohti“ commits on blur (piece3-texts §4, behaviours "Server-side changes" 1)
//   and below the confirmed is refused in the field, „Koolitus“ is disabled once anyone is booked with S3-P3-i under it; „Staatus“, instant
//   (setSessionStatusAction), „Tühistatud“ on a booked session behind a ConfirmPanel; „Kustuta toimumine“ only without registrations, else the
//   refusal text in its place. No „Salvesta toimumine“.
// - NewSession (?id=uus; S3-P3-g): the same fields with the course's „—“ and no status (a new session is always „Toimub“); the header says „Täida
//   kohustuslikud väljad“ and then „Vajuta „Lisa toimumine“.“; the one explicit „Lisa toimumine“ creates it (createSessionAction) and the drawer goes on
//   at ?id=<n>&lisatud=<n>, autosaving. Typed and not created: leaving asks with the reason „Toimumist pole veel lisatud.“, and the typed text stays in
//   this browser (NEW_SESSION_COPY) until the next visit.
// The counts (R-b): n of the notice, of the hint, of the cancel question and of the locked course is the registrations that are not cancelled
// (`booked`); „Kinnitatud on {n}“ and the header's {k} the confirmed; „Kustuta toimumine“ every registration (`all`). The client's checks are the
// server's own rules (domain/session-fields.ts), never a copy.

const t = adminEt.calendar;
const e = adminEt.courseEditor.errors;

/** The engines' copies in this browser: `mslab-draft:toimumine:<id>:<tab>`. */
const OWNER = "toimumine";
/** This browser's copy of a new session typed and not created yet (one per browser; dropped once it is created). */
export const NEW_SESSION_COPY = "mslab-draft:toimumine:uus";

export type SessionCourse = { id: number; title: string; published: boolean };
/** A session's registrations as the rules count them (db/queries/admin.ts countSessionRegistrations, R-b, R-c). */
export type SessionCounts = { confirmed: number; booked: number; all: number };

/** The visible names of the fields (the leave guard's notice and SaveStatus's „Näita“ name them). */
const LABELS: Record<SessionField, string> = {
  courseId: t.form.course,
  date: t.form.date,
  time: t.form.time,
  city: t.form.city,
  venue: t.form.venue,
  language: t.form.language,
  capacity: t.form.capacity,
};
const labelOf = (field: string): string => LABELS[field as SessionField] ?? field;
/** An empty required field gets its own words (the date, the time, the city, the course), not the content editor's "fill in (in Estonian)". */
const REQUIRED: Partial<Record<SessionField, string>> = { courseId: e.course, date: e.date, time: e.time, city: t.form.cityRequired };

/** The words of a refused field: its code's text, „Kinnitatud on {n} — …“ with the confirmed. */
function errorText(field: SessionField, code: string, confirmed: number): string {
  if (code === "required") return REQUIRED[field] ?? e.required;
  const words = (e as Record<string, string>)[code];
  return words === undefined ? adminEt.courseEditor.invalid : fill(words, { n: confirmed });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const norm = (v: string | number | null) => (typeof v === "string" ? v.trim() : v);

/** The fields' problems by the server's rules (domain/session-fields.ts): the changed ones against `stored`, every one of a new session (`stored` null). */
const problemsOf = (f: SessionFields, stored: SessionFields | null, counts: { confirmed: number; booked: number }): Partial<Record<SessionField, string>> =>
  sessionFieldProblems(f, { stored, confirmed: counts.confirmed, booked: counts.booked });

/** The drawer's field `name` (the first in the open drawer's form, else any): SaveStatus's „Näita“ and the guard's „Jää siia“. */
function focusField(name: string): void {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-session-form] [name="${name}"]`));
  (all.find((el) => el.closest("dialog[data-drawer][open]") !== null) ?? all[0])?.focus();
}

// ---------- the fields (both drawers) ----------

type FieldView = {
  /** The text a field shows (the course as its id, "" for none). */
  value: (f: SessionField) => string;
  set: (f: SessionField, raw: string) => void;
  /** A field left (any field: the form's focusout). */
  onLeave: () => void;
  /** A select chosen: saved at once (an instant field, README §1.3). */
  onChoose: (f: SessionField) => void;
  error: (f: SessionField) => string | undefined;
  /** The warning hint under a field (#6b4f5c): „Muudetud — teavita {n} õpilast ise.“. */
  changed: (f: SessionField) => string | undefined;
  /** „Koolitus“ is locked (R-b: anyone booked), with S3-P3-i under it. */
  locked: boolean;
  courses: SessionCourse[];
  /** The course's „—“ (a new session before one is chosen). */
  none: boolean;
  /** Nothing can be typed (a new session's create on its way: what it sends is what the new drawer shows). */
  busy?: boolean;
};

/**
 * The session's fields in Part 3's order — „Koolitus“ (the frame leaves it out; first, as the course is what a session is of), „Kuupäev“ | „Algus (Eesti
 * aeg)“, „Linn“ | „Kohti“, „Toimumiskoht“ — then „Keel“ (not drawn either). Two to a row in the drawer; one per row on a phone (Part 4). Each field's
 * words under it, named by aria-describedby: the warning hint, the locked course's reason, the error.
 */
function SessionFieldList({ view }: { view: FieldView }) {
  const uid = useId();
  const id = (f: SessionField) => `${uid}-${f}`;
  const parts = (f: SessionField) => {
    const changed = view.changed(f);
    const error = view.error(f);
    const locked = f === "courseId" && view.locked;
    const describedBy = [changed && `${id(f)}-changed`, locked && `${id(f)}-locked`, error && `${id(f)}-error`].filter(Boolean).join(" ") || undefined;
    const after = (
      <>
        {changed && (
          <p id={`${id(f)}-changed`} className={styles.changed} data-changed-hint="">
            {changed}
          </p>
        )}
        {locked && (
          <p id={`${id(f)}-locked`} className={ui.hint} data-course-locked="">
            {e.courseLocked}
          </p>
        )}
        {error && (
          <p id={`${id(f)}-error`} className={ui.error} data-field-error="">
            {error}
          </p>
        )}
      </>
    );
    return { describedBy, after, invalid: error ? true : undefined, changed: changed ? "" : undefined };
  };
  const text = (f: SessionField, input: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {}) => {
    const p = parts(f);
    return (
      <div className={ui.field} data-field={f}>
        <label htmlFor={id(f)}>{LABELS[f]}</label>
        <input
          id={id(f)}
          name={f}
          className={ui.input}
          autoComplete="off"
          value={view.value(f)}
          readOnly={view.busy || undefined}
          onChange={(ev) => view.set(f, ev.target.value)}
          aria-invalid={p.invalid}
          aria-describedby={p.describedBy}
          data-changed={p.changed}
          {...input}
        />
        {p.after}
      </div>
    );
  };
  const course = parts("courseId");
  const language = parts("language");
  return (
    <div className={styles.fields} onBlur={view.onLeave} aria-busy={view.busy || undefined} data-session-form="">
      <div className={ui.field} data-field="courseId">
        <label htmlFor={id("courseId")}>{LABELS.courseId}</label>
        <select
          id={id("courseId")}
          name="courseId"
          className={`${ui.input} ${ed.select}`}
          value={view.value("courseId")}
          disabled={view.locked}
          aria-disabled={view.busy || undefined}
          onChange={(ev) => {
            view.set("courseId", ev.target.value);
            view.onChoose("courseId");
          }}
          aria-invalid={course.invalid}
          aria-describedby={course.describedBy}
        >
          {view.none && <option value="">{adminEt.common.none}</option>}
          {view.courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.published ? c.title : `${c.title} (${t.draft})`}
            </option>
          ))}
        </select>
        {course.after}
      </div>
      <div className={styles.pair} data-pair="">
        {text("date", { type: "date", className: `${ui.input} ${ed.dateTime}` })}
        {text("time", { type: "time", step: 300, className: `${ui.input} ${ed.dateTime}` })}
      </div>
      <div className={styles.pair} data-pair="">
        {text("city", { list: `${uid}-cities`, maxLength: SESSION_LIMITS.city })}
        {text("capacity", { inputMode: "numeric", maxLength: 2 })}
      </div>
      <datalist id={`${uid}-cities`}>
        {CALENDAR_CITIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      {text("venue", { maxLength: SESSION_LIMITS.venue, placeholder: t.form.venueHint })}
      <div className={ui.field} data-field="language">
        <label htmlFor={id("language")}>{LABELS.language}</label>
        <select
          id={id("language")}
          name="language"
          className={`${ui.input} ${ed.select}`}
          value={view.value("language")}
          aria-disabled={view.busy || undefined}
          onChange={(ev) => {
            view.set("language", ev.target.value);
            view.onChoose("language");
          }}
          aria-invalid={language.invalid}
          aria-describedby={language.describedBy}
        >
          {COURSE_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        {language.after}
      </div>
    </div>
  );
}

/** A field's text as typed → the field's value (the course is its id, or null). */
const parseField = (f: SessionField, raw: string): string | number | null => (f === "courseId" ? (raw === "" ? null : Number(raw)) : raw);
const shownOf = (v: string | number | null): string => (v === null ? "" : String(v));

// ---------- a stored session ----------

type DrawerProps = {
  id: number;
  /** The session's version as the page read it (server/session-edit.ts readSession, R-a: its fields and its status). */
  version: string;
  /** Its fields as stored, as typed (the course's id, the seats as text). */
  fields: SessionFields;
  status: SessionStatus;
  counts: SessionCounts;
  /**
   * Its registrations awaiting their prepayment (status „Ootab ettemaksu“, a seat hold live or not: the same number as Registreerimised' status filter;
   * controller ruling, fix round 2 of Dim's 25.10 line).
   */
  awaiting: number;
  /** Open waitlist requests for it. */
  waitlist: number;
  /** The course's name. */
  title: string;
  /** Its start's date as the page writes it (dd.mm.yyyy, Estonian time). */
  when: string;
  /** A contact course's session: „Protokollid“ (a row of another course's can be left from before its type was locked). */
  contact: boolean;
  courses: SessionCourse[];
  /** Just created by „Lisa toimumine“ (?lisatud=<n>): „Toimumine lisatud.“ at the top. */
  added?: boolean;
};

/**
 * The versions the drawer knows (R-a: one version for the fields and the status). `known`: the server's latest version as the drawer heard it (a field
 * save's answer, the status action's); `same`: the versions that hold the same fields as `known` (the status action changes the status only). The field
 * engine sends the version of its last save; when the status moved it since, the save goes from `known` — the same fields, so no conflict is made up.
 */
type Versions = { known: string; same: Set<string> };

/** The status action's answer within SAVE_TIMEOUT_MS, or null (late: its answer is still taken when it comes). */
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

type StatusResult = Awaited<ReturnType<typeof setSessionStatusAction>>;

export function SessionDrawer(p: DrawerProps) {
  const uid = useId();
  const router = useRouter();
  const nav = useRef(router);
  /** The page's latest read (the stored fields and the counts): the field check reads it, as the server checks against the row as it is. */
  const live = useRef({ stored: p.fields, counts: p.counts });
  useLayoutEffect(() => {
    nav.current = router;
    live.current = { stored: p.fields, counts: p.counts };
  });
  const versions = useRef<Versions>({ known: p.version, same: new Set([p.version]) });
  /** The status action on its way (until its answer, at most SAVE_TIMEOUT_MS): a field save waits for it, then goes from the version it left. */
  const statusFlight = useRef<Promise<void> | null>(null);
  /** The fields as the drawer opened: „Muudetud — …“ says a date or a time differs from what the students registered for. */
  const [opened] = useState(p.fields);
  /** The route's refusal codes (400) by field, until the field is typed in again or saved. */
  const [refused, setRefused] = useState<Partial<Record<SessionField, string>>>({});
  /** The status action met another tab's change (R-a): the chip says so until the next status saves. */
  const [statusConflict, setStatusConflict] = useState(false);

  const save = useMemo<SendPatch>(() => {
    const base = patchSender(`/api/admin/toimumine/${p.id}`);
    return async (body, opts) => {
      // (a field typed while the status saves: after it, so the two never cross on the server and make a conflict of their own)
      const flight = statusFlight.current;
      if (flight) await flight;
      const v = versions.current;
      const version = v.same.has(body.version) ? v.known : body.version;
      const answer = await base({ ...body, version }, opts);
      const reply = answer && isRecord(answer.body) ? answer.body : null;
      if (answer?.status === 200 && reply?.ok === true && typeof reply.version === "string") {
        versions.current = { known: reply.version, same: new Set([reply.version]) };
        setRefused({});
        setStatusConflict(false);
        // stored (its version moved): the row behind the drawer and the header are the page's to say
        if (reply.version !== version) startTransition(() => nav.current.refresh());
      } else if (answer?.status === 409 && reply?.error === "conflict" && typeof reply.version === "string") {
        versions.current = { known: reply.version, same: new Set([reply.version]) };
      } else if (answer?.status === 400 && reply?.error === "invalid" && isRecord(reply.fields)) {
        const codes: Partial<Record<SessionField, string>> = {};
        for (const f of SESSION_FIELDS) if (typeof reply.fields[f] === "string") codes[f] = reply.fields[f] as string;
        setRefused(codes);
        // a refusal by the registrations as they are now (a seat confirmed meanwhile): the page's counts are read again
        startTransition(() => nav.current.refresh());
      }
      return answer;
    };
  }, [p.id]);
  const validate = useCallback((f: Fields): Record<string, string> => problemsOf(f as SessionFields, live.current.stored, live.current.counts) as Record<string, string>, []);
  const auto = useAutosave({ owner: OWNER, key: String(p.id), version: p.version, fields: { ...p.fields }, save, validate, label: labelOf, focusField });
  const { setField, flush, restore, unconfirmed } = auto;
  const fields = auto.fields as SessionFields;

  // „Kohti“ commits on blur (piece3-texts §4): typed, it waits here; the form's focusout, the guard (✕, a link, Back) and the tab closing commit it
  const typedCapacity = useRef<string | null>(null);
  const [capacityText, setCapacityText] = useState<string | null>(null);
  const commitCapacity = useCallback(() => {
    const typed = typedCapacity.current;
    if (typed === null) return;
    typedCapacity.current = null;
    setCapacityText(null);
    setField("capacity", typed);
  }, [setField]);
  useGuardSource({
    id: `${uid}-capacity`,
    // (committed, the engine's own word on it: the field it holds back and why)
    label: () => labelOf(typedCapacity.current === null ? (unconfirmed()?.field ?? "capacity") : "capacity"),
    flush: async () => {
      commitCapacity();
      return flush();
    },
    unconfirmed: () => (typedCapacity.current !== null ? { reason: "error" } : unconfirmed()),
    focus: () => focusField(typedCapacity.current === null ? (unconfirmed()?.field ?? "capacity") : "capacity"),
  });

  const held = auto.status.kind === "invalid";
  const local = problemsOf(fields, p.fields, p.counts);
  const codeOf = (f: SessionField): string | undefined => {
    if (f === "capacity" && capacityText !== null) return undefined; // being typed: judged when it is left
    if (!held) return undefined;
    // (a refusal of the course that names the fields sent with it — a session row under an e-course, server/session-edit.ts refusedFields — is said
    // under „Koolitus“ alone: the other fields are held back with it, and „Näita“ goes to the course)
    return local[f] ?? (f === "courseId" || refused[f] !== "course" ? refused[f] : undefined);
  };
  const booked = p.counts.booked;

  const view: FieldView = {
    value: (f) => (f === "capacity" && capacityText !== null ? capacityText : shownOf(fields[f])),
    set: (f, raw) => {
      setRefused((r) => (r[f] ? { ...r, [f]: undefined } : r));
      if (f === "capacity") {
        typedCapacity.current = raw;
        setCapacityText(raw);
        return;
      }
      setField(f, parseField(f, raw));
    },
    onLeave: () => {
      commitCapacity();
      void flush();
    },
    onChoose: () => void flush(),
    error: (f) => {
      const code = codeOf(f);
      return code === undefined ? undefined : errorText(f, code, p.counts.confirmed);
    },
    changed: (f) => ((f === "date" || f === "time") && booked > 0 && norm(fields[f]) !== norm(opened[f]) ? fill(t.form.changed, { n: booked }) : undefined),
    locked: booked > 0,
    courses: p.courses,
    none: false,
  };
  const showInvalid = () => focusField(SESSION_FIELDS.find((f) => codeOf(f) !== undefined) ?? "capacity");

  const status = useStatus(p, versions, statusFlight, flush, setStatusConflict);
  // one chip for the drawer (README §1.4): the status action is one of its saves (an instant field)
  const chip: AutosaveStatus = status.pending
    ? { kind: "saving" }
    : statusConflict
      ? { kind: "conflict" }
      : auto.status.kind === "saved" && status.savedAt && (!auto.status.at || status.savedAt > auto.status.at)
        ? { kind: "saved", at: status.savedAt }
        : auto.status;

  const seatsParts = (short: boolean) =>
    [
      p.when,
      p.fields.city,
      fill(short ? t.drawer.seatsShort : t.drawer.seats, { k: p.counts.confirmed, cap: p.fields.capacity }),
      // (Dim 25.10: the awaiting registrations between the confirmed and the waitlist; on the phone's short line too, where it fits: Part 4's sample
      // with it is about 302 px of the 343 px a 375 px phone gives the line)
      p.awaiting > 0 ? fill(t.drawer.awaiting, { n: p.awaiting }) : null,
      p.waitlist > 0 ? fill(short ? t.drawer.waitlistShort : t.drawer.waitlist, { n: p.waitlist }) : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className={styles.drawer} data-session-drawer={p.id}>
      <header className={styles.head} data-session-head="">
        <div className={styles.chipRow}>
          <SaveStatus status={chip} thing={t.drawer.thing} onShowInvalid={showInvalid} />
        </div>
        <h2 className={styles.title}>{p.title}</h2>
        <p className={styles.line} data-session-line="">
          <span className={styles.wide} data-line="wide">
            {seatsParts(false)}
          </span>
          <span className={styles.short} data-line="short">
            {seatsParts(true)}
          </span>
        </p>
        {/* the session's protocols (phase protocols, spec §4): one tap to the course day's screen; on the course day the first thing she needs */}
        {p.contact && (
          <Link className={`${ui.btn} ${ui.smallBtn} ${styles.protocols}`} href={`/admin/protokollid?sessioon=${p.id}`} data-session-protocols="">
            {adminEt.protocols.open}
          </Link>
        )}
      </header>
      {p.added && (
        <p className={`${ui.notice} ${styles.notice}`} role="status" data-flash="added">
          {t.added}
        </p>
      )}
      {booked > 0 && (
        <p className={`${ui.notice} ${styles.notice}`} data-session-booked="">
          {booked === 1 ? t.drawer.bookedOne : fill(t.drawer.booked, { n: booked })}
        </p>
      )}
      <SessionFieldList view={view} />
      {auto.conflict && (
        <p className={styles.restore}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => void restore()} data-session-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
      <StatusChoice status={status} />
      <SessionDelete id={p.id} all={p.counts.all} />
    </div>
  );
}

/**
 * „Staatus“: „Toimub“ / „Tühistatud“, saved at once with the version the drawer holds (setSessionStatusAction; R-a), after the fields' waiting save (the
 * status goes from the version after it). „Tühistatud“ on a booked session asks first (README B3): the ConfirmPanel under the pills, „Kas tühistan
 * toimumise?“ · „{n} registreeringut jäävad alles; teavita õpilasi ise.“ (P-8: „1 registreering jääb alles; teavita õpilast ise.“) · „Jah, tühista“ /
 * „Katkesta“. „Toimub“ puts it back with no question. The pill pressed shows while the action runs, then the stored one (the action has the page read
 * again; until the read comes, the one it stored). Bounded by SAVE_TIMEOUT_MS: a late answer says „Salvestamine ei õnnestunud. Proovi uuesti.“ and is
 * still taken when it comes. Another tab's change meanwhile (a conflict) is the chip's „Muudeti teises aknas — vaata üle“, and the page is read again.
 */
function useStatus(
  p: DrawerProps,
  versionsRef: React.RefObject<Versions>,
  flightRef: React.RefObject<Promise<void> | null>,
  flush: () => Promise<boolean>,
  setConflict: (on: boolean) => void,
) {
  const [pending, start] = useTransition();
  const [asked, setAsked] = useState<SessionStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  /** The status the action stored, over the page's `over` (until the page's read moves). */
  const [said, setSaid] = useState<{ status: SessionStatus; over: SessionStatus } | null>(null);
  if (said && p.status !== said.over) setSaid(null);
  /** The radio that gets the focus after an answer or the panel (README §1.6: the trigger comes back with it); a new object each time. */
  const [focusTo, setFocusTo] = useState<{ status: SessionStatus } | null>(null);
  const router = useRouter();
  const stored = said?.status ?? p.status;
  const shown: SessionStatus = asking ? "cancelled" : pending && asked ? asked : stored;

  const take = (r: StatusResult, from: string) => {
    if (r.ok) {
      const same = versionsRef.current.known === from ? versionsRef.current.same : new Set<string>();
      versionsRef.current = { known: r.version, same: new Set([...same, r.version]) };
    } else if (r.error === "conflict") {
      // another tab's fields may be in it: the engine's next save meets them as its own conflict
      versionsRef.current = { known: r.version, same: new Set() };
    }
  };

  const run = (next: SessionStatus, fromPanel: boolean) => {
    const over = stored;
    setAsked(next);
    setLine(null);
    start(async () => {
      await flush();
      const from = versionsRef.current.known;
      let land = () => {};
      flightRef.current = new Promise<void>((resolve) => (land = resolve));
      const call = (async (): Promise<StatusResult> => {
        try {
          return await setSessionStatusAction({ id: p.id, status: next, version: from });
        } catch {
          return { ok: false, error: "server" };
        }
      })();
      /** An answer as the drawer shows it: stored (the chip's time, the pill), another tab's change (the chip), or refused (the line). */
      const show = (r: StatusResult) => {
        if (r.ok) {
          setLine(null);
          setConflict(false);
          setSavedAt(new Date());
          setSaid({ status: next, over });
        } else if (r.error === "conflict") {
          setConflict(true);
          router.refresh();
        } else setLine(r.error === "notFound" ? t.drawer.notFound : adminEt.common.saveError);
      };
      const result = await bounded(call);
      if (result === null)
        // late: said not saved for now; the answer still counts when it comes (a success takes the line back and shows the stored status)
        void call.then((r) => {
          take(r, from);
          if (r.ok || r.error === "conflict") show(r);
        });
      else take(result, from);
      flightRef.current = null;
      land();
      show(result ?? { ok: false, error: "server" });
      setAsking(false);
      if (fromPanel || !result?.ok) setFocusTo({ status: result?.ok ? next : over });
    });
  };

  const choose = (next: SessionStatus) => {
    if (pending) return;
    if (next === stored) return setAsking(false); // (back on the stored one while the panel asks: nothing to save)
    if (next === "cancelled" && p.counts.booked > 0) {
      setLine(null);
      return setAsking(true);
    }
    run(next, false);
  };

  return {
    pending,
    asking,
    shown,
    line,
    savedAt,
    focusTo,
    booked: p.counts.booked,
    choose,
    yes: () => run("cancelled", true),
    cancel: () => {
      setAsking(false);
      setFocusTo({ status: stored });
    },
  };
}

function StatusChoice({ status }: { status: ReturnType<typeof useStatus> }) {
  const uid = useId();
  const section = useRef<HTMLElement>(null);
  const { focusTo } = status;
  // the answer's radio takes the focus only where the focus fell (the panel gone with it) or is still in this section, never from a field she moved to
  useEffect(() => {
    if (!focusTo) return;
    if (!focusFell() && !section.current?.contains(document.activeElement)) return;
    document.getElementById(`${uid}-${focusTo.status}`)?.focus();
  }, [focusTo, uid]);
  const n = status.booked;
  return (
    <section ref={section} className={styles.statusRow} data-session-status="">
      <fieldset className={styles.status} aria-busy={status.pending || undefined} aria-describedby={`${uid}-hint${status.line ? ` ${uid}-line` : ""}`}>
        <legend className={styles.legend}>{t.form.status}</legend>
        <div className={styles.pills}>
          {(["scheduled", "cancelled"] as const).map((s) => (
            <Choice
              key={s}
              id={`${uid}-${s}`}
              className={styles.pill}
              label={t.status[s]}
              type="radio"
              name={`${uid}-status`}
              value={s}
              checked={status.shown === s}
              onChange={() => status.choose(s)}
            />
          ))}
        </div>
      </fieldset>
      {status.asking && (
        <ConfirmPanel
          question={t.cancel.question}
          lines={[n === 1 ? t.cancel.lineOne : fill(t.cancel.line, { n })]}
          yesLabel={t.cancel.yes}
          tone="danger"
          busy={status.pending}
          onYes={status.yes}
          onCancel={status.cancel}
        />
      )}
      <p id={`${uid}-hint`} className={ui.hint}>
        {t.form.statusHint}
      </p>
      <p id={`${uid}-line`} role="status" className={ui.error} data-status-line="">
        {status.line ?? ""}
      </p>
    </section>
  );
}

/**
 * „Kustuta toimumine“ (README B3; P-7): only when the session has no registrations at all (`all`, cancelled ones too: they stay as history, R-b);
 * otherwise „Toimumisel on registreeringuid — kustutada ei saa. Märgi see „Tühistatud“.“ in its place. The button asks in a ConfirmPanel: „Kas kustutan
 * selle toimumise?“ · „Seda ei saa tagasi võtta.“ · „Jah, kustuta“ / „Katkesta“ („Katkesta“ gives the button back with the focus). Deleted, the page goes
 * back to the list with „Toimumine kustutatud.“; someone registered meanwhile, the refusal says the same text.
 */
function SessionDelete({ id, all }: { id: number; all: number }) {
  const [state, action, pending] = useActionState<EditResult | null, FormData>(deleteSession, null);
  const [asking, setAsking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    opener.current?.focus();
  }, [asking]);
  if (all > 0)
    return (
      <p className={styles.refusal} data-delete-refusal="">
        {t.remove.inUse}
      </p>
    );
  const error = state && !state.ok ? (state.error === "inUse" ? t.remove.inUse : state.error === "notFound" ? t.drawer.notFound : adminEt.common.saveError) : null;
  const remove = () => {
    if (pending) return;
    const fd = new FormData();
    fd.set("id", String(id));
    startTransition(() => action(fd));
  };
  return (
    <section className={styles.deleteRow} data-session-delete="">
      {asking ? (
        <ConfirmPanel
          question={t.remove.question}
          lines={[t.remove.line]}
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

// ---------- a new session ----------

/** A new session's fields: the course to choose, and Algus 10:00, Kohti 4, Keel ET filled in (S3-P3-g). */
const EMPTY: SessionFields = { courseId: null, date: "", time: "10:00", city: "", venue: "", language: "ET", capacity: "4" };

/** The copy, read defensively: each field of the right kind over a new session's; the course only while it is one of `courses` (else „—“). */
function readCopy(courses: SessionCourse[]): SessionFields | null {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(NEW_SESSION_COPY) ?? "null");
    if (!isRecord(raw)) return null;
    const out: SessionFields = { ...EMPTY };
    for (const f of SESSION_FIELDS) {
      const v = raw[f];
      if (f === "courseId") {
        if (typeof v === "number" && courses.some((c) => c.id === v)) out.courseId = v;
      } else if (typeof v === "string") out[f] = v;
    }
    return out;
  } catch {
    return null;
  }
}

function writeCopy(fields: SessionFields | null): void {
  try {
    if (fields) window.localStorage.setItem(NEW_SESSION_COPY, JSON.stringify(fields));
    else window.localStorage.removeItem(NEW_SESSION_COPY);
  } catch {
    // full or blocked: nothing is kept
  }
}

const sameFields = (a: SessionFields, b: SessionFields) => SESSION_FIELDS.every((f) => a[f] === b[f]);

/** The list's address with the new session's drawer open on it and the „Toimumine lisatud.“ of ?lisatud=. */
function createdHref(listHref: string, id: number): string {
  const url = new URL(listHref, "http://admin.invalid");
  url.searchParams.set("id", String(id));
  url.searchParams.set("lisatud", String(id));
  return `${url.pathname}${url.search}`;
}

type CreateResult = Awaited<ReturnType<typeof createSessionAction>>;

export function NewSession({ courses, listHref }: { courses: SessionCourse[]; listHref: string }) {
  const uid = useId();
  const router = useRouter();
  const [fields, setFields] = useState<SessionFields>(EMPTY);
  /** The words of the refused fields (the drawer's own check before the press, or the server's), until each is typed in again. */
  const [errors, setErrors] = useState<Partial<Record<SessionField, string>>>({});
  const [failed, setFailed] = useState<"invalid" | "server" | null>(null);
  const [focusTo, setFocusTo] = useState<{ name: SessionField } | null>(null);
  const [pending, start] = useTransition();
  /** Created: nothing is left to ask about while the drawer moves on to it. */
  const created = useRef(false);

  // the copy an earlier visit kept comes back (after the first render: the server knows no browser storage); from then on it follows the fields
  const restored = useRef(false);
  useEffect(() => {
    if (!restored.current) {
      restored.current = true;
      const copy = readCopy(courses);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the storage is only known in the browser, after hydration
      if (copy && !sameFields(copy, EMPTY)) setFields(copy);
      return;
    }
    if (!created.current) writeCopy(sameFields(fields, EMPTY) ? null : fields);
  }, [fields, courses]);

  useEffect(() => {
    if (focusTo) focusField(focusTo.name);
  }, [focusTo]);

  // the leave guard (S3-P3-g): typed and not created yet — it asks, naming the first field typed into, with „Toimumist pole veel lisatud.“
  const typed = SESSION_FIELDS.find((f) => fields[f] !== EMPTY[f]) ?? null;
  useGuardSource({
    id: uid,
    label: () => labelOf(typed ?? "courseId"),
    flush: async () => false,
    unconfirmed: () => (!created.current && typed ? { reason: "notCreated", thing: t.drawer.newThing } : null),
    focus: () => focusField(typed ?? "courseId"),
  });

  const refuse = (codes: Partial<Record<SessionField, string>>) => {
    setErrors(codes);
    setFailed("invalid");
    const first = SESSION_FIELDS.find((f) => codes[f] !== undefined);
    if (first) setFocusTo({ name: first });
  };
  const create = () => {
    // (created: the drawer is on its way to the new session; a second press would make another)
    if (pending || created.current) return;
    const problems = problemsOf(fields, null, { confirmed: 0, booked: 0 });
    if (Object.keys(problems).length > 0) return refuse(problems);
    const sent = { ...fields };
    setFailed(null);
    start(async () => {
      let r: CreateResult;
      try {
        r = await createSessionAction(sent);
      } catch {
        r = { ok: false, error: "server" };
      }
      if (r.ok) {
        created.current = true;
        writeCopy(null);
        router.replace(createdHref(listHref, r.id), { scroll: false });
        return;
      }
      if (r.error === "invalid") refuse(r.fields as Partial<Record<SessionField, string>>);
      else setFailed("server");
    });
  };

  const ready = Object.keys(problemsOf(fields, null, { confirmed: 0, booked: 0 })).length === 0;
  const view: FieldView = {
    value: (f) => shownOf(fields[f]),
    set: (f, raw) => {
      if (pending) return; // (the create is on its way: the fields are read-only, and a select's choice is not taken either)
      setErrors((r) => (r[f] ? { ...r, [f]: undefined } : r));
      setFields((d) => ({ ...d, [f]: parseField(f, raw) }));
    },
    onLeave: () => {},
    onChoose: () => {},
    error: (f) => {
      const code = errors[f];
      return code === undefined ? undefined : errorText(f, code, 0);
    },
    changed: () => undefined,
    locked: false,
    courses,
    none: fields.courseId === null,
    busy: pending,
  };
  const marked = Object.values(errors).some((c) => c !== undefined);
  const general = failed === "server" ? adminEt.common.saveError : failed === "invalid" && marked ? adminEt.courseEditor.invalid : null;

  return (
    <div className={styles.drawer} data-new-session="">
      <header className={styles.head} data-session-head="">
        <div className={styles.chipRow}>
          <span className={styles.createLine} role="status" data-new-session-line="">
            {ready ? fill(adminEt.courseEditor.newReady, { button: t.form.create }) : adminEt.courseEditor.newRequired}
          </span>
        </div>
        <h2 className={styles.title}>{t.drawer.newLabel}</h2>
      </header>
      <SessionFieldList view={view} />
      <div className={styles.createRow}>
        <button type="button" className={ui.btn} aria-disabled={pending || undefined} onClick={create} data-create-session="">
          {t.form.create}
        </button>
        {general && (
          <p role="alert" className={ui.error} data-new-session-error="">
            {general}
          </p>
        )}
      </div>
    </div>
  );
}
