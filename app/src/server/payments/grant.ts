import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { clients, courseAccess, courses, payments, type Payment } from "@/db/schema";
import { purchaseExpiryDate } from "@/domain/client-access";
import type { I18n } from "@/i18n/field";
import { addClient, grantAccess } from "../admin-clients";

/** What a paid e-course purchase opened: for whom (`created`: a new client), which access row, which course, until when. */
export type Grant = { clientId: number; created: boolean; accessId: number; courseSlug: string; courseTitle: I18n; expiresAt: Date };

/** The longest name a client keeps (the forms' and Minu andmed's limit). */
const NAME_MAX = 120;

/**
 * The e-course a paid purchase opens (phase 2b, spec 6.2.3), in the paid payment's own transaction (settle.ts): the client of the e-mail,
 * found or created as "Lisa õpilane" does it (admin-clients.ts addClient: under the logins' address lock, her earlier records linked) — a new
 * client gets the payer's name and the payment's language, an existing one keeps hers and gets the name only when she has none; then the
 * access as "Ava ligipääs" gives it (grantAccess, by "payment"): until the end of today + the course's access months (12 without), or of the
 * day her access ends when that is later (buying again never shortens access: domain/client-access.ts purchaseExpiryDate; an access an admin
 * ended counts as none, and a renewal clears the end). The payment row is linked to her. No session and no login are made here: the login is
 * the one the mail carries (settle.ts), a normal client login. null: the course is gone or is no e-course (settle.ts tells Maria).
 */
export async function grantPurchase(tx: Tx, payment: Payment, now: Date): Promise<Grant | null> {
  if (payment.courseId === null) return null;
  const db = tx as unknown as Db;
  const [course] = await db
    .select({ id: courses.id, slug: courses.slug, title: courses.title, type: courses.type, accessMonths: courses.accessMonths })
    .from(courses)
    .where(eq(courses.id, payment.courseId))
    .limit(1);
  if (!course || course.type !== "e_learning") return null;
  const client = await addClient(db, payment.email);
  if (!client.ok) return null;
  const name = payment.name.trim().slice(0, NAME_MAX);
  await db
    .update(clients)
    .set({
      name: client.created && name ? name : sql`case when ${clients.name} = '' then ${name} else ${clients.name} end`,
      ...(client.created ? { locale: payment.locale } : {}),
    })
    .where(eq(clients.id, client.id));
  const [held] = await db
    .select({ expiresAt: courseAccess.expiresAt, revokedAt: courseAccess.revokedAt })
    .from(courseAccess)
    .where(and(eq(courseAccess.clientId, client.id), eq(courseAccess.courseId, course.id)))
    .limit(1);
  const granted = await grantAccess(db, { clientId: client.id, courseId: course.id, until: purchaseExpiryDate(now, course.accessMonths, held ?? null), by: "payment", now });
  if (!granted.ok) return null;
  await db.update(payments).set({ clientId: client.id }).where(eq(payments.id, payment.id));
  const [access] = await db
    .select({ id: courseAccess.id, expiresAt: courseAccess.expiresAt })
    .from(courseAccess)
    .where(and(eq(courseAccess.clientId, client.id), eq(courseAccess.courseId, course.id)))
    .limit(1);
  return { clientId: client.id, created: client.created, accessId: access.id, courseSlug: course.slug, courseTitle: course.title, expiresAt: access.expiresAt };
}
