"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import { useGuardScope, useGuardSource } from "../LeaveGuard";
import { AutosaveEngine, type Fields, type SendPatch } from "./engine";

/** This browser's localStorage, or null where it is blocked (the engine then saves without a copy). */
function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The first element named `name` where the form is: inside the open drawer for a drawer's form, else outside every dialog (then any). */
function focusByName(name: string, scope: "page" | "drawer"): void {
  const named = Array.from(document.querySelectorAll<HTMLElement>("[name]")).filter((el) => el.getAttribute("name") === name);
  const here = named.find((el) => (scope === "drawer" ? el.closest("dialog[data-drawer][open]") !== null : el.closest("dialog") === null));
  (here ?? named[0])?.focus();
}

/**
 * The autosave of one form part (admin UX pass, README §1.3): the engine (./engine.ts) made once per mount, started with the screen and stopped
 * with it. `owner`, `key`, `version`, `fields`, `save` and `validate` are read at mount: a screen given another row or version remounts it (a
 * React `key`). The status of held-back fields names them by `label` (SaveStatus shows the state; the screen marks the fields).
 *
 * It registers with the leave guard (LeaveGuard.tsx, README §1.5) while mounted: a move away waits for its save, or asks with the name of the field
 * concerned (`label(field)`; `title` when no field in particular is: a save whose answer was lost; without a title, the form's first field), and
 * „Jää siia“ focuses that field: `focusField(name)`, by default the first element with that `name` attribute in this form's drawer or page.
 */
export function useAutosave(o: {
  owner: string;
  key: string;
  version: string;
  fields: Fields;
  save: SendPatch;
  validate?: (f: Fields) => Record<string, string>;
  label: (field: string) => string;
  title?: string;
  focusField?: (name: string) => void;
}) {
  const [engine] = useState(() => new AutosaveEngine({ owner: o.owner, key: o.key, version: o.version, fields: o.fields, send: o.save, validate: o.validate }));
  useEffect(() => {
    engine.start(browserStorage());
    return () => engine.stop();
  }, [engine]);
  const snap = useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);
  const { label } = o;

  const scope = useGuardScope();
  const id = useId();
  /** The field the guard's notice named: „Jää siia“ goes there even if it has been saved meanwhile. */
  const named = useRef<string | null>(null);
  const names = useRef({ label: o.label, title: o.title, focusField: o.focusField, scope });
  useEffect(() => {
    names.current = { label: o.label, title: o.title, focusField: o.focusField, scope };
  });
  useGuardSource({
    id,
    label: () => {
      const n = names.current;
      const field = engine.unconfirmed()?.field ?? null;
      named.current = field ?? Object.keys(engine.snapshot().fields)[0] ?? null;
      if (field !== null) return n.label(field);
      return n.title ?? (named.current !== null ? n.label(named.current) : "");
    },
    flush: () => engine.flush(),
    unconfirmed: () => engine.unconfirmed(),
    focus: () => {
      const n = names.current;
      const field = named.current ?? engine.unconfirmed()?.field ?? Object.keys(engine.snapshot().fields)[0] ?? null;
      if (field === null) return;
      if (n.focusField) n.focusField(field);
      else focusByName(field, n.scope);
    },
  });

  const status = useMemo<AutosaveStatus>(() => (snap.status.kind === "invalid" ? { kind: "invalid", fields: snap.status.fields.map(label) } : snap.status), [snap.status, label]);
  const api = useMemo(
    () => ({
      setField: (name: string, value: unknown) => engine.setField(name, value),
      flush: () => engine.flush(),
      restore: () => engine.restore(),
      unconfirmed: () => engine.unconfirmed(),
      /** The part's text was thrown away on the server: its copies in this browser go, nothing more is sent (engine.ts discardCopy). */
      discardCopy: () => engine.discardCopy(),
      /** The page read again holds `value` for an untouched field: taken as confirmed, nothing sent (engine.ts adopt). */
      adopt: (name: string, value: unknown) => engine.adopt(name, value),
      /** The conflict as it is now (`conflict` is the one of the last render): for an async handler that has awaited a flush, which may have met one. */
      conflictNow: () => engine.snapshot().conflict,
      /** The server's version as the form last heard it (engine.ts confirmedVersion): what a publish of the part goes from, after a flush. */
      versionNow: () => engine.confirmedVersion(),
    }),
    [engine],
  );
  return { status, fields: snap.fields, conflict: snap.conflict, ...api };
}
