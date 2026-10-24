"use client";

import { sectionCard } from "@/components/admin/SectionMap";
import type { AdminModule } from "@/server/admin-lessons";
import { LessonsEditor } from "../LessonsEditor";
import styles from "../CourseEditor.module.css";
import { CARD_ID } from "./course-view";

/**
 * „Moodulid ja õppetunnid“ / „Programm“ (README B2, B18) in its place among the cards, after „Õpiväljundid“: the existing LessonsEditor as it is (Task 9
 * rebuilds it), its forms saving each change at once (on a published course into the draft, server/admin-lessons.ts). It follows the drafted type
 * (`online`). A new course has no modules yet (`courseId` null): „Vajuta „Lisa koolitus“, et lisada mooduleid.“.
 */
export function ModulesCard({ courseId, online, modules }: { courseId: number | null; online: boolean; modules: AdminModule[] }) {
  return (
    <div id={CARD_ID.outline} className={`${sectionCard} ${styles.modules}`} tabIndex={-1}>
      <LessonsEditor courseId={courseId} online={online} modules={modules} />
    </div>
  );
}
