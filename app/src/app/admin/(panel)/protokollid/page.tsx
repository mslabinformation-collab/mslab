import type { Metadata } from "next";
import Link from "next/link";
import { ProtocolScreen, type ScreenView } from "@/components/admin/ProtocolScreen";
import styles from "@/components/admin/ProtocolScreen.module.css";
import { adminTitle, type Section } from "@/components/admin/sections";
import { Shell } from "@/components/admin/Shell";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { protocolScreen, type ScreenData } from "@/db/queries/protocols";
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

/** The screen's data for the browser: every date as text. */
function viewOf(screen: ScreenData): ScreenView {
  return {
    single: screen.kind === "registration",
    students: screen.students.map((s) => ({
      registrationId: s.registrationId,
      name: s.name,
      awaiting: s.status === "awaiting_prepayment",
      version: s.protocol.version,
      titles: s.protocol.stages.map((x) => x.title),
      notes: s.protocol.stages.map((x) => x.note),
      generalNote: s.protocol.generalNote,
      sentVersion: s.protocol.sentVersion,
      sentAt: s.protocol.sentAt?.toISOString() ?? null,
      savedAt: s.protocol.updatedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Protokollid (phase protocols, spec §4): the course day's screen. ?sessioon=<id>: every listed registration of one session (from Kalender
 * and the overview's "Täna"); ?registreering=<id>: one registration (from Registreerimised: an individual course, or one group student). The
 * header names the course, the day and the place, with the way back; the screen is ProtocolScreen (its autosave runs in the browser). Behind
 * requireAdmin like every admin page; nothing is written by opening it (a protocol is created by its first save).
 */
export default async function ProtocolsPage({ searchParams }: Props) {
  const email = await requireAdmin();
  const sp = await searchParams;
  const sessionId = parseRowId(one(sp.sessioon) ?? "");
  const registrationId = sessionId === null ? parseRowId(one(sp.registreering) ?? "") : null;
  const t = adminEt.protocols;
  const db = getDb();
  const screen = sessionId !== null ? await protocolScreen(db, { sessionId }) : registrationId !== null ? await protocolScreen(db, { registrationId }) : null;
  const active: Section = registrationId !== null ? "registrations" : "calendar";

  if (!screen) {
    return (
      <Shell email={email} active={active}>
        <div className={ui.page}>
          <div className={ui.heading}>
            <div>
              <p className={ui.eyebrow}>{t.eyebrow}</p>
              <h1 className={ui.h1}>{t.title}</h1>
            </div>
          </div>
          <section className={ui.card}>
            <p className={ui.empty}>{t.notFound}</p>
            <Link className={ui.link} href="/admin/kalender">
              {t.toCalendar}
            </Link>
          </section>
        </div>
      </Shell>
    );
  }

  const s = screen.session;
  const back = screen.kind === "session" && s ? { href: `/admin/kalender?id=${s.id}`, label: t.toCalendar } : { href: `/admin/registreerimised?id=${registrationId}`, label: t.toRegistration };
  const when = s ? `${formatWeekday(s.startsAt, "et")}, ${formatDate(s.startsAt, "et")} · ${formatTime(s.startsAt, "et")}` : t.individual;
  const place = s ? [s.city, s.venue].filter(Boolean).join(", ") : "";

  return (
    <Shell email={email} active={active}>
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
          <ProtocolScreen view={viewOf(screen)} />
        )}
      </div>
    </Shell>
  );
}
