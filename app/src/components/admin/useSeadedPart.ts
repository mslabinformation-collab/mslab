"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import { patchSender, type Fields, type SendPatch } from "./autosave/engine";
import { useAutosave } from "./autosave/useAutosave";
import { useGuardSource } from "./LeaveGuard";

/** What a card tells the page of its parts: the part's name and its status (SettingsEditor puts them in its one SaveStatus). */
export type StatusReport = (part: string, status: AutosaveStatus) => void;

/** Fields that save as one (the certificate's „Aasta“ and „Number“): the engine holds them as one field `name`, so a save of either sends both. */
export type FieldGroup = { name: string; members: readonly string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const without = (codes: Record<string, string>, names: readonly string[]): Record<string, string> => {
  if (!names.some((n) => n in codes)) return codes;
  const out = { ...codes };
  for (const n of names) delete out[n];
  return out;
};
const pick = (from: Record<string, unknown>, names: readonly string[]): Record<string, unknown> => Object.fromEntries(names.map((n) => [n, from[n]]));

/** The route's fields → the engine's: a group's members as one field. */
function toEngine(fields: Fields, group: FieldGroup | undefined): Fields {
  if (!group) return fields;
  const out: Fields = {};
  for (const [name, value] of Object.entries(fields)) if (!group.members.includes(name)) out[name] = value;
  out[group.name] = pick(fields, group.members);
  return out;
}

/** The engine's patch → the route's: a group's field as its members (all of them: they are judged together). */
function toRoute(patch: Fields, group: FieldGroup | undefined): Fields {
  if (!group || !(group.name in patch)) return patch;
  const { [group.name]: members, ...rest } = patch;
  return { ...rest, ...(isRecord(members) ? members : {}) };
}

/**
 * The route's answer → the engine's: a conflict's stored value with the group's field made of its members, a refusal of a member as a refusal of the
 * group's field (the engine holds it back: both are sent again once either is typed in).
 */
function answerToEngine(body: unknown, group: FieldGroup | undefined): unknown {
  if (!group || !isRecord(body)) return body;
  if (body.error === "conflict" && isRecord(body.value)) return { ...body, value: { ...body.value, [group.name]: pick(body.value, group.members) } };
  if (body.error === "invalid" && isRecord(body.fields)) {
    const fields = body.fields;
    const code = group.members.map((m) => fields[m]).find((c) => typeof c === "string");
    if (code === undefined) return body;
    return { ...body, fields: { ...without(fields as Record<string, string>, group.members), [group.name]: code } };
  }
  return body;
}

/**
 * One Seaded card's part, autosaved on POST /api/admin/seaded/<part> (admin UX pass piece 3b, Task 4; README B4; server/seaded.ts):
 * - the engine (autosave/useAutosave.ts: a field saves 1.5 s after typing and at once on `flush`, the copy in this browser, the leave guard), owner
 *   "seaded", the part its key; the route's version is the one the page read;
 * - the route's refusals by field (`codes`, the server's code of each field it held back), until the field is typed in again or a save of it
 *   comes through: the card says them in its own words, in the field;
 * - `onBlur`: the fields that commit on blur (behaviours conflict 13: „Järgmine number“, and the invoice's prefix): typed, they wait here
 *   (`text(name)`), and leaving the field (`commit()`), or the page — a link, Back (the leave guard's flush), the tab hidden or put away (then the
 *   engine's copy in this browser holds it too) — gives them to the engine and saves them. The guard asks when that save is refused or cannot go;
 * - `group`: fields saved as one (FieldGroup): a save of either member sends both, and the route's word on one holds both back;
 * - the part's status, told to the page's one SaveStatus (`onStatus`);
 * - `onSend(patch)` and `onSaved(patch)`: told of each save as it goes out and once it is confirmed, with the route's fields it sends;
 * - `adopt(name, value)`: the page read again holds `value` for a field nobody typed in: taken as stored, nothing sent (engine.ts adopt);
 * - `validate`: the part's rule in the browser, shared with the server (a field it names waits until the rule holds: the engine holds it back).
 * Nothing here moves the focus: „Näita“ of the page's chip goes to a refused field.
 */
export function useSeadedPart(o: {
  part: string;
  version: string;
  fields: Fields;
  label: (field: string) => string;
  focusField: (field: string) => void;
  onStatus?: StatusReport;
  onBlur?: readonly string[];
  group?: FieldGroup;
  onSend?: (patch: Fields) => void;
  onSaved?: (patch: Fields) => void;
  /** The part's own check in the browser (a pure rule shared with the server): a field it names is held back and said in the field, as the route's. */
  validate?: (fields: Fields) => Record<string, string>;
}) {
  const { part } = o;
  const [group] = useState(o.group);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const told = useRef({ onSend: o.onSend, onSaved: o.onSaved, onStatus: o.onStatus, label: o.label, focusField: o.focusField });
  useEffect(() => {
    told.current = { onSend: o.onSend, onSaved: o.onSaved, onStatus: o.onStatus, label: o.label, focusField: o.focusField };
  });

  const save = useMemo<SendPatch>(() => {
    const send = patchSender(`/api/admin/seaded/${part}`);
    return async (body, opts) => {
      const patch = toRoute(body.patch, group);
      told.current.onSend?.(patch);
      const answer = await send({ version: body.version, patch }, opts);
      const reply = answer && isRecord(answer.body) ? answer.body : null;
      if (answer?.status === 200 && reply?.ok === true) {
        setCodes((c) => without(c, Object.keys(patch)));
        told.current.onSaved?.(patch);
      } else if (answer?.status === 400 && reply?.error === "invalid" && isRecord(reply.fields)) {
        const fields = Object.fromEntries(Object.entries(reply.fields).filter((e): e is [string, string] => typeof e[1] === "string" && e[0] in patch));
        setCodes((c) => ({ ...c, ...fields }));
      }
      return answer ? { status: answer.status, body: answerToEngine(answer.body, group) } : answer;
    };
  }, [part, group]);
  const codesRef = useRef(codes);
  useEffect(() => {
    codesRef.current = codes;
  });
  // (a group's field is named by the member the route refused, else by its first)
  const memberOf = useCallback((name: string) => (group && name === group.name ? (group.members.find((m) => m in codesRef.current) ?? group.members[0]) : name), [group]);
  const label = useCallback((field: string) => told.current.label(memberOf(field)), [memberOf]);
  const focusField = useCallback((field: string) => told.current.focusField(memberOf(field)), [memberOf]);
  const [engineFields] = useState(() => toEngine(o.fields, group));
  const auto = useAutosave({ owner: "seaded", key: part, version: o.version, fields: engineFields, save, validate: o.validate, label, focusField });
  const { setField, flush, unconfirmed, status } = auto;

  useEffect(() => {
    told.current.onStatus?.(part, status);
  }, [part, status]);

  /** A field's value as the engine holds it (a group's member out of the group's field). */
  const held = (name: string): unknown => {
    if (group?.members.includes(name)) {
      const members = auto.fields[group.name];
      return isRecord(members) ? members[name] : undefined;
    }
    return auto.fields[name];
  };
  const fieldsNow = useRef(auto.fields);
  useEffect(() => {
    fieldsNow.current = auto.fields;
  });

  // the fields that commit on blur: what is typed waits here until the field is left
  const blurred = useMemo(() => new Set(o.onBlur ?? []), [o.onBlur]);
  const typed = useRef<Record<string, string>>({});
  const [typedView, setTypedView] = useState<Record<string, string>>({});
  const commit = useCallback(() => {
    const waiting = typed.current;
    if (Object.keys(waiting).length === 0) return;
    typed.current = {};
    setTypedView({});
    const together: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(waiting)) {
      if (group?.members.includes(name)) together[name] = value;
      else setField(name, value);
    }
    if (group && Object.keys(together).length > 0) {
      const members = fieldsNow.current[group.name];
      setField(group.name, { ...(isRecord(members) ? members : {}), ...together });
    }
  }, [setField, group]);
  // the tab hidden or the page put away while a number waits to be left: it is committed, so the engine keeps it in this browser and saves it
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState !== "hidden") return;
      commit();
      void flush();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", commit);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", commit);
    };
  }, [commit, flush]);
  const uid = useId();
  useGuardSource({
    id: `${uid}-typed`,
    label: () => told.current.label(Object.keys(typed.current)[0] ?? memberOf(unconfirmed()?.field ?? Object.keys(o.fields)[0])),
    flush: async () => {
      commit();
      return flush();
    },
    // typed and waiting, or — once the guard's flush has committed it — what the engine says of it (refused, offline): the guard asks either way
    unconfirmed: () => (Object.keys(typed.current).length > 0 ? { reason: "error" } : unconfirmed()),
    focus: () => {
      const name = Object.keys(typed.current)[0] ?? unconfirmed()?.field;
      if (name) told.current.focusField(memberOf(name));
    },
  });

  /** A field typed in: a blur field waits (its words go: judged again when it is left; a group's for both members), any other goes to the engine. */
  const type = useCallback(
    (name: string, value: unknown) => {
      setCodes((c) => without(c, group?.members.includes(name) ? group.members : [name]));
      if (blurred.has(name) && typeof value === "string") {
        typed.current = { ...typed.current, [name]: value };
        setTypedView(typed.current);
        return;
      }
      setField(name, value);
    },
    [blurred, setField, group],
  );

  /** What a field shows: what is typed and waits, else the engine's. */
  const text = (name: string): unknown => (name in typedView ? typedView[name] : held(name));
  /** The route's code of a refused field, or the browser's check of it (`validate`), while it is held back (not while it is being typed again). */
  const local = o.validate?.(auto.fields) ?? {};
  const codeOf = (name: string): string | undefined => (name in typedView ? undefined : (codes[name] ?? local[name]));
  /** Is a blur field typed and waiting to be left? */
  const typing = (name: string): boolean => name in typedView;

  return { status, text, type, typing, commit, flush, codeOf, setField, adopt: auto.adopt, conflict: auto.conflict, restore: auto.restore };
}
