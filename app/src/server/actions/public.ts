"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db/client";
import { serverEnv } from "../env";
import { serverKv } from "../kv";
import { logFailure } from "../log";
import { paymentProvider } from "../payments/montonio";
import { revalidatePublic } from "../public-cache";
import { clientIp } from "../ratelimit";
import { subscriberSync } from "../resend-marketing";
import { linkBase, requestOrigin } from "../site";
import {
  handleContact,
  handleEcoursePurchase,
  handleIndividual,
  handlePractice,
  handlePurchaseInterest,
  handleRegistration,
  handleSubscribe,
  handleWaitlist,
  runSubmission,
  type ActionResult,
  type Deps,
  type FormName,
} from "../submit";

// Public form actions. Every export of a "use server" file is callable from the browser, so only the actions live
// here; validation, rate limiting, storage and notifications are in ../submit.ts (tested without Next.js).
// Result: { ok: true, paymentUrl? } | { ok: false; errors: Record<field, code> } — codes in ../forms.ts; form "rate" when rate
// limited, form "server" when storage failed.

async function run(form: FormName, handler: (deps: Deps, formData: FormData) => Promise<ActionResult>, formData: FormData): Promise<ActionResult> {
  return runSubmission(
    form,
    async (): Promise<Deps> => {
      const env = { ...serverEnv(), KV: serverKv() };
      const h = await headers();
      const db = getDb();
      return {
        db,
        env,
        // Without x-forwarded-for (never on Vercel) `next dev` uses one local bucket.
        ip: clientIp(h) ?? (process.env.NODE_ENV === "development" ? "local" : null),
        siteUrl: linkBase(requestOrigin(h), env.SITE_URL),
        now: new Date(),
        // Notifications run after the response (next/server after()) and never fail or slow the form.
        later: (task) => after(() => task().catch((e) => logFailure(`[forms] ${form}: notification failed`, e))),
        // a registration or waitlist entry: the calendar and the course page show the session's seats. They are
        // revalidated before the answer, so the very next request shows the new count (server/public-cache.ts).
        changed: revalidatePublic,
        // online payments (phase 2b): null without the keys, and the forms are today's
        montonio: paymentProvider(),
        // a newsletter sign-up's sync to Resend (newsletter campaigns), in the work after the response; none without the newsletter's key
        newsletterSync: subscriberSync(db, env),
      };
    },
    handler,
    formData,
  );
}

/** Home and contact page message to Maria. Fields: name, email, message, locale, website (honeypot). */
export async function submitContact(formData: FormData): Promise<ActionResult> {
  return run("contact", handleContact, formData);
}

/** Newsletter sign-up, one step: the address is subscribed at once and the welcome mail follows; sending it is the consent. Fields: email, locale, website (honeypot). */
export async function subscribe(formData: FormData): Promise<ActionResult> {
  return run("subscribe", handleSubscribe, formData);
}

/**
 * Contact course, group: registration for one session, stored as `awaiting_prepayment` (P15). Fields: course (slug),
 * session (id), name, email, phone, payment (full|half), modelHelp, account, terms ("on"), locale, website.
 * Extra errors: session "full" / "unavailable" when the date can no longer be booked. With online payments the answer is
 * `{ ok: true, paymentUrl }`: the prepayment has started (phase 2b).
 */
export async function registerContact(formData: FormData): Promise<ActionResult> {
  return run("register", handleRegistration, formData);
}

/** Contact course, individual: a request (kind `individual`) with the preferred period; no payment choice (P12). */
export async function submitIndividual(formData: FormData): Promise<ActionResult> {
  return run("individual", handleIndividual, formData);
}

/** E-learning cart before payment opens (P9): request of kind `contact` { course, intent: "purchase", email }. */
export async function submitPurchaseInterest(formData: FormData): Promise<ActionResult> {
  return run("interest", handlePurchaseInterest, formData);
}

/**
 * The e-course cart's purchase (phase 2b): `{ ok: true, paymentUrl }` (the cart sends the browser there), or form "unavailable" (no payments,
 * Montonio down: the cart shows its interest form), or form "alreadyPaid" (this address paid the course in the last 30 minutes: the cart says so
 * and starts nothing). The price is the course's own, never a field. Fields: course (slug), name, email, terms,
 * newsletter, locale, website (honeypot).
 */
export async function buyEcourse(formData: FormData): Promise<ActionResult> {
  return run("ecourse", handleEcoursePurchase, formData);
}

/** Practice request (/praktika#taotlus): request of kind `practice`. Fields: package, name, email, phone, course, times. */
export async function submitPractice(formData: FormData): Promise<ActionResult> {
  return run("practice", handlePractice, formData);
}

/** Waitlist for a full calendar session: request of kind `waitlist`. Fields: session, name, email, locale. */
export async function submitWaitlist(formData: FormData): Promise<ActionResult> {
  return run("waitlist", handleWaitlist, formData);
}
