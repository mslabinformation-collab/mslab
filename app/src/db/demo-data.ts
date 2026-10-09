import { and, count, eq, gte, like, lt, sql } from "drizzle-orm";
import type { Db, Q } from "./client";
import { takesSeat } from "./queries/seats";
import { courseSessions, courses, registrations, requests, subscribers } from "./schema";
import { addDays } from "./seed-dates";
import { tallinnInstant } from "../domain/calendar";
import { registrationPrice, registrationStatusAfterPayment } from "../domain/registration";
import { seatState, type SeatState } from "../domain/sessions";
import { newToken } from "../server/token";

// SAMPLE data for the admin: registrations, waitlist entries, requests and newsletter subscribers, so the inboxes and
// the seat states are not empty while Maria tries the admin. Written straight into the database: no e-mail, no
// Telegram. CLI: src/db/demo.ts (npm run db:demo).
//
// Every person is made up: the names end in "(näidis)", the e-mail addresses are <name>.naidis@example.test and the
// phone numbers +372 5000 00xx. The e-mail address is the removal key (SAMPLE_EMAIL): removeDemo() deletes exactly the
// rows with such an address (registrations, requests incl. the waitlist, subscribers) and nothing else.
//
// Sessions are found by course slug and Estonian date, never by id. Seat states count the seats taken (confirmed
// registrations and live holds of unpaid ones, db/queries/seats.ts takesSeat; phase 2b). The samples never hold a seat
// unless they are confirmed, so what they add is their confirmed ones (samplesConfirmed). The plan makes one session full
// and leaves one with two places ("few seats"). Its unconfirmed and cancelled registrations go on a third session, whose
// state does not change. applyDemo() inserts only what is
// missing (by e-mail address), in one transaction, so running it twice adds nothing.

/** The removal key: an address ending in ".naidis@example.test" (a LIKE pattern; stored addresses are lowercase). */
export const SAMPLE_EMAIL = "%.naidis@example.test";
export const isSampleEmail = (email: string): boolean => email.endsWith(".naidis@example.test");

/** A session picked by its course's slug and its Estonian date ("2026-11-14"). */
export type SessionPick = { course: string; date: string };

export type DemoPlan = {
  /** made full: as many confirmed registrations as the capacity */
  full: SessionPick;
  /** shows "few seats": two places left */
  few: SessionPick;
  /** unconfirmed and cancelled registrations; its seat state stays as it is */
  other: SessionPick;
  /** the individual-course requests (contact courses with an individual price) */
  individual: [string, string];
  /** the e-learning course of the purchase-interest request */
  interest: string;
};

/** The plan for the first three sample sessions of a seed whose base date is `base` (seed-data.ts: +0, +7, +14 days). */
export function demoPlan(base: string): DemoPlan {
  return {
    full: { course: "kulmumeistri-baaskoolitus", date: base },
    few: { course: "lash-lift-botox", date: addDays(base, 7) },
    other: { course: "kulmude-lami", date: addDays(base, 14) },
    individual: ["kulmumeistri-baaskoolitus", "lash-lift-botox"],
    interest: "kulmumeistri-e-koolitus",
  };
}

/** The live database (seeded on 1.10.2026: its sessions are on 14.11, 21.11 and 28.11.2026). */
export const DEMO_PLAN = demoPlan("2026-11-14");

// ---------- the people (all made up) ----------

type Person = { name: string; email: string; phone: string; locale: "et" | "ru" };
let phoneNo = 0;
const person = (name: string, local: string, locale: "et" | "ru" = "et"): Person => ({
  name: `${name} (näidis)`,
  email: `${local}.naidis@example.test`,
  phone: `+372 5000 00${String(++phoneNo).padStart(2, "0")}`,
  locale,
});

type Slot = "full" | "few" | "other";
type RegistrationSample = Person & {
  slot: Slot;
  payment: "full" | "half";
  /** paid so far: nothing, half or all of the group price, or cents */
  paid: "none" | "half" | "full" | number;
  /** a cancelled registration: Maria's note */
  cancelled?: string;
  daysAgo: number;
  modelHelp?: boolean;
  account?: boolean;
};

/** 11 registrations: 4 awaiting prepayment, 3 confirmed with 50% paid, 3 confirmed with 100% paid, 1 cancelled. */
export const SAMPLE_REGISTRATIONS: RegistrationSample[] = [
  { ...person("Kati Kask", "kati.kask"), slot: "full", payment: "half", paid: "half", daysAgo: 19, modelHelp: true },
  { ...person("Mari Tamm", "mari.tamm"), slot: "full", payment: "full", paid: "full", daysAgo: 17 },
  { ...person("Анна Иванова", "anna.ivanova", "ru"), slot: "full", payment: "half", paid: "half", daysAgo: 12 },
  { ...person("Liis Saar", "liis.saar"), slot: "full", payment: "full", paid: "full", daysAgo: 9, account: true },
  { ...person("Kerli Mägi", "kerli.magi"), slot: "few", payment: "half", paid: "half", daysAgo: 15 },
  { ...person("Ольга Смирнова", "olga.smirnova", "ru"), slot: "few", payment: "full", paid: "full", daysAgo: 6 },
  { ...person("Triin Lepp", "triin.lepp"), slot: "few", payment: "half", paid: "none", daysAgo: 3 },
  { ...person("Grete Ots", "grete.ots"), slot: "few", payment: "full", paid: "none", daysAgo: 1, modelHelp: true },
  { ...person("Мария Кузнецова", "maria.kuznetsova", "ru"), slot: "other", payment: "half", paid: 5000, daysAgo: 5 },
  { ...person("Helen Kukk", "helen.kukk"), slot: "other", payment: "full", paid: "none", daysAgo: 2 },
  { ...person("Kristiina Pärn", "kristiina.parn"), slot: "other", payment: "half", paid: "none", daysAgo: 14, cancelled: "Loobus, tuleb kevadel uuesti (näidis)." },
];

type Payload = Record<string, string | number | boolean>;
type RequestSample = { kind: "contact" | "individual" | "practice" | "waitlist"; email: string; daysAgo: number; handled?: boolean; payload: (r: Resolved) => Payload };

const eva = person("Eva Rand", "eva.rand");
const natalia = person("Наталья Попова", "natalia.popova", "ru");
const piret = person("Piret Kalda", "piret.kalda");
const jekaterina = person("Екатерина Морозова", "ekaterina.morozova", "ru");
const signe = person("Signe Kuusk", "signe.kuusk");
const irina = person("Ирина Волкова", "irina.volkova", "ru");
const marika = person("Marika Sepp", "marika.sepp");
const julia = person("Юлия Соколова", "julia.sokolova", "ru");
const reet = person("Reet Lill", "reet.lill");

const waitlist = (p: Person, daysAgo: number): RequestSample => ({
  kind: "waitlist",
  email: p.email,
  daysAgo,
  payload: (r) => ({ session: r.full.id, course: r.full.course, name: p.name, email: p.email, locale: p.locale }),
});
const individual = (p: Person, course: 0 | 1, preferredPeriod: string, message: string, daysAgo: number): RequestSample => ({
  kind: "individual",
  email: p.email,
  daysAgo,
  payload: (r) => ({ course: r.individual[course].slug, courseId: r.individual[course].id, name: p.name, email: p.email, phone: p.phone, wantsModelHelp: false, wantsAccount: course === 0, locale: p.locale, preferredPeriod, message }),
});

/** 9 requests: 2 waitlist entries (for the full session), 2 individual, 2 practice (MINI, MAXI), 2 messages, 1 purchase interest. */
export const SAMPLE_REQUESTS: RequestSample[] = [
  waitlist(eva, 4),
  waitlist(natalia, 2),
  individual(piret, 0, "Jaanuari teine pool, nädalavahetusel", "Töötan nädala sees, seepärast sooviksin individuaalset koolitust. (näidis)", 11),
  individual(jekaterina, 1, "Декабрь, будни после 15:00", "Хотела бы пройти курс индивидуально, на русском языке. (näidis)", 7),
  { kind: "practice", email: signe.email, daysAgo: 13, handled: true, payload: () => ({ package: "MINI", name: signe.name, email: signe.email, phone: signe.phone, course: "Kulmumeistri baaskoolitus, 2025", times: "E–K pärastlõunad", locale: signe.locale }) },
  { kind: "practice", email: irina.email, daysAgo: 4, payload: () => ({ package: "MAXI", name: irina.name, email: irina.email, phone: irina.phone, course: "Ламинирование бровей", times: "Выходные, с утра", locale: irina.locale }) },
  { kind: "contact", email: marika.email, daysAgo: 16, handled: true, payload: () => ({ name: marika.name, email: marika.email, message: "Tere! Kas novembri koolitusel on veel vabu kohti? (näidis)", locale: marika.locale }) },
  { kind: "contact", email: julia.email, daysAgo: 1, payload: () => ({ name: julia.name, email: julia.email, message: "Здравствуйте! Есть ли курсы на русском языке в Таллинне? (näidis)", locale: julia.locale }) },
  // the e-learning "let me know" form (submit.ts handlePurchaseInterest): a contact request with intent "purchase"
  { kind: "contact", email: reet.email, daysAgo: 8, payload: (r) => ({ course: r.interest, intent: "purchase", email: reet.email, locale: reet.locale }) },
];

/** 15 newsletter subscribers over the last three weeks: 10 confirmed, 5 waiting for confirmation. */
export const SAMPLE_SUBSCRIBERS: { email: string; locale: "et" | "ru"; daysAgo: number; confirmed: boolean }[] = (
  [
    ["anu.tamm", "et", 20, true],
    ["ene.kask", "et", 19, true],
    ["svetlana.orlova", "ru", 18, true],
    ["maarja.mets", "et", 17, true],
    ["kadri.pold", "et", 15, false],
    ["tiina.kivi", "et", 13, true],
    ["elena.belova", "ru", 12, true],
    ["merle.org", "et", 10, true],
    ["kairi.raud", "et", 9, false],
    ["pille.laan", "et", 7, true],
    ["oksana.lebedeva", "ru", 6, false],
    ["riina.puu", "et", 5, true],
    ["hanna.vaher", "et", 3, true],
    ["darja.fjodorova", "ru", 2, false],
    ["airi.koppel", "et", 1, false],
  ] as const
).map(([local, locale, daysAgo, confirmed]) => ({ email: `${local}.naidis@example.test`, locale, daysAgo, confirmed }));

// ---------- plan ----------

type ResolvedSession = {
  id: number;
  course: string;
  courseId: number;
  capacity: number;
  startsAt: Date;
  status: "scheduled" | "cancelled";
  /** the group price the payments are measured against */
  price: number | null;
  /** seats taken now (confirmed and live holds), samples included */
  taken: number;
  /** seats taken now by registrations that are not samples */
  realTaken: number;
};
type Resolved = { full: ResolvedSession; few: ResolvedSession; other: ResolvedSession; individual: { slug: string; id: number }[]; interest: string };

export type SlotReport = { course: string; date: string; capacity: number; before: SeatState; after: SeatState };

export type DemoReport = {
  /** rows that would be (dry run) or were inserted; the waitlist entries are requests of their own kind */
  inserted: { registrations: number; waitlist: number; requests: number; subscribers: number };
  /** sample rows already there (not inserted again) */
  present: { registrations: number; requests: number; subscribers: number };
  sessions: Partial<Record<Slot, SlotReport>>;
  /** why the plan does not fit this database (then nothing is written) */
  problems: string[];
};

const DAY = 86_400_000;
/** `days` ago, at a time of day that varies with the row (`minutes`). */
const ago = (now: Date, days: number, minutes: number) => new Date(now.getTime() - days * DAY - (minutes % 900) * 60_000);

/** The amount paid for a sample registration against `price` (50% rounds up, so it is never below half). */
function paidCents(r: RegistrationSample, price: number): number {
  if (r.paid === "none") return 0;
  if (r.paid === "full") return price;
  if (r.paid === "half") return Math.ceil(price / 2);
  return r.paid;
}

function sampleStatus(r: RegistrationSample, price: number) {
  return r.cancelled ? ("cancelled" as const) : registrationStatusAfterPayment({ status: "awaiting_prepayment", paidCents: paidCents(r, price) }, price);
}

/** How many of a slot's sample registrations are confirmed (at `price`). */
const samplesConfirmed = (slot: Slot, price: number) => SAMPLE_REGISTRATIONS.filter((r) => r.slot === slot && sampleStatus(r, price) === "confirmed").length;

async function resolveSession(db: Q, pick: SessionPick, problems: string[], now: Date): Promise<ResolvedSession | null> {
  const from = tallinnInstant(pick.date, "00:00");
  const to = tallinnInstant(addDays(pick.date, 1), "00:00");
  if (!from || !to) {
    problems.push(`${pick.course} ${pick.date}: not a date`);
    return null;
  }
  const rows = await db
    .select({ session: courseSessions, course: courses })
    .from(courseSessions)
    .innerJoin(courses, eq(courseSessions.courseId, courses.id))
    .where(and(eq(courses.slug, pick.course), eq(courses.type, "contact"), gte(courseSessions.startsAt, from), lt(courseSessions.startsAt, to)));
  if (rows.length !== 1) {
    problems.push(`${pick.course} ${pick.date}: ${rows.length} sessions on that date (1 expected)`);
    return null;
  }
  const { session, course } = rows[0];
  const [{ all, samples }] = await db
    .select({ all: count(), samples: sql<number>`count(*) filter (where ${registrations.email} like ${SAMPLE_EMAIL})`.mapWith(Number) })
    .from(registrations)
    .where(and(eq(registrations.courseSessionId, session.id), takesSeat(now)));
  return {
    id: session.id,
    course: course.slug,
    courseId: course.id,
    capacity: session.capacity,
    startsAt: session.startsAt,
    status: session.status,
    price: registrationPrice(course, "group"),
    taken: all,
    realTaken: all - samples,
  };
}

async function present(db: Q) {
  const regs = await db.select({ email: registrations.email }).from(registrations).where(like(registrations.email, SAMPLE_EMAIL));
  const reqs = await db
    .select({ kind: requests.kind, email: sql<string>`${requests.payload}->>'email'` })
    .from(requests)
    .where(sql`${requests.payload}->>'email' like ${SAMPLE_EMAIL}`);
  const subs = await db.select({ email: subscribers.email }).from(subscribers).where(like(subscribers.email, SAMPLE_EMAIL));
  return {
    registrations: new Set(regs.map((r) => r.email)),
    requests: new Set(reqs.map((r) => `${r.kind} ${r.email}`)),
    subscribers: new Set(subs.map((r) => r.email)),
  };
}

/** Everything applyDemo needs, read in one go: the sessions, what is already there and the report. */
async function inspect(db: Q, plan: DemoPlan, now: Date) {
  const problems: string[] = [];
  const full = await resolveSession(db, plan.full, problems, now);
  const few = await resolveSession(db, plan.few, problems, now);
  const other = await resolveSession(db, plan.other, problems, now);
  const sessions: DemoReport["sessions"] = {};
  for (const [slot, s] of [["full", full], ["few", few], ["other", other]] as const) {
    if (!s) continue;
    if (s.status !== "scheduled" || s.startsAt <= now) problems.push(`${slot}: the ${s.course} session is cancelled or has begun`);
    if (s.price == null) {
      problems.push(`${slot}: ${s.course} has no group price`);
      continue;
    }
    const after = s.realTaken + samplesConfirmed(slot, s.price); // the samples take a seat only when confirmed
    const state = { status: s.status, capacity: s.capacity };
    sessions[slot] = { course: s.course, date: plan[slot].date, capacity: s.capacity, before: seatState(state, s.taken), after: seatState(state, after) };
    if (slot === "full" && after !== s.capacity) problems.push(`full: ${s.course} would have ${after} seats taken of ${s.capacity} places`);
    if (slot === "few" && (s.capacity - after < 1 || s.capacity - after > 2)) problems.push(`few: ${s.course} would have ${s.capacity - after} places left (1 or 2 expected)`);
    if (slot === "other" && after > s.capacity) problems.push(`other: ${s.course} would be over capacity`);
  }
  const individual: { slug: string; id: number }[] = [];
  for (const slug of plan.individual) {
    const [c] = await db.select().from(courses).where(and(eq(courses.slug, slug), eq(courses.type, "contact"))).limit(1);
    if (!c || c.priceIndividual == null) problems.push(`individual: ${slug} is not a contact course with an individual price`);
    else individual.push({ slug, id: c.id });
  }
  const [e] = await db.select({ id: courses.id }).from(courses).where(and(eq(courses.slug, plan.interest), eq(courses.type, "e_learning"))).limit(1);
  if (!e) problems.push(`interest: ${plan.interest} is not an e-learning course`);

  const have = await present(db);
  const missing = {
    registrations: SAMPLE_REGISTRATIONS.filter((r) => !have.registrations.has(r.email)),
    requests: SAMPLE_REQUESTS.filter((r) => !have.requests.has(`${r.kind} ${r.email}`)),
    subscribers: SAMPLE_SUBSCRIBERS.filter((s) => !have.subscribers.has(s.email)),
  };
  const report: DemoReport = {
    inserted: {
      registrations: missing.registrations.length,
      waitlist: missing.requests.filter((r) => r.kind === "waitlist").length,
      requests: missing.requests.filter((r) => r.kind !== "waitlist").length,
      subscribers: missing.subscribers.length,
    },
    present: { registrations: have.registrations.size, requests: have.requests.size, subscribers: have.subscribers.size },
    sessions,
    problems,
  };
  const resolved: Resolved | null = !problems.length && full && few && other ? { full, few, other, individual, interest: plan.interest } : null;
  return { report, resolved, missing };
}

/** What applyDemo would insert, and the seat states before and after. Reads only. */
export async function planDemo(db: Q, plan: DemoPlan = DEMO_PLAN, now = new Date()): Promise<DemoReport> {
  return (await inspect(db, plan, now)).report;
}

/** Inserts the sample rows that are missing, in one transaction. Throws, writing nothing, when the plan does not fit. */
export async function applyDemo(db: Db, plan: DemoPlan = DEMO_PLAN, now = new Date()): Promise<DemoReport> {
  return db.transaction(async (tx) => {
    const { report, resolved: r, missing } = await inspect(tx, plan, now);
    if (!r) throw new Error(`the sample plan does not fit this database:\n  ${report.problems.join("\n  ")}`);

    if (missing.registrations.length)
      await tx.insert(registrations).values(
        missing.registrations.map((s, i) => {
          const session = r[s.slot];
          const price = session.price!;
          return {
            courseId: session.courseId,
            courseSessionId: session.id,
            kind: "group" as const,
            name: s.name,
            email: s.email,
            phone: s.phone,
            paymentChoice: s.payment,
            wantsModelHelp: !!s.modelHelp,
            wantsAccount: !!s.account,
            locale: s.locale,
            status: sampleStatus(s, price),
            paidCents: paidCents(s, price),
            note: s.cancelled ?? "",
            createdAt: ago(now, s.daysAgo, 600 + i * 47),
          };
        }),
      );

    if (missing.requests.length)
      await tx.insert(requests).values(missing.requests.map((s, i) => ({ kind: s.kind, payload: s.payload(r), handled: !!s.handled, createdAt: ago(now, s.daysAgo, 420 + i * 53) })));

    if (missing.subscribers.length)
      await tx
        .insert(subscribers)
        .values(
          missing.subscribers.map((s, i) => {
            const consentAt = ago(now, s.daysAgo, 300 + i * 41);
            return { email: s.email, locale: s.locale, token: newToken(), consentAt, confirmedAt: s.confirmed ? new Date(consentAt.getTime() + (3 + i) * 60_000) : null };
          }),
        )
        .onConflictDoNothing({ target: subscribers.email });

    return report;
  });
}

/** Deletes every sample row (the e-mail address is the key), in one transaction. The counts per table. */
export async function removeDemo(db: Db): Promise<DemoReport["inserted"]> {
  return db.transaction(async (tx) => {
    const regs = await tx.delete(registrations).where(like(registrations.email, SAMPLE_EMAIL)).returning();
    const reqs = await tx.delete(requests).where(sql`${requests.payload}->>'email' like ${SAMPLE_EMAIL}`).returning();
    const subs = await tx.delete(subscribers).where(like(subscribers.email, SAMPLE_EMAIL)).returning();
    return { registrations: regs.length, waitlist: reqs.filter((x) => x.kind === "waitlist").length, requests: reqs.filter((x) => x.kind !== "waitlist").length, subscribers: subs.length };
  });
}
