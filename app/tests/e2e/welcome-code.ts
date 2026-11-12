import type postgres from "postgres";
import { holdLocalLock, LOCK_WAIT_MS, onLocalDb } from "./fixtures";

// The welcome code in the e2e run (F1 Task 16). Since migration 0025 the welcome code is a row of `discount_codes` (`welcome = true`) and not a key of
// `settings.newsletter`. Only ONE such row may exist (the unique index discount_codes_one_welcome), and it is shared: the footer, the popup, the welcome
// mail and the confirmed page of the local site all read it. So a spec that needs a welcome code in a known state (admin-site.spec.ts, campaign
// popups, gate.spec.ts) takes its turn here (a Postgres advisory lock, as the other shared rows do: the desktop and phone projects and the other specs run
// side by side) and puts the row back exactly:
// - no welcome row there: one is inserted, and the clean-up deletes exactly that row by its id (its uses first, the redemptions have no cascade);
// - a welcome row there already: its columns are saved whole (`to_jsonb`), the row is set to what the spec wants, and the clean-up writes every column
//   back from the saved copy (`jsonb_populate_record`), so nothing of it changes. Its chosen courses are not touched (the scope is `all` meanwhile). The
//   ids of its uses are read too, and the clean-up deletes exactly the uses that were not there before (the spec's bookings with the code, P32): the row's
//   own uses stay as they were.
// Never a `like` in a clean-up: ids only.

/** The turn the welcome row's tests take. */
export const WELCOME_LOCK = "e2e-welcome-code";

/** What a spec wants of the welcome row: its text and one value (a percent, or euro cents), and the days after sign-up it works (none: no limit). */
export type WelcomeWanted = { code: string; percent?: number; amountCents?: number; daysAfterSignup?: number | null };

/**
 * Takes the turn, makes the welcome row `wanted` (active, for everyone who is a first-timer, no dates, no limit, scope `all`) and returns what puts the
 * row back and gives the turn up (call it in `finally`). The timeout is lengthened by the wait for the turn, which is not the test's own time. The pages
 * that show the welcome code are marked stale (a production build's cache, fixtures.ts onLocalDb), and again when it is put back.
 */
export async function takeWelcomeCode(info: { setTimeout(ms: number): void; timeout: number }, wanted: WelcomeWanted): Promise<() => Promise<void>> {
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  const unlock = await holdLocalLock(WELCOME_LOCK);
  try {
    const percent = wanted.amountCents === undefined ? (wanted.percent ?? 10) : null;
    const amountCents = wanted.amountCents ?? null;
    const days = wanted.daysAfterSignup ?? null;
    const made = await onLocalDb(async (sql) => {
      const [existing] = await sql<{ id: number; saved: postgres.JSONValue }[]>`select id, to_jsonb(d) as saved from discount_codes d where welcome`;
      if (existing) {
        const uses = await sql<{ id: number }[]>`select id from discount_redemptions where code_id = ${existing.id}`;
        await sql`
          update discount_codes set code = ${wanted.code}, percent = ${percent}, amount_cents = ${amountCents}, scope = 'all', starts_on = null, ends_on = null,
            max_uses = null, days_after_signup = ${days}, active = true, updated_at = now()
          where id = ${existing.id}`;
        return { id: existing.id, saved: existing.saved, usesBefore: new Set(uses.map((u) => u.id)) };
      }
      const [row] = await sql<{ id: number }[]>`
        insert into discount_codes (code, welcome, percent, amount_cents, scope, audience, once_per_person, days_after_signup, active)
        values (${wanted.code}, true, ${percent}, ${amountCents}, 'all', 'first', true, ${days}, true) returning id`;
      return { id: row.id, saved: null, usesBefore: new Set<number>() };
    });
    return async () => {
      try {
        await onLocalDb(async (sql) => {
          if (made.saved === null) {
            await sql`delete from discount_redemptions where code_id = ${made.id}`;
            await sql`delete from discount_codes where id = ${made.id}`;
          } else {
            // the uses this turn made (its bookings with the welcome code), by their ids: those the row did not have when the turn began
            const now = await sql<{ id: number }[]>`select id from discount_redemptions where code_id = ${made.id}`;
            const ours = now.map((u) => u.id).filter((id) => !made.usesBefore.has(id));
            if (ours.length > 0) await sql`delete from discount_redemptions where id in ${sql(ours)}`;
            await sql`
              update discount_codes d set code = r.code, welcome = r.welcome, percent = r.percent, amount_cents = r.amount_cents, scope = r.scope, starts_on = r.starts_on,
                ends_on = r.ends_on, max_uses = r.max_uses, audience = r.audience, once_per_person = r.once_per_person, days_after_signup = r.days_after_signup,
                note = r.note, active = r.active, created_at = r.created_at, updated_at = r.updated_at
              from jsonb_populate_record(null::discount_codes, ${sql.json(made.saved as postgres.JSONValue)}) r
              where d.id = r.id`;
          }
        });
      } finally {
        await unlock();
      }
    };
  } catch (e) {
    await unlock();
    throw e;
  }
}
