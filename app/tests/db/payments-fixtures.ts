import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { attachOrder, insertPayment } from "@/db/queries/payments";
import { courses, courseSessions, registrations, type Course, type CourseSession, type Payment, type Registration } from "@/db/schema";
import type { PublicChange } from "@/server/cache-targets";
import type { Env } from "@/server/notify";
import { signHs256, verifyHs256 } from "@/server/payments/jwt";
import { montonioClient, SANDBOX_BASE, type MontonioConfig } from "@/server/payments/montonio";
import type { SettleDeps } from "@/server/payments/settle";
import { fakeKv, stubFetch } from "../fakes";

// The payment DB tests' common parts (phase 2b): a store with made-up keys, Montonio + Resend + Telegram behind one stubbed fetch, order
// tokens as Montonio signs them, the settlement's dependencies, and a contact course with a registration and a pending payment.

export const TEST_MONTONIO: MontonioConfig = { accessKey: "test-access-key", secretKey: "test-secret-key-0123456789abcdef", baseUrl: SANDBOX_BASE, live: false, mock: false };
export const SITE = "https://mslab.example";

/** An order token as Montonio signs it (its orders guide's decoded payload) for `payment`: PAID, its amount, Swedbank; `over` replaces fields. */
export function orderToken(payment: Pick<Payment, "reference" | "amountCents" | "providerUuid">, over: Record<string, unknown> = {}, opts: { secret?: string; nowSec?: number } = {}): string {
  return signHs256(
    {
      uuid: payment.providerUuid ?? "uuid-unknown",
      accessKey: TEST_MONTONIO.accessKey,
      merchantReference: payment.reference,
      merchantReferenceDisplay: payment.reference,
      paymentStatus: "PAID",
      paymentMethod: "paymentInitiation",
      grandTotal: payment.amountCents / 100,
      currency: "EUR",
      senderIban: null,
      senderName: null,
      paymentProviderName: "Swedbank",
      ...over,
    },
    opts.secret ?? TEST_MONTONIO.secretKey,
    { expiresInSeconds: 600, nowSec: opts.nowSec },
  );
}

/**
 * A refund notice's token as Montonio signs it (the refunds guide's decoded payload: refundUuid, refundStatus, refundStatusDescription,
 * accessKey, refundAmount, orderUuid; valid for 7 days) for the order `orderUuid`: SUCCESSFUL, 175 €; `over` replaces fields.
 */
export function refundToken(orderUuid: string, over: Record<string, unknown> = {}, opts: { secret?: string; nowSec?: number } = {}): string {
  return signHs256(
    { refundUuid: "refund-0001", refundStatus: "SUCCESSFUL", refundStatusDescription: null, accessKey: TEST_MONTONIO.accessKey, refundAmount: 175, orderUuid, ...over },
    opts.secret ?? TEST_MONTONIO.secretKey,
    { expiresInSeconds: 7 * 86_400, nowSec: opts.nowSec },
  );
}

/**
 * Montonio, Resend and Telegram behind one stubbed fetch. POST /orders checks the order token and answers a new uuid and a paymentUrl (a 503
 * while `state.down`), and keeps the token's claims in `state.orders`; GET /orders/<uuid> answers `state.snapshots.get(uuid)` (none: a 503, "no
 * answer") and keeps the uuid in `state.gets`. `mails()`: the Resend calls' bodies; `pings()`: the Telegram texts.
 */
export function stubMontonio() {
  const state = { down: false, snapshots: new Map<string, Record<string, unknown>>(), orders: [] as Record<string, unknown>[], gets: [] as string[] };
  let n = 0;
  const f = stubFetch((url, init) => {
    if (url.includes("resend")) return Response.json({ id: "email_1" });
    if (url.includes("telegram")) return Response.json({ ok: true });
    if (url === `${SANDBOX_BASE}/orders` && init?.method === "POST") {
      if (state.down) return Response.json({ message: "Service unavailable" }, { status: 503 });
      const { claims } = verifyHs256<Record<string, unknown>>((JSON.parse(String(init.body)) as { data: string }).data, TEST_MONTONIO.secretKey);
      state.orders.push(claims);
      const uuid = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      return Response.json({ uuid, paymentStatus: "PENDING", merchantReference: claims.merchantReference, paymentUrl: `https://sandbox-stargate.montonio.com/${uuid}` });
    }
    const get = /\/orders\/([^/]+)$/.exec(url);
    if (get) {
      state.gets.push(get[1]);
      const snapshot = state.snapshots.get(get[1]);
      return snapshot ? Response.json(snapshot) : new Response("Service unavailable", { status: 503 });
    }
    return Response.json({});
  });
  return {
    state,
    montonio: montonioClient(TEST_MONTONIO),
    mails: () => f.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as { to: string; subject: string; text: string; html?: string }),
    pings: () => f.calls.filter((c) => c.url.includes("telegram")).map((c) => (c.body as { text: string }).text),
  };
}

/**
 * The settlement's dependencies on `db` at `now`, Resend and Telegram set up. `flush()` runs the work after the response, one task after the
 * other in the order it was queued (so the mails' order is fixed); `changes`: the revalidations; `kv`: the store behind `deps.env.KV`.
 */
export function settleDeps(db: Db, montonio: SettleDeps["montonio"], now: Date) {
  const tasks: (() => Promise<unknown>)[] = [];
  const changes: PublicChange[] = [];
  const kv = fakeKv({ "tg:chat": "42" });
  const env: Env = { KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test", TELEGRAM_BOT_TOKEN: "123:abc" };
  const deps: SettleDeps = { db, env, now, siteUrl: SITE, later: (task) => void tasks.push(task), changed: (change) => void changes.push(change), montonio };
  const flush = async () => {
    for (let task = tasks.shift(); task; task = tasks.shift()) await task();
  };
  return { deps, changes, flush, kv };
}

/** A published contact course, Kulmumeistri baaskoolitus (350 €), with one session of `capacity` (4) on 14.11.2026 at 10:00 in Pärnu. */
export async function contactCourse(db: Db, opts: { capacity?: number; startsAt?: Date } = {}): Promise<{ course: Course; session: CourseSession }> {
  const [course] = await db
    .insert(courses)
    .values({ slug: "kulmumeistri-baaskoolitus", type: "contact", level: "basic", title: { et: "Kulmumeistri baaskoolitus", ru: "Базовый курс бровиста" }, summary: { et: "" }, body: { et: "" }, published: true, priceGroup: 35000 })
    .returning();
  const [session] = await db
    .insert(courseSessions)
    .values({ courseId: course.id, startsAt: opts.startsAt ?? new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio", capacity: opts.capacity ?? 4 })
    .returning();
  return { course, session };
}

/** A group registration on `c`'s session: Kati Tamm, half, awaiting and unpaid unless `over` says otherwise. */
export async function registrationOn(db: Db, c: { course: Course; session: CourseSession }, over: Partial<typeof registrations.$inferInsert> = {}): Promise<Registration> {
  const [row] = await db
    .insert(registrations)
    .values({ courseId: c.course.id, courseSessionId: c.session.id, kind: "group", name: "Kati Tamm", email: "kati@example.com", phone: "+372 5555 0101", paymentChoice: "half", status: "awaiting_prepayment", paidCents: 0, ...over })
    .returning();
  return row;
}

/** A pending payment of `r` (its prepayment of 175 € by default) whose order exists at Montonio with `providerUuid` (a fixed uuid by default). */
export async function pendingPayment(
  db: Db,
  r: Registration,
  over: { kind?: "prepayment" | "balance"; amountCents?: number; providerUuid?: string | null } = {},
  now: Date = new Date("2026-10-09T09:55:00Z"),
): Promise<Payment> {
  const row = await insertPayment(db, { kind: over.kind ?? "prepayment", registrationId: r.id, courseId: r.courseId, clientId: r.clientId, email: r.email, name: r.name, locale: r.locale === "ru" ? "ru" : "et", amountCents: over.amountCents ?? 17500 }, now);
  const uuid = over.providerUuid === undefined ? `uuid-${row.id}` : over.providerUuid;
  if (uuid === null) return row;
  await attachOrder(db, row.id, uuid, now);
  return { ...row, providerUuid: uuid };
}

/** A fresh database whose every statement is kept in `queries` (drizzle's logger), to read the order of the locks and writes from. */
export async function loggedDb(): Promise<{ db: Db; queries: string[] }> {
  const queries: string[] = [];
  const logged = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string) => void queries.push(query) } }) as unknown as Db;
  await migrate(logged as Parameters<typeof migrate>[0], { migrationsFolder: "./drizzle" });
  return { db: logged, queries };
}
