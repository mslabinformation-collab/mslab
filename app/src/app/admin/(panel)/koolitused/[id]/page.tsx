import type { Metadata } from "next";
import Link from "next/link";
import { CourseEditor, type OtherCourse } from "@/components/admin/CourseEditor";
import { Drawer } from "@/components/admin/Drawer";
import { LessonDrawer } from "@/components/admin/LessonDrawer";
import { LessonsEditor } from "@/components/admin/LessonsEditor";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { courseUsage, getCourseForEdit, listAllCourses, typeLocked } from "@/db/queries/admin";
import { getCourseBySlug } from "@/db/queries/public";
import { draftFromCourse, newCourseDraft } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { parseRowId } from "@/lib/row-id";
import { listCourseLessons } from "@/server/admin-lessons";
import { requireAdmin } from "@/server/auth";
import { bunnyConfig } from "@/server/bunny";
import { upcomingFrom } from "@/domain/calendar";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** "uus" → a new course; a row id (lib/row-id.ts) → that course; anything else → not found. */
function parseId(raw: string): number | "new" | null {
  return raw === "uus" ? "new" : parseRowId(raw);
}

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const id = parseId((await params).id);
  return { title: adminTitle(id === "new" ? adminEt.courseEditor.newTitle : adminEt.courseEditor.editCrumb) };
}

/**
 * The course editor: /admin/koolitused/uus (new) and /admin/koolitused/<id>; under it "Moodulid ja õppetunnid" (an e-course) or
 * "Programm" (a contact course), and with ?oppetund=<lesson id> that lesson in the drawer.
 */
export default async function CourseEditPage({ params, searchParams }: Props) {
  await requireAdmin();
  const [{ id: raw }, sp] = await Promise.all([params, searchParams]);
  const id = parseId(raw);
  const db = getDb();
  const [course, all, usage, modules] = await Promise.all([
    typeof id === "number" ? getCourseForEdit(db, id) : null,
    listAllCourses(db),
    typeof id === "number" ? courseUsage(db, id) : null,
    typeof id === "number" ? listCourseLessons(db, id) : [],
  ]);
  const t = adminEt.courseEditor;

  if (id === null || (id !== "new" && !course)) {
    return (
      <div className={ui.page}>
        <div className={ui.heading}>
          <h1 className={ui.h1}>{adminEt.nav.courses}</h1>
        </div>
        <section className={ui.card}>
          <p className={ui.empty}>{t.notFound}</p>
          <Link className={ui.link} href="/admin/koolitused">
            {t.back}
          </Link>
        </section>
      </div>
    );
  }

  // the card preview's meta line: the next scheduled session of a contact course
  const detail = course && course.type === "contact" ? await getCourseBySlug(db, course.slug, { includeUnpublished: true, sessionsFrom: upcomingFrom(new Date()) }) : null;
  const next = detail?.sessions.find((s) => s.status === "scheduled");
  // ?oppetund=<id>: a lesson of this course opens in the drawer; any other value opens nothing
  const lessonId = typeof sp.oppetund === "string" ? parseRowId(sp.oppetund) : null;
  const lesson = course && lessonId !== null ? (modules.flatMap((m) => m.lessons).find((l) => l.id === lessonId) ?? null) : null;
  const others: OtherCourse[] = all
    .filter((c) => c.id !== course?.id)
    .map((c) => ({ id: c.id, title: pick(c.title, "et"), type: c.type, published: c.published }));

  return (
    <>
      <CourseEditor
        initial={course ? draftFromCourse(course) : newCourseDraft()}
        others={others}
        next={next ? { startsAt: next.startsAt.toISOString(), city: next.city } : null}
        publicHref={course?.published ? `/koolitused/${course.slug}` : null}
        created={sp.loodud === "1"}
        typeLocked={typeLocked(usage)}
      />
      <LessonsEditor courseId={course?.id ?? null} online={course?.type === "e_learning"} modules={course ? modules : []} />
      {course && lesson && (
        <Drawer
          key={lesson.id}
          label={fill(adminEt.lessons.drawer.label, { title: pick(lesson.title, "et") })}
          closeHref={`/admin/koolitused/${course.id}`}
          closeLabel={adminEt.common.close}
          returnFocus={`edit-lesson-${lesson.id}`}
          // deleted from the drawer: its row is gone, the focus goes to its module's "Uue õppetunni nimi"
          fallbackFocus={`add-lesson-${lesson.moduleId}`}
          confirmClose={{ question: adminEt.lessons.drawer.closeQuestion, yes: adminEt.lessons.drawer.closeYes, no: adminEt.lessons.drawer.closeNo }}
        >
          <LessonDrawer key={lesson.id} courseId={course.id} lesson={lesson} bunnyReady={bunnyConfig() !== null} />
        </Drawer>
      )}
    </>
  );
}
