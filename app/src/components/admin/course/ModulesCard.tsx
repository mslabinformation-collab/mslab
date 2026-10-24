"use client";

import { sectionCard } from "@/components/admin/SectionMap";
import type { AdminModule } from "@/server/admin-lessons";
import { LessonsEditor } from "../LessonsEditor";
import styles from "../CourseEditor.module.css";
import { CARD_ID } from "./course-view";

/**
 * „Moodulid ja õppetunnid“ / „Programm“ (README B2, B18) in its place among the cards, after „Õpiväljundid“: LessonsEditor (Task 9) — the module rows
 * dragged and moved with ↑ / ↓, their names autosaved, the lessons with their video tags — its adds, moves and deletes saved at once by their actions
 * (on a published course into the draft, server/admin-lessons.ts). It follows the drafted type (`online`). A new course has no modules yet (`courseId`
 * null): „Vajuta „Lisa koolitus“, et lisada mooduleid.“.
 */
export function ModulesCard({ courseId, online, modules }: { courseId: number | null; online: boolean; modules: AdminModule[] }) {
  return (
    <div id={CARD_ID.outline} className={`${sectionCard} ${styles.modules}`} tabIndex={-1}>
      <LessonsEditor courseId={courseId} online={online} modules={modules} />
    </div>
  );
}
