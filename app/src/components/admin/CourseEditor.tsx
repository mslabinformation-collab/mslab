"use client";

import { useEffect } from "react";
import type { AdminModule } from "@/server/admin-lessons";
import { dropNewCourseCopy, NewCourse } from "./course/NewCourse";
import { SavedCourse } from "./course/SavedCourse";
import type { CourseEditorData, OtherCourse } from "./course/types";

export type { CourseEditorData, OtherCourse } from "./course/types";

/**
 * The course editor (admin UX pass piece 3a, Task 7; README B2): a shell over its cards (course/, one component per card). A saved course
 * (`course`): every card autosaves its part, a published course's into its draft with the PublishBar under the H1 (course/SavedCourse.tsx). A new
 * course (`course` null, /admin/koolitused/uus): the same cards, created by the one explicit „Lisa koolitus“ (course/NewCourse.tsx). There is no
 * page-wide „Salvesta“ and no beforeunload of its own: the leave guard (LeaveGuard.tsx) covers what is not saved yet.
 */
export function CourseEditor({
  course,
  others,
  next,
  created,
  modules,
}: {
  course: CourseEditorData | null;
  /** The other courses (recommendations). */
  others: OtherCourse[];
  /** The next session of the course (the badge's card preview, its meta line). */
  next: { startsAt: string; city: string } | null;
  /** Just created (?loodud=1): the notice, and this browser's copy of the new-course page goes. */
  created: boolean;
  /** „Moodulid ja õppetunnid“ / „Programm“ (LessonsEditor, in its place among the cards). */
  modules: AdminModule[];
}) {
  useEffect(() => {
    if (created) dropNewCourseCopy();
  }, [created]);
  return course ? <SavedCourse data={course} others={others} next={next} created={created} modules={modules} /> : <NewCourse others={others} next={next} modules={modules} />;
}
