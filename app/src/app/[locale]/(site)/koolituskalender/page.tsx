import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarList } from "@/components/site/CalendarList";
import type { CalendarRowData } from "@/components/site/CalendarRow";
import ui from "@/components/site/ui.module.css";
import { getDb } from "@/db/client";
import { listUpcomingSessions } from "@/db/queries/public";
import { calendarCities, citySlug, contactSessions, upcomingFrom } from "@/domain/calendar";
import { seatState, seatsLeft } from "@/domain/sessions";
import { pick } from "@/i18n/field";
import { formatDayMonth, formatWeekday } from "@/i18n/format";
import { href } from "@/i18n/href";
import { getDict, isLocale } from "@/i18n/locales";
import styles from "./calendar.module.css";

type Props = { params: Promise<{ locale: string }> };

/**
 * This page lists course dates, and a date is listed only until its session begins. So it is rendered again when it is
 * older than 5 minutes (the first visit after that still gets the cached copy and starts the new render), and a session
 * that has begun drops off without anyone saving. Saves revalidate it at once (server/public-cache.ts).
 */
export const revalidate = 300;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.calendar.title} — ${d.common.siteName}`, description: d.calendar.lead };
}

/**
 * Calendar (Task 9, L1–L5): prototype A's screen kept as a whole (Maria C20) with her C21 changes in each row — see
 * CalendarRow. Contact-course sessions from today on, soonest first; cancelled ones stay listed as "Tühistatud".
 * The city filter lives in the URL (?linn=…) and is applied by CalendarList.
 */
export default async function CalendarPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  const to = (path: string) => href(locale, path);
  const sessions = contactSessions(await listUpcomingSessions(getDb(), upcomingFrom(new Date())));

  const c = d.calendar;
  const word = { open: c.stateOpen, few: c.stateFew, full: c.stateFull, cancelled: c.stateCancelled };
  const rows: CalendarRowData[] = sessions.map((s) => {
    const state = seatState(s, s.taken);
    const left = seatsLeft(s.capacity, s.taken);
    const course = to(`/koolitused/${s.course.slug}`);
    return {
      id: s.id,
      cityKey: citySlug(s.city),
      city: s.city.trim(),
      venue: s.venue.trim(),
      day: formatDayMonth(s.startsAt, locale),
      weekday: formatWeekday(s.startsAt, locale),
      dateTime: s.startsAt.toISOString(),
      title: pick(s.course.title, locale),
      courseHref: course,
      registerHref: `${course}?sessioon=${s.id}`,
      format: d.formats.contact.name,
      language: s.language,
      state,
      stateLabel: state === "open" || state === "few" ? `${word[state]} · ${left}` : word[state],
    };
  });

  return (
    <div className={`${ui.wrap} ${styles.page}`}>
      <header className={styles.head}>
        <h1 className={`${ui.pageTitle} ${styles.title}`}>{c.title}</h1>
        <p className={styles.lead}>{c.lead}</p>
      </header>
      <CalendarList
        rows={rows}
        cities={calendarCities(sessions.map((s) => s.city))}
        locale={locale}
        t={{
          all: d.catalogue.filterAll,
          cityLabel: c.cityLabel,
          allCities: c.allCities,
          results: c.results,
          empty: c.empty,
          none: d.course.noSessions,
          register: c.register,
          waitlist: c.waitlist,
          others: c.others,
          languageLabel: d.course.languageLabel,
          waitlistForm: {
            title: d.forms.waitlistTitle,
            lead: d.forms.waitlistLead,
            name: d.forms.name,
            email: d.forms.email,
            newsletterConsent: d.forms.newsletterConsent,
            submit: d.forms.waitlistSubmit,
            sending: d.forms.sending,
            sent: d.forms.waitlistSent,
            errorRequired: d.forms.errorRequired,
            errorEmail: d.forms.errorEmail,
            errorTooMany: d.forms.errorTooMany,
            errorGeneric: d.forms.errorGeneric,
          },
        }}
      />
    </div>
  );
}
