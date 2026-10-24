import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LESSON_LIMITS, lessonTextProblems, textProblem } from "@/domain/lesson-limits";
import type { I18n } from "@/i18n/field";
import { LESSON_LIMITS as OUTLINE_LIMITS } from "@/server/course-outline";
import { Check } from "@/server/edit-check";

// One rule for a module's and a lesson's texts in the browser and on the server (admin UX pass piece 3a, final review P10-1 / M-2): the limits and the
// check are domain/lesson-limits.ts's, which the server's Check.text runs and the lesson drawer and the modules card check by before they send. The
// copies by hand had drifted: the card measured the untrimmed name, the server the trimmed one.

const source = (...path: string[]) => readFileSync(join(process.cwd(), "src", ...path), "utf8");
const a = (n: number) => "a".repeat(n);

/** Texts on each side of the rule: blank, padded, at the limit and one past it, in either language, the Russian one alone. */
const texts = (max: number): I18n[] => [
  { et: "" },
  { et: "   " },
  { et: "", ru: "только" },
  { et: " ", ru: "  " },
  { et: "Nimi" },
  { et: "Nimi", ru: "Имя" },
  { et: a(max) },
  { et: ` ${a(max)} ` },
  { et: a(max + 1) },
  { et: `  ${a(max + 1)}` },
  { et: "Nimi", ru: a(max + 1) },
  { et: "Nimi", ru: ` ${a(max)} ` },
  { et: "", ru: a(max + 1) },
];

describe("the lesson texts' limits and rule (domain/lesson-limits.ts)", () => {
  test("the server's check (Check.text) says what textProblem says, for a name (needed) and a short text (optional), at both limits", () => {
    for (const max of [LESSON_LIMITS.title, LESSON_LIMITS.body])
      for (const required of [true, false])
        for (const f of texts(max)) {
          const c = new Check();
          c.text("x", f, max, { required });
          expect(c.errors.x ?? null, `${JSON.stringify(f).slice(0, 40)} max ${max} required ${required}`).toBe(textProblem(f, max, { required }));
        }
  });

  test("the limits are trimmed lengths: spaces round a text never make it too long, and a name of spaces is no name", () => {
    expect(textProblem({ et: ` ${a(LESSON_LIMITS.title)} ` }, LESSON_LIMITS.title)).toBeNull();
    expect(textProblem({ et: a(LESSON_LIMITS.title + 1) }, LESSON_LIMITS.title)).toBe("tooLong");
    expect(textProblem({ et: "   " }, LESSON_LIMITS.title, { required: true })).toBe("required");
    // the drawer's and the card's codes, by field
    expect(lessonTextProblems({ title: { et: " " }, body: { et: "", ru: "Текст" } })).toEqual({ title: "required", body: "required" });
    expect(lessonTextProblems({ title: { et: a(121) }, body: { et: a(5001) } })).toEqual({ title: "tooLong", body: "tooLong" });
    expect(lessonTextProblems({ title: { et: "Moodul" } })).toEqual({});
    expect(LESSON_LIMITS).toEqual({ title: 120, body: 5000 });
  });

  test("one copy: the server's outline uses this module's limits, and the browser's fields hold no limit or rule of their own", () => {
    expect(OUTLINE_LIMITS).toBe(LESSON_LIMITS);
    for (const file of [["components", "admin", "LessonDrawer.tsx"], ["components", "admin", "LessonsEditor.tsx"]]) {
      const code = source(...file);
      expect(code, file.join("/")).toMatch(/from "@\/domain\/lesson-limits"/);
      expect(code, file.join("/")).not.toMatch(/\b(TITLE_MAX|BODY_MAX)\b|\b(120|5000)\b/);
      expect(code, file.join("/")).not.toMatch(/\.trim\(\)\.length\s*>/);
    }
    expect(source("server", "course-outline.ts")).not.toMatch(/LESSON_LIMITS\s*=/);
    expect(source("server", "admin-lessons.ts")).toMatch(/import \{ LESSON_LIMITS \} from "@\/domain\/lesson-limits"/);
  });

  test("one focus rule after an undo (components/admin/focus-fell.ts): the lesson drawer, its files and the list editors share it", () => {
    for (const file of ["LessonDrawer.tsx", "LessonFiles.tsx", "ListEditor.tsx", "ProtocolStagesEditor.tsx", "TestEditor.tsx"]) {
      const code = source("components", "admin", file);
      expect(code, file).toMatch(/import \{ focusFell \} from "\.\/focus-fell";/);
      expect(code, file).not.toMatch(/(const|function)\s+focusFell\b/);
    }
    expect(source("components", "admin", "useListRows.ts")).not.toMatch(/focusFell/);
  });
});
