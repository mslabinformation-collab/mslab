"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { patchSender, SAVE_TIMEOUT_MS, type Fields, type SendPatch } from "@/components/admin/autosave/engine";
import { useAutosave } from "@/components/admin/autosave/useAutosave";
import type { EditorPart, PartSeed } from "@/domain/course-parts";
import { adminEt } from "@/i18n/dict/admin";
import { COURSE_COPY_OWNER, courseCopyKey } from "@/lib/course-copies";
import { stableJson } from "@/lib/version";
import { CARD_ID, fieldLabel, listChange } from "./course-view";
import type { PartApi } from "./types";

// One card's autosave on a saved course (admin UX pass piece 3a, Task 7; README B2, §1.3): the shared engine (autosave/useAutosave.ts, used as it is)
// on POST /api/admin/koolitus/<id>/osa/<part> (Task 4: a published course's save is its draft, an unpublished one's goes to the record), from the
// part's version the page read (R-b). The sender is the engine's patchSender, with an ear on its answers: a 400's field codes are kept, with the
// value each refused field was sent with, so the card can say at the field what its check refused (the engine holds those fields back and saves the
// rest) and a list can place the words on the row they are about (Task 8: by the row's id in what was sent), and a field typed in again or saved
// loses its words; and the screen's `ear` hears each save as it goes and as it ends (an unpublished course's type, SavedCourse.tsx). A save's end
// is never waited for beyond SAVE_TIMEOUT_MS, whatever the request does: the sender's own bound, set before the request's, says `late` then (its outcome
// unknown), so nothing the screen holds for a save's end can wait for good (review round 3). The copy in this browser is
// `mslab-draft:koolitus:<id>-<part>:<tab>`.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A save's answer as the engine takes it: the status and the body, or null (none, or the browser's error). */
export type SaveAnswer = Awaited<ReturnType<SendPatch>>;
/**
 * Hears a card's saves: `sent`, a save goes with this patch; `ended`, it ended with this answer — `late` when none came in SAVE_TIMEOUT_MS (the
 * answer is then null, its outcome unknown).
 */
export type SaveEar = { sent: (patch: Fields) => void; ended: (patch: Fields, answer: SaveAnswer, late: boolean) => void };
const errors = adminEt.courseEditor.errors as Record<string, string>;

/** The words of a refusal's code: the course editor's field errors (an e-course's locked type has its own); anything else, the generic line. */
export function refusalText(code: string, part: EditorPart, field: string, liveType: string): string {
  if (part === "basics" && field === "type" && code === "typeLocked" && liveType === "e_learning") return adminEt.courseEditor.typeLockedOnline;
  return errors[code] ?? adminEt.courseEditor.invalid;
}

/** The element a field of the part is in on the page, for „Jää siia“ and SaveStatus's „Näita“: the field itself, else its card. */
export function focusPartField(part: EditorPart, name: string): void {
  const editor = document.querySelector("[data-course-editor]") ?? document;
  const exact = editor.querySelector<HTMLElement>(`[data-i18n="${name}"], [data-field="${name}"]`);
  const card = document.getElementById(CARD_ID[part]);
  const target = exact ?? card?.querySelector<HTMLElement>("[aria-invalid='true'], [data-invalid]") ?? card;
  target?.focus();
}

export function useCoursePart<P extends EditorPart>(o: {
  courseId: number;
  part: P;
  seed: PartSeed<P>;
  /** A published course: its saves are its draft, and a field that differs from live says „· avaldamata“. */
  published: boolean;
  liveType: string;
  /** Told of each save as it goes and as it ends (read when it does). */
  ear?: { readonly current: SaveEar | null };
}) {
  const { courseId, part, seed, published, liveType, ear } = o;
  /** Each refused field's code and the value the refused save sent. */
  const [codes, setCodes] = useState<Record<string, { code: string; sent: unknown }>>({});
  /** The saves the server took since the card started: a part held back at the publish is listed until its next one (review M-3). */
  const [saves, setSaves] = useState(0);
  const send = useMemo<SendPatch>(() => {
    const base = patchSender(`/api/admin/koolitus/${courseId}/osa/${part}`);
    return async (body, opts) => {
      // the bound, set before the request's own (patchSender's, at the same delay), so at SAVE_TIMEOUT_MS this one is first: `late`
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), SAVE_TIMEOUT_MS)));
      ear?.current?.sent(body.patch);
      const result = await Promise.race([base(body, opts), late]);
      clearTimeout(timer);
      const answer = result === "late" ? null : result;
      const reply = answer && isRecord(answer.body) ? answer.body : null;
      if (answer?.status === 400 && reply?.error === "invalid" && isRecord(reply.fields)) {
        const named = Object.fromEntries(
          Object.entries(reply.fields)
            .filter(([name, code]) => name in body.patch && typeof code === "string")
            .map(([name, code]) => [name, { code: code as string, sent: body.patch[name] }]),
        );
        setCodes((c) => ({ ...c, ...named }));
      } else if (answer?.status === 200 && reply?.ok === true) {
        setCodes((c) => Object.fromEntries(Object.entries(c).filter(([name]) => !(name in body.patch))));
      }
      if (answer?.status === 200 && reply?.ok === true) setSaves((n) => n + 1);
      ear?.current?.ended(body.patch, answer, result === "late");
      return answer;
    };
  }, [courseId, part, ear]);
  const label = useCallback((field: string) => fieldLabel(part, field), [part]);
  const auto = useAutosave({
    owner: COURSE_COPY_OWNER,
    key: courseCopyKey(courseId, part),
    version: seed.version,
    fields: seed.value as Fields,
    save: send,
    label,
    focusField: (name) => focusPartField(part, name),
  });

  const fields = auto.fields as PartApi<P>["fields"];
  // what the newest render holds: an upload that ends after other changes adds to the list as it is then (GalleryEditor's update functions)
  const latest = useRef(fields);
  useLayoutEffect(() => {
    latest.current = fields;
  });

  const { setField, flush, restore, conflict } = auto;
  const live = seed.live as Record<string, unknown>;
  const api = useMemo<PartApi<P>>(() => {
    /** A field typed in: its refusal's words go, and the engine has it. */
    const take = (name: string, value: unknown) => {
      setCodes((c) => (name in c ? Object.fromEntries(Object.entries(c).filter(([n]) => n !== name)) : c));
      setField(name, value);
    };
    return {
      fields,
      set: (name, value) => take(name, value),
      commit: (name, value) => {
        take(name, value);
        void flush();
      },
      update: (name, fn) => {
        const before = latest.current[name];
        const after = fn(before);
        latest.current = { ...latest.current, [name]: after };
        take(name, after);
        if (Array.isArray(before) && Array.isArray(after) && listChange(before, after) === "instant") void flush();
      },
      flush: () => void flush(),
      error: (name: string) => (codes[name] ? refusalText(codes[name].code, part, name, liveType) : undefined),
      refusedValue: (name: string) => codes[name]?.sent,
      unpublished: (name: string) => published && stableJson((fields as Record<string, unknown>)[name]) !== stableJson(live[name]),
      conflict: conflict !== null,
      restore: () => void restore(),
      attention: auto.status.kind === "invalid" || auto.status.kind === "conflict" || auto.status.kind === "gone",
    };
  }, [fields, setField, flush, restore, conflict, codes, part, liveType, published, live, auto.status.kind]);
  return {
    api,
    status: auto.status,
    saves,
    flushNow: auto.flush,
    unconfirmed: auto.unconfirmed,
    discardCopy: auto.discardCopy,
  };
}
