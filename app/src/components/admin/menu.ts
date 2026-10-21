import type { AdminCounts } from "@/db/queries/admin";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatTime } from "@/i18n/format";
import type { MenuState, NavBadge } from "./menu-state";
import { sectionHref } from "./sections";

// The menu's badges (admin UX pass B6; README §1.1): one pure function from the numbers to what the sidebar shows, so that the shell (first paint) and
// /api/admin/margid (the sidebar's refetch after a client-side move) cannot disagree. A badge shows only above 0; it counts what Maria has to act
// on, never a total; a badged row opens its page already filtered. „Protokollid“ opens the one session straight away on a day with exactly one (B16).

const numeric = (n: number, text: string): NavBadge | undefined => (n > 0 ? { n, label: fill(text, { n }) } : undefined);

export function menuOf(counts: AdminCounts): MenuState {
  const t = adminEt.shell;
  const openRequests = Object.values(counts.openRequests).reduce((a, b) => a + b, 0);
  const all: MenuState["badges"] = {
    registrations: numeric(counts.awaitingPrepayment, t.badgeRegistrations),
    // „Täna“ on a day with a session (Tallinn's date): a word, so it adds nothing to the phone's sum
    protocols: counts.todaySessions.length > 0 ? { text: t.badgeTodayText, label: t.badgeToday } : undefined,
    assessment: numeric(counts.assessment, t.badgeAssessment),
    requests: numeric(openRequests, t.badgeRequests),
    feedback: numeric(counts.waitingReviews, t.badgeFeedback),
    payments: numeric(counts.paymentsAttention, t.badgePayments),
    testing: numeric(counts.ownFaults, t.badgeTesting),
  };
  const badges: MenuState["badges"] = {};
  let total = 0;
  for (const key of Object.keys(all) as (keyof typeof all)[]) {
    const badge = all[key];
    if (!badge) continue;
    badges[key] = badge;
    if ("n" in badge) total += badge.n;
  }
  const hrefs: MenuState["hrefs"] = {};
  if (badges.registrations) hrefs.registrations = `${sectionHref("registrations")}?staatus=ootab`;
  if (badges.feedback) hrefs.feedback = `${sectionHref("feedback")}?vaade=arvustused&olek=ootel`;
  const first = counts.todaySessions[0];
  // B16: with exactly one session on today (Tallinn's date) the row skips the index; with none, or two or more, it opens the index (its plain address)
  if (first && counts.todaySessions.length === 1) hrefs.protocols = `${sectionHref("protocols")}?sessioon=${first.id}`;
  return {
    badges,
    hrefs,
    total,
    today: first ? { href: `/admin/protokollid?sessioon=${first.id}`, time: formatTime(first.startsAt, "et"), course: first.course } : null,
  };
}
