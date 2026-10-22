import type { I18n } from "@/i18n/field";
import { cardTitle, cardWhen, type AccountCard, type UntitledTexts } from "./account-cards";
import type { PaymentChoice, RegStatus } from "./registration";

// A registration as the student's own card names it (account-cards.ts), for the admin: the Õpilased drawer and the change
// requests in Päringud say "Kulmude lamineerimine — 14.11.2026 · 10:00" exactly as the student's card does. Pure: no
// database, no React.

/** What these need of a registration (db/queries/admin.ts RegistrationRow has it all). */
export type RegistrationLike = {
  id: number;
  status: RegStatus;
  paymentChoice: PaymentChoice;
  paidCents: number;
  preferredPeriod: string;
  createdAt: Date;
  course: { slug: string; title: I18n };
  courseSession: { startsAt: Date; city: string; venue: string; status: "scheduled" | "cancelled" } | null;
};

/** The registration as the account's card: a contact card with its session, or (no session) an individual one. */
export function registrationCard(r: RegistrationLike): AccountCard {
  const course = { slug: r.course.slug, title: r.course.title };
  const createdAt = r.createdAt.toISOString();
  if (!r.courseSession) return { kind: "individual", registrationId: r.id, course, status: r.status, preferredPeriod: r.preferredPeriod, createdAt };
  const s = r.courseSession;
  return {
    kind: "contact",
    registrationId: r.id,
    course,
    session: { startsAt: s.startsAt.toISOString(), city: s.city, venue: s.venue, cancelled: s.status === "cancelled" },
    status: r.status,
    paymentChoice: r.paymentChoice,
    priceCents: null,
    paidCents: r.paidCents,
    createdAt,
  };
}

/** The course and when ("14.11.2026 · 10:00" and "Pärnu, MS LAB stuudio", or the preferred period), in Estonian. */
export function registrationHeading(r: RegistrationLike, untitled: UntitledTexts): { title: string; time: string; place: string } {
  const card = registrationCard(r);
  const when = cardWhen(card, "et");
  return { title: cardTitle(card, "et", untitled), time: when?.time ?? "", place: when?.place ?? "" };
}
