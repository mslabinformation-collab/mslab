import type { Metadata } from "next";
import Link from "next/link";
import { AssessmentScreen } from "@/components/admin/AssessmentScreen";
import { ProtocolIndex } from "@/components/admin/ProtocolIndex";
import { ProtocolScreen, type ScreenView } from "@/components/admin/ProtocolScreen";
import styles from "@/components/admin/ProtocolScreen.module.css";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { protocolIndex, protocolScreen, screenStudents, type ScreenData } from "@/db/queries/protocols";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill, formatDate, formatTime, formatWeekday } from "@/i18n/format";
import { parseRowId } from "@/lib/row-id";
import { requireAdmin } from "@/server/auth";
import assessment from "../hindamine/assessment.module.css";

export const dynamic = "force-dynamic";
/**
 * „Saada kõigile“ is a server action of this page (sendProtocolsAction), so its mails run under this page's limit: they go out after the
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
 * Protokollid (phase protocols, spec §4): the course day's screen. With none of the three parameters below in the address it is the index (admin UX
 * pass B8; the menu's „Protokollid“ row goes straight to the one session when exactly one is on today, B16): today and the 14 days before it, newest
 * first, and the open individual registrations, each with its „Ava“. A parameter that is there but is not a number, or names nothing, is still the
 * "not found" below, not the index. ?sessioon=<id>: every listed registration of one session (from Kalender
 * and the overview's "Täna"); ?registreering=<id>: one registration (from Registreerimised: an individual course, or one group student). The
 * header names the course, the day and the place, with the way back to the index („← Protokollid“, README A3; its not-found card too); the screen
 * is ProtocolScreen (its autosave runs in the browser).
 * ?ligipaas=<id> (phase e-course completion, spec §5.3; README A4): one e-course access — Maria's assessment of the student's practical work (from
 * Hindamine, the student's drawer and Maria's notice): the way back is „← Hindamine“ above the screen, and the screen is AssessmentScreen,
 * which has the header itself (the student as the H1, a meta line with the course — handed over here — and the round, which follows the
 * screen's reads); an ended access says Maria can still assess (the line is handed over too). The first of the three in the address wins.
 * Behind requireAdmin like every admin page; nothing is written by opening it (a protocol is created by its first save, or by the student's
 * first photo).
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
  if (sp.sessioon === undefined && sp.registreering === undefined && sp.ligipaas === undefined) {
    const now = new Date();
    return (
      <div className={ui.page}>
        <div className={ui.heading}>
          <div className={styles.head}>
            <p className={ui.eyebrow}>{t.eyebrow}</p>
            <h1 className={ui.h1}>{t.title}</h1>
            <p className={ui.lead}>{t.index.note}</p>
          </div>
        </div>
        <ProtocolIndex data={await protocolIndex(db, now)} now={now} />
      </div>
    );
  }
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
          <Link className={ui.link} href={accessId !== null ? "/admin/hindamine" : "/admin/protokollid"}>
            {accessId !== null ? a.back : t.back}
          </Link>
        </section>
      </div>
    );
  }

  if (screen.kind === "access" && screen.assessment && accessId !== null) {
    const work = screen.assessment;
    const now = new Date();
    return (
      <div className={ui.page}>
        <p className={assessment.back}>
          <Link className={ui.link} href="/admin/hindamine">
            {a.back}
          </Link>
        </p>
        <AssessmentScreen
          view={viewOf(screen, { ligipaas: accessId })}
          course={pick(screen.course.title, "et")}
          expired={work.expiresAt <= now ? fill(a.expired, { date: formatDate(work.expiresAt, "et") }) : undefined}
        />
      </div>
    );
  }

  const s = screen.session;
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
        <Link className={ui.link} href="/admin/protokollid">
          {t.back}
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
