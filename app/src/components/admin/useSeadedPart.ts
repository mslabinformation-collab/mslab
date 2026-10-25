"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import { patchSender, type Fields, type SendPatch } from "./autosave/engine";
import { useAutosave } from "./autosave/useAutosave";
import { useGuardSource } from "./LeaveGuard";

/** What a card tells the page of its parts: the part's name and its status (SettingsEditor puts them in its one SaveStatus). */
export type StatusReport = (part: string, status: AutosaveStatus) => void;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const without = (codes: Record<string, string>, names: string[]): Record<string, string> => {
  if (!names.some((n) => n in codes)) return codes;
  const out = { ...codes };
  for (const n of names) delete out[n];
  return out;
};

/**
 * One Seaded card's part, autosaved on POST /api/admin/seaded/<part> (admin UX pass piece 3b, Task 4; README B4; server/seaded.ts):
 * - the engine (autosave/useAutosave.ts: a field saves 1.5 s after typing and at once on `flush`, the copy in this browser, the leave guard), owner
 *   "seaded", the part its key; the route's version is the one the page read;
 * - the route's refusals by field (`codes`, the server's code of each field it held back), until the field is typed in again or a save of it
 *   comes through: the card says them in its own words, in the field;
 * - `onBlur`: the fields that commit on blur (behaviours conflict 13: „Järgmine number“, and the invoice's prefix): typed, they wait here
 *   (`text(name)`), and leaving the field (`commit()`), or the page — a link, Back (the leave guard's flush), the tab hidden or put away (then the
 *   engine's copy in this browser holds it too) — gives them to the engine and saves them;
 * - the part's status, told to the page's one SaveStatus (`onStatus`);
 * - `onSaved(patch)`: told of each confirmed save, with what it sent;
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
  onSaved?: (patch: Fields) => void;
  /** The part's own check in the browser (a pure rule shared with the server): a field it names is held back and said in the field, as the route's. */
  validate?: (fields: Fields) => Record<string, string>;
}) {
  const { part } = o;
  const [codes, setCodes] = useState<Record<string, string>>({});
  const told = useRef({ onSaved: o.onSaved, onStatus: o.onStatus, label: o.label, focusField: o.focusField });
  useEffect(() => {
    told.current = { onSaved: o.onSaved, onStatus: o.onStatus, label: o.label, focusField: o.focusField };
  });

  const save = useMemo<SendPatch>(() => {
    const send = patchSender(`/api/admin/seaded/${part}`);
    return async (body, opts) => {
      const answer = await send(body, opts);
      const reply = answer && isRecord(answer.body) ? answer.body : null;
      if (answer?.status === 200 && reply?.ok === true) {
        setCodes((c) => without(c, Object.keys(body.patch)));
        told.current.onSaved?.(body.patch);
      } else if (answer?.status === 400 && reply?.error === "invalid" && isRecord(reply.fields)) {
        const fields = Object.fromEntries(Object.entries(reply.fields).filter((e): e is [string, string] => typeof e[1] === "string" && e[0] in body.patch));
        setCodes((c) => ({ ...c, ...fields }));
      }
      return answer;
    };
  }, [part]);
  const label = useCallback((field: string) => told.current.label(field), []);
  const focusField = useCallback((field: string) => told.current.focusField(field), []);
  const auto = useAutosave({ owner: "seaded", key: part, version: o.version, fields: o.fields, save, validate: o.validate, label, focusField });
  const { setField, flush, unconfirmed, status } = auto;

  useEffect(() => {
    told.current.onStatus?.(part, status);
  }, [part, status]);

  // the fields that commit on blur: what is typed waits here until the field is left
  const blurred = useMemo(() => new Set(o.onBlur ?? []), [o.onBlur]);
  const typed = useRef<Record<string, string>>({});
  const [typedView, setTypedView] = useState<Record<string, string>>({});
  const commit = useCallback(() => {
    const waiting = typed.current;
    if (Object.keys(waiting).length === 0) return;
    typed.current = {};
    setTypedView({});
    for (const [name, value] of Object.entries(waiting)) setField(name, value);
  }, [setField]);
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
    label: () => told.current.label(Object.keys(typed.current)[0] ?? unconfirmed()?.field ?? Object.keys(o.fields)[0]),
    flush: async () => {
      commit();
      return flush();
    },
    unconfirmed: () => (Object.keys(typed.current).length > 0 ? { reason: "error" } : null),
    focus: () => {
      const name = Object.keys(typed.current)[0];
      if (name) told.current.focusField(name);
    },
  });

  /** A field typed in: a blur field waits (its words go: judged again when it is left), any other goes to the engine. */
  const type = useCallback(
    (name: string, value: unknown) => {
      setCodes((c) => without(c, [name]));
      if (blurred.has(name) && typeof value === "string") {
        typed.current = { ...typed.current, [name]: value };
        setTypedView(typed.current);
        return;
      }
      setField(name, value);
    },
    [blurred, setField],
  );

  /** What a field shows: what is typed and waits, else the engine's. */
  const text = (name: string): unknown => (name in typedView ? typedView[name] : auto.fields[name]);
  /** The route's code of a refused field, or the browser's check of it (`validate`), while it is held back (not while it is being typed again). */
  const local = o.validate?.(auto.fields) ?? {};
  const codeOf = (name: string): string | undefined => (name in typedView ? undefined : (codes[name] ?? local[name]));
  /** Is a blur field typed and waiting to be left? */
  const typing = (name: string): boolean => name in typedView;

  return { status, fields: auto.fields, text, type, typing, commit, flush, codeOf, setField, conflict: auto.conflict, restore: auto.restore };
}
