import { existsSync, readFileSync } from "node:fs";
import { isSampleAddress } from "../../src/domain/email";
import { CAMPAIGN_ROOM_KEY } from "../../src/domain/newsletter-campaign";
import type { OutboxMail } from "../../src/server/mail-outbox";
import { newToken } from "../../src/server/token";
import { E2E_MAIL_OUTBOX } from "../local-secrets";
import { holdLocalLock, LOCK_WAIT_MS, onLocalDb, snapshotRows } from "./fixtures";

// What the newsletter's end-to-end test shares (the simple newsletter, Task 5; newsletter-campaigns.spec.ts): the campaign mails the server wrote to its
// outbox instead of sending them (src/server/mail-outbox.ts), the test subscribers, the lowered daily room, and the turn at the newsletter.

/** The Postgres advisory lock every test that presses „Saada kõigile“, makes a campaign go out, or signs a subscriber up holds. */
const NEWSLETTER_LOCK = "e2e-newsletter";

/**
 * Takes the newsletter for one test. A press mails every confirmed subscriber there is, and only one campaign goes out at a time, and the daily job takes
 * the oldest campaign that is going out: so a test that presses, one that sets a campaign going out in the database, and one that signs a subscriber up
 * (admin-site.spec.ts) must not overlap, though the two edit projects run side by side under `next dev`. The wait for the turn is added to the test's own
 * time. Returns the function that lets the turn go: call it after the test, also when it failed.
 */
export async function holdNewsletter(info: { setTimeout(ms: number): void; timeout: number }): Promise<() => Promise<void>> {
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  return holdLocalLock(NEWSLETTER_LOCK);
}

// ---------- the outbox ----------

/** Every mail the e2e servers wrote to the outbox, oldest first (none yet when the file is not there). */
export function readOutbox(): OutboxMail[] {
  if (!existsSync(E2E_MAIL_OUTBOX)) return [];
  return readFileSync(E2E_MAIL_OUTBOX, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as OutboxMail);
}

/** The outbox mails to these addresses, oldest first. */
export const outboxTo = (...addresses: string[]): OutboxMail[] => readOutbox().filter((m) => addresses.includes(m.to));

/** The mail of an outbox line as the person would see it: the address in the `List-Unsubscribe` header (the mail program's own button), without its brackets. */
export const unsubscribeAddress = (mail: OutboxMail): string => (mail.headers["List-Unsubscribe"] ?? "").replace(/^<|>$/g, "");

// ---------- the subscribers ----------

export type TestSubscriber = { email: string; locale: "et" | "ru"; token: string };

/** A confirmed subscriber of this test: her own token, as a real one's shape. */
export const testSubscriber = (email: string, locale: "et" | "ru"): TestSubscriber => ({ email, locale, token: newToken() });

/** Inserts these subscribers, confirmed, one after the other (so the press, which writes its list oldest first, finds them in this order). */
export async function insertConfirmedSubscribers(list: TestSubscriber[]): Promise<void> {
  await onLocalDb(
    async (sql) => {
      for (const s of list)
        await sql`
          insert into subscribers (email, locale, token, consent_at, confirmed_at)
          values (${s.email}, ${s.locale}, ${s.token}, now() - interval '2 days', now() - interval '1 day')`;
    },
    { marksPages: false },
  );
}

/** Deletes the subscribers of these exact addresses (nothing else); returns how many of those addresses are still there (0 when clean). */
export async function removeSubscribers(addresses: string[]): Promise<number> {
  if (addresses.length === 0) return 0;
  return onLocalDb(
    async (sql) => {
      await sql`delete from subscribers where email in ${sql(addresses)}`;
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from subscribers where email in ${sql(addresses)}`;
      return Number(n);
    },
    { marksPages: false },
  );
}

/** The addresses a press would mail now: every confirmed subscriber that is no sample address (server/newsletter-campaigns.ts recipientsNow), oldest first. */
export async function recipientAddresses(): Promise<string[]> {
  const rows = await onLocalDb((sql) => sql<{ email: string }[]>`select email from subscribers where confirmed_at is not null order by id`, { marksPages: false });
  return rows.map((r) => r.email).filter((email) => !isSampleAddress(email));
}

/**
 * Removes the confirmed subscribers other e2e tests left in the database (their addresses start with "e2e-" and are on example.com: e2e-form-… from the form
 * tests, which stay until the run's global teardown, e2e-admin-… from the admin inbox's). They are the run's own rows; a press mails every confirmed subscriber
 * there is, so the test needs the list to be its own. Called with the newsletter's turn held. Returns the addresses of the confirmed subscribers that are
 * still there and are not the e2e's (a local database with a subscriber of its own): the test says so rather than touching them.
 */
export async function clearTestRecipients(): Promise<string[]> {
  await onLocalDb((sql) => sql`delete from subscribers where confirmed_at is not null and email like 'e2e-%@example.com'`, { marksPages: false });
  return recipientAddresses();
}

// ---------- the daily room ----------

/**
 * Sets the lowered room of a campaign's mails a day (the settings row newsletter_daily_room, the check Dim does) to `n`, or removes it (`null`). The row
 * as it was is saved first and put back by the returned function (also by the next run's global setup, when this one was interrupted).
 */
export async function takeRoom(): Promise<{ set(n: number | null): Promise<void>; restore(): Promise<void> }> {
  const restore = await snapshotRows("settings", { column: "key", value: CAMPAIGN_ROOM_KEY }, { marksPages: false });
  return {
    async set(n) {
      await onLocalDb(
        (sql) =>
          n === null
            ? sql`delete from settings where key = ${CAMPAIGN_ROOM_KEY}`
            : sql`insert into settings (key, value) values (${CAMPAIGN_ROOM_KEY}, ${sql.json(n)}) on conflict (key) do update set value = excluded.value`,
        { marksPages: false },
      );
    },
    restore,
  };
}

// ---------- the campaigns ----------

/** Deletes the campaigns of these exact ids (their deliveries go with them); returns how many of them are still there (0 when clean). */
export async function removeCampaignsById(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  return onLocalDb(
    async (sql) => {
      await sql`delete from newsletter_campaigns where id in ${sql(ids)}`;
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from newsletter_campaigns where id in ${sql(ids)}`;
      return Number(n);
    },
    { marksPages: false },
  );
}
