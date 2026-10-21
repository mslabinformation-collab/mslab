"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import { AutosaveEngine, type Fields, type SendPatch } from "./engine";

/** This browser's localStorage, or null where it is blocked (the engine then saves without a copy). */
function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The autosave of one form part (admin UX pass, README §1.3): the engine (./engine.ts) made once per mount, started with the screen and stopped
 * with it. `owner`, `key`, `version`, `fields`, `save` and `validate` are read at mount: a screen given another row or version remounts it (a
 * React `key`). The status of held-back fields names them by `label` (SaveStatus shows the state; the screen marks the fields).
 * `unconfirmed` is what the leave guard (Task 10) asks before the text is left; it registers here.
 */
export function useAutosave(o: {
  owner: string;
  key: string;
  version: string;
  fields: Fields;
  save: SendPatch;
  validate?: (f: Fields) => Record<string, string>;
  label: (field: string) => string;
}) {
  const [engine] = useState(() => new AutosaveEngine({ owner: o.owner, key: o.key, version: o.version, fields: o.fields, send: o.save, validate: o.validate }));
  useEffect(() => {
    engine.start(browserStorage());
    return () => engine.stop();
  }, [engine]);
  const snap = useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);
  const { label } = o;
  const status = useMemo<AutosaveStatus>(() => (snap.status.kind === "invalid" ? { kind: "invalid", fields: snap.status.fields.map(label) } : snap.status), [snap.status, label]);
  const api = useMemo(
    () => ({
      setField: (name: string, value: unknown) => engine.setField(name, value),
      flush: () => engine.flush(),
      restore: () => engine.restore(),
      unconfirmed: () => engine.unconfirmed(),
    }),
    [engine],
  );
  return { status, fields: snap.fields, conflict: snap.conflict, ...api };
}
