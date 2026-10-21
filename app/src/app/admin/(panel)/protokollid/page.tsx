import type { Metadata } from "next";
import Link from "next/link";
import { AssessmentScreen } from "@/components/admin/AssessmentScreen";
import { ProtocolScreen, type ScreenView } from "@/components/admin/ProtocolScreen";
import styles from "@/components/admin/ProtocolScreen.module.css";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { protocolScreen, screenStudents, type ScreenData } from "@/db/queries/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatTime, formatWeekday } from "@/i18n/format";
import { parseRowId } from "@/lib/row-id";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";
/**
 * "Lukusta ja saada kõik" is a server action of this page (sendProtocolsAction), so its mails run under this page's limit: they go out after the
 * answer as ONE task, one after another about 0.8 s apart (server/protocols.ts mailProtocols), up to 100 of them (about 80 s). 300 s is the longest
 * a function may run on Vercel Hobby; a task cut short would lose the mails of the students not reached, and a mail cannot be sent again.
 * (tests/unit/protocol-page.test.ts pins it.)
 */
export const maxDuration = 300;
export const metadata: Metadata = { title: adminTitle(adminEt.protocols.title) };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** The screen's data for the browser: every date as text; `source` is where it asks for it again (GET /api/admin/protokoll); an access's screen says whose it is. */
function viewOf(screen: ScreenData, source: ScreenView["source"]): ScreenView {
  return { single: screen.kind !== "session", source, students: screenStudents(screen), ...(screen.kind === "access" ? { owner: "access" as const } : {}) };
}

/**
 * Protokollid (phase protocols, spec §4): the course day's screen. ?sessioon=<id>: every listed registration of one session (from Kalender
 * and the overview's "Täna"); ?registreering=<id>: one registration (from Registreerimised: an individual course, or one group student). The
 * header names the course, the day and the place, with the way back; the screen is ProtocolScreen (its autosave runs in the browser).
 * ?ligipaas=<id> (phase e-course completion, spec §5.3): one e-course access — Maria's assessment of the student's practical work (from
 * Hindamine, the student's drawer and Maria's notice): the header names the course and the student, the way back is Hindamine, an ended
 * access says Maria can still assess, and the screen is AssessmentScreen (its first line the round, which follows the screen's reads). The
 * first of the three in the address wins. Behind requireAdmin like every admin page; nothing is written by opening it (a protocol is created
 * by its first save, or by the student's first photo).
 */
export default async function ProtocolsPage({ searchParams }: Props) {
  await requireAdmin();
  const sp = await searchParams;
  const sessionId = parseRowId(one(sp.sessioon) ?? "");
  const registrationId = sessionId === null ? parseRowId(one(sp.registreering) ?? "") : null;
  const accessId = sessionId === null && registrationId === null ? parseRowId(one(sp.ligipaas) ?? "") : null;
  const t = adminEt.protocols;
  const a = adminEt.assessment.screen;
  const db = getDb();
  const screen =
    sessionId !== null
      ? await protocolScreen(db, { sessionId })
      : registrationId !== null
        ? await protocolScreen(db, { registrationId })
        : accessId !== null
          ? await protocolScreen(db, { accessId })
          : null;

  if (!screen) {
    return (
      <div className={ui.page}>
        <div className={ui.heading}>
          <div>
            <p className={ui.eyebrow}>{accessId !== null ? adminEt.nav.assessment : t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
          </div>
        </div>
        <section className={ui.card}>
          <p className={ui.empty}>{accessId !== null ? a.notFound : t.notFound}</p>
          <Link className={ui.link} href={accessId !== null ? "/admin/hindamine" : "/admin/kalender"}>
            {accessId !== null ? a.back : t.toCalendar}
          </Link>
        </section>
      </div>
    );
  }

  if (screen.kind === "access" && screen.assessment && accessId !== null) {
    const student = screen.students[0];
    const work = screen.assessment;
    const now = new Date();
    return (
      <div className={ui.page}>
        <div className={ui.heading}>
          <div className={styles.head}>
            <p className={ui.eyebrow}>{adminEt.nav.assessment}</p>
            <h1 className={ui.h1} data-protocol-course="">
              {`${pick(screen.course.title, "et")} · ${student.name}`}
            </h1>
          </div>
          <Link className={ui.link} href="/admin/hindamine">
            {a.back}
          </Link>
        </div>
        {work.expiresAt <= now && (
          <p className={ui.notice} data-access-expired="">
            {fill(a.expired, { date: formatDate(work.expiresAt, "et") })}
          </p>
        )}
        <AssessmentScreen view={viewOf(screen, { ligipaas: accessId })} />
      </div>
    );
  }

  const s = screen.session;
  const back = screen.kind === "session" && s ? { href: `/admin/kalender?id=${s.id}`, label: t.toCalendar } : { href: `/admin/registreerimised?id=${registrationId}`, label: t.toRegistration };
  const when = s ? `${formatWeekday(s.startsAt, "et")}, ${formatDate(s.startsAt, "et")} · ${formatTime(s.startsAt, "et")}` : t.individual;
  const place = s ? [s.city, s.venue].filter(Boolean).join(", ") : "";

  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <div className={styles.head}>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1} data-protocol-course="">
            {pick(screen.course.title, "et")}
          </h1>
          <p className={ui.lead} data-protocol-when="">
            {place ? `${when} · ${place}` : when}
          </p>
          {s?.cancelled && <span className={`${ui.tag} ${ui.bad}`}>{t.sessionCancelled}</span>}
        </div>
        <Link className={ui.link} href={back.href}>
          {back.label}
        </Link>
      </div>
      {screen.hidden > 0 && (
        <p className={`${ui.muted} ${ui.small}`} data-hidden-cancelled="">
          {fill(t.hidden, { n: screen.hidden })}
        </p>
      )}
      {screen.students.length === 0 ? (
        <section className={ui.card}>
          <p className={ui.empty}>{screen.kind === "registration" ? t.cancelledOne : t.empty}</p>
        </section>
      ) : (
        <ProtocolScreen view={viewOf(screen, sessionId !== null ? { sessioon: sessionId } : { registreering: registrationId! })} />
      )}
    </div>
  );
}
