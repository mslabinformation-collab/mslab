"use client";

import type { TestQuestion } from "@/db/schema";
import { checkQuestions, readQuestions } from "@/domain/completion";
import { adminEt } from "@/i18n/dict/admin";
import { TestEditor, type TestErrors } from "../TestEditor";
import { Card } from "./Card";
import { CARD_ID, listChange } from "./course-view";
import type { PartApi } from "./types";

/**
 * Where a refusal of the questions is (TestEditor's `at`): the first problem of the list the refused save sent, by the rules the server checks it with
 * (domain/completion.ts checkQuestions), so the words stand in the card of the question they are about — named by its id (and its option's), so a
 * question moved since keeps them (README B2 "errors keyed by row id"). The autosave's answer names only the field. None: the list as a whole.
 */
function placeOf(questions: readonly TestQuestion[]): TestErrors["at"] {
  const checked = checkQuestions(readQuestions(questions));
  if (checked.ok) return undefined;
  const q = questions[checked.problem.index];
  if (!q) return undefined;
  const option = "option" in checked.problem && checked.problem.option !== undefined && q.kind === "choice" ? q.options[checked.problem.option]?.id : undefined;
  return { question: q.id, option };
}

/**
 * „Teadmiste test“ (an e-course's card; e-course completion, spec §5.1, R1): the questions with their answer key, the pass mark and the tries — the
 * test part (course_tests; its draft never reaches a public page). A question added, moved, removed or brought back saves now, through the part's
 * update (the form on screen when it lands); texts, marks and numbers when typing stops or the card is left. A question the check refuses holds the
 * part's questions back, with the words in that question's card.
 */
export function TestCard({ api }: { api: PartApi<"test"> }) {
  const t = adminEt.courseEditor;
  const v = api.fields;
  const questionsError = api.error("questions");
  // the list as the refused save sent it (else as it is): its problem's question, by id
  const refused = api.refusedValue("questions");
  const asSent = Array.isArray(refused) ? (refused as TestQuestion[]) : v.questions;
  return (
    <Card id={CARD_ID.test} label={t.sections.test} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore}>
      <TestEditor
        value={v}
        onChange={(next) => {
          if (next.questions !== v.questions) {
            if (listChange(v.questions, next.questions) === "instant") api.commit("questions", next.questions);
            else api.set("questions", next.questions);
          }
          if (next.passPercent !== v.passPercent) api.set("passPercent", next.passPercent);
          if (next.tries !== v.tries) api.set("tries", next.tries);
        }}
        onUpdate={(fn) => api.update("questions", fn)}
        errors={{ test: questionsError, testPassPercent: api.error("passPercent"), testTries: api.error("tries"), at: questionsError ? placeOf(asSent) : undefined }}
        unpublished={{ passPercent: api.unpublished("passPercent"), tries: api.unpublished("tries"), questions: api.unpublished("questions") }}
      />
    </Card>
  );
}
