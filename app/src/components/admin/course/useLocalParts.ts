"use client";

import { useMemo, type Dispatch, type SetStateAction } from "react";
import type { CourseDraft } from "@/domain/course-editor";
import { COURSE_PARTS, partValue, type EditorPart } from "@/domain/course-parts";
import { refusalText } from "./useCoursePart";
import type { CourseParts, PartApi } from "./types";

// The new course's cards (admin UX pass piece 3a, Task 7; piece3-texts S3-P3-g; README P1 §3.1 "New records are created by their one explicit
// button"): before „Lisa koolitus“ nothing is saved, so each card's part is a slice of the page's one draft (CourseDraft), and „Lisa koolitus“ sends it
// whole (createCourse). The refusal's field codes are the old save's names: the test's `test`, `testPassPercent`, `testTries`.

/** The create's name of a part's field (server/admin-content.ts saveCourseForm): the test's fields are named after the test. */
const CREATE_NAME: Record<string, string> = { questions: "test", passPercent: "testPassPercent", tries: "testTries" };

/** A part's field written into the whole draft (the test's live in `draft.test`). */
function withField(d: CourseDraft, part: EditorPart, name: string, value: unknown): CourseDraft {
  if (part === "test") return { ...d, test: { ...d.test, [name]: value } };
  return { ...d, [name]: value };
}

export function useLocalParts(o: {
  draft: CourseDraft;
  setDraft: Dispatch<SetStateAction<CourseDraft>>;
  refused: Record<string, string>;
  /** The draft the refused create sent (its lists' rows as they were then). */
  sent: CourseDraft | null;
  clear: (name: string) => void;
}): CourseParts {
  const { draft, setDraft, refused, sent, clear } = o;
  return useMemo(() => {
    const parts: Record<string, unknown> = {};
    for (const part of COURSE_PARTS) {
      if (part === "outline") continue;
      const fields = partValue(part, draft);
      /** A field typed in again: its refusal's words go. */
      const retyped = (name: string) => {
        const created = CREATE_NAME[name] ?? name;
        if (created in refused) clear(created);
      };
      const change = (name: string, value: unknown) => {
        retyped(name);
        setDraft((d) => withField(d, part, name, value));
      };
      const api: PartApi<typeof part> = {
        fields,
        set: change as PartApi<typeof part>["set"],
        commit: change as PartApi<typeof part>["commit"],
        update: ((name: string, fn: (v: unknown) => unknown) => {
          retyped(name);
          setDraft((d) => withField(d, part, name, fn((partValue(part, d) as Record<string, unknown>)[name])));
        }) as PartApi<typeof part>["update"],
        flush: () => {},
        error: (name) => {
          const code = refused[CREATE_NAME[name] ?? name];
          return code ? refusalText(code, part, name, draft.type) : undefined;
        },
        refusedValue: (name) => (sent && (CREATE_NAME[name] ?? name) in refused ? (partValue(part, sent) as Record<string, unknown>)[name] : undefined),
        unpublished: () => false,
        conflict: false,
        restore: () => {},
        attention: Object.keys(fields).some((name) => (CREATE_NAME[name] ?? name) in refused),
      };
      parts[part] = api;
    }
    return parts as CourseParts;
  }, [draft, setDraft, refused, sent, clear]);
}
