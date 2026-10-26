"use client";

import { startTransition, useActionState, useEffect, useState, type FormEvent, type RefObject } from "react";
import { adminEt } from "@/i18n/dict/admin";
import type { EditResult, FieldError } from "@/server/edit-check";
import { afterReload, afterSave, dirtyParts as changedParts, type Loaded } from "./site-draft";

export type { Loaded } from "./site-draft";

type Action = (prev: EditResult | null, formData: FormData) => Promise<EditResult>;
export type SaveStatus = { text: string; tone: "error" | "success" | "hint"; stale: boolean };

/**
 * The draft of a site editor page (Hüpikaken's campaign, a post; the home page, practice and trainer are on the autosaved draft layer since admin UX
 * pass piece 4a, components/admin/site/useSitePart.ts, and Seaded since piece 3b — piece 4b moves the rest), saved with one
 * "Salvesta". Only the parts that differ from what was loaded are sent, each with the version it was loaded at; the
 * server refuses a part that was saved elsewhere meanwhile (stale) and returns the saved parts as now stored, which
 * become the new starting point (site-draft.ts afterSave: a part edited while the save was on its way keeps the newer
 * edits). `always`: send every part even when unchanged (a new post: the save creates it). While there are unsaved
 * changes, leaving the page asks first (beforeunload); a refused save puts the focus on the first marked field of `form`.
 */
export function useSiteDraft<V extends Record<string, unknown>>(initial: Loaded<V>, action: Action, form: RefObject<HTMLFormElement | null>, opts: { always?: boolean } = {}) {
  const [draft, setDraft] = useState<V>(initial.values);
  const [base, setBase] = useState<Loaded<V>>(initial);
  const [state, dispatch, pending] = useActionState<EditResult | null, FormData>(action, null);
  const [seen, setSeen] = useState<EditResult | null>(null);
  const [lastInitial, setLastInitial] = useState(initial);
  // what the last save sent, part by part (to tell edits made while it was on its way)
  const [sent, setSent] = useState<Partial<V>>({});
  const [nothing, setNothing] = useState(false);

  // Follow the stored content (adjusting state while rendering): first a save's result, then a new render of the page.
  let next: { draft: V; base: Loaded<V> } | null = null;
  if (state !== seen) {
    setSeen(state);
    if (state?.ok && state.saved) next = afterSave(draft, base, sent, state.saved);
  }
  if (initial !== lastInitial) {
    setLastInitial(initial);
    next = afterReload(next?.draft ?? draft, next?.base ?? base, initial);
  }
  if (next) {
    setDraft(next.draft);
    setBase(next.base);
  }

  const keys = Object.keys(draft) as (keyof V & string)[];
  const dirtyParts = changedParts(draft, base);
  const dirty = dirtyParts.length > 0;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!state || state.ok || state.error !== "invalid") return;
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid]')?.focus();
  }, [state, form]);

  const set = <K extends keyof V>(key: K, value: V[K]) => {
    setNothing(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  /** A functional update of one part (an upload can finish after other edits: it must add to the part as it is then). */
  const update = <K extends keyof V>(key: K, fn: (value: V[K]) => V[K]) => {
    setNothing(false);
    setDraft((d) => ({ ...d, [key]: fn(d[key]) }));
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const send = opts.always ? keys : dirtyParts;
    if (send.length === 0) return setNothing(true);
    setNothing(false);
    const parts = Object.fromEntries(send.map((k) => [k, { version: base.versions[k] ?? "", value: draft[k] }]));
    setSent(Object.fromEntries(send.map((k) => [k, draft[k]])) as Partial<V>);
    const fd = new FormData();
    fd.set("data", JSON.stringify({ parts }));
    startTransition(() => dispatch(fd));
  };

  const fields = state && !state.ok ? (state.fields ?? {}) : {};
  /** The error text of a field ("slides.0.title", "MAXI.price"), if the last save refused it. */
  const err = (name: string): string | undefined => {
    const code = fields[name] as FieldError | undefined;
    return code ? adminEt.courseEditor.errors[code] : undefined;
  };
  /** Does any refused field start with this prefix ("slides.2.")? */
  const hasErrors = (prefix: string) => Object.keys(fields).some((k) => k.startsWith(prefix));

  const t = adminEt.editor;
  const status: SaveStatus = pending
    ? { text: t.saving, tone: "hint", stale: false }
    : state && !state.ok
      ? { text: state.error === "invalid" ? t.invalid : state.error === "stale" ? t.stale : state.error === "notFound" ? adminEt.post.notFound : adminEt.common.saveError, tone: "error", stale: state.error === "stale" }
      : dirty
        ? { text: t.dirty, tone: "hint", stale: false }
        : nothing
          ? { text: t.clean, tone: "hint", stale: false }
          : state?.ok
            ? { text: t.saved, tone: "success", stale: false }
            : { text: "", tone: "hint", stale: false };

  return { draft, base, set, update, submit, pending, state, dirty, err, hasErrors, status };
}
