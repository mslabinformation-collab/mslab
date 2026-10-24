"use client";

import { checkQuestions, readQuestions } from "@/domain/completion";
import type { TestDraft } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { TestEditor, type TestErrors } from "../TestEditor";
import { Card } from "./Card";
import { CARD_ID, listChange } from "./course-view";
import type { PartApi } from "./types";

/**
 * Where a refusal of the questions is (TestEditor's `at`): the first problem the list has, by the rules the server checks it with (domain/completion.ts
 * checkQuestions), so the words stand in the card of the question they are about. The autosave's answer names only the field.
 */
function placeOf(questions: TestDraft["questions"]): TestErrors["at"] {
  const checked = checkQuestions(readQuestions(questions));
  if (checked.ok) return undefined;
  const { index } = checked.problem;
  return { index, option: "option" in checked.problem ? checked.problem.option : undefined };
}

/**
 * „Teadmiste test“ (an e-course's card; e-course completion, spec §5.1, R1): the questions with their answer key, the pass mark and the tries — the
 * test part (course_tests; its draft never reaches a public page). TestEditor as it is until Task 8. A question added, removed or moved saves now;
 * texts, marks and numbers when typing stops or the card is left. A question the check refuses holds the part's questions back, with the words in
 * that question's card.
 */
export function TestCard({ api }: { api: PartApi<"test"> }) {
  const t = adminEt.courseEditor;
  const v = api.fields;
  const questionsError = api.error("questions");
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
        errors={{ test: questionsError, testPassPercent: api.error("passPercent"), testTries: api.error("tries"), at: questionsError ? placeOf(v.questions) : undefined }}
      />
    </Card>
  );
}
