"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { normalizeEmail } from "@/domain/email";
import { ROW_ID_MAX } from "@/lib/row-id";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import { copyCampaign, prepareSend, saveCampaign, sendCampaign, sendTest, type SendResult, type SendScope } from "../newsletter-campaigns";
import { FullSyncBusy, fullSync, keyRefused, MarketingUnavailable, marketingConfigured, type FullSyncReport } from "../resend-marketing";
import { ADMIN_SYNC_BUDGET_MS, adminMarketingDeps } from "../send-deps";

// Maria's newsletter actions (newsletter campaigns, Task 3, spec D2, §5): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is
// resend-marketing.ts fullSync; here it is run with an interactive time budget (it is a press, not the daily cron), its refusals get a code that
// the page turns into Estonian words (adminEt.newsletter.sync.errors), and a sync that ran refreshes the open page, so that its counts are the new ones.
// The action's own time is the page's (uudiskiri/page.tsx maxDuration).
//
// The campaigns' actions (Task 4, the „Kampaaniad“ tab): the work is newsletter-campaigns.ts; here the input is checked once more (an id the page
// never sends is `notFound` without a read, and „Saada proov“'s address is MARIA_EMAIL or the signed-in admin's own, never one the browser names),
// each refusal is a code the editor puts into words (adminEt.newsletter.campaigns.errorsOf), a throw is `server` (logged by the error's class and
// the campaign's id, never a message), and a change refreshes the open page. The sends run on SITE_URL (adminMarketingDeps) with the sync's
// interactive budget.

/**
 * „Sünkrooni Resendiga“: the full sync of the subscribers with Resend's contacts (resend-marketing.ts fullSync: Resend-side unsubscribes pulled, the
 * suppression list read, contacts put right), for at most ADMIN_SYNC_BUDGET_MS. Ran: the sync's report as it is (`finished: false` when the time
 * ran out and the rest waits for the next run), and the open page is refreshed. Not run, in a code: `notConfigured` (no marketing key: nothing is
 * asked of Resend), `busy` (another full sync holds the lease, fullSync: the cron, another tab; not an error, so not logged as one),
 * `permission` (the key can only send, or is not accepted: a full-access key is needed), `unavailable` (Resend does not answer), `server`
 * (anything else, such as the database: logged by the error's class, never its message).
 */
export const fullSyncAction = adminAction(
  async (): Promise<FullSyncReport | { error: "notConfigured" | "busy" | "permission" | "unavailable" | "server" }> => {
    try {
      const deps = adminMarketingDeps(ADMIN_SYNC_BUDGET_MS);
      if (!marketingConfigured(deps.env)) return { error: "notConfigured" };
      const report = await fullSync(deps);
      refresh();
      return report;
    } catch (e) {
      if (e instanceof FullSyncBusy) return { error: "busy" }; // (fullSync logged it)
      logFailure("[newsletter-sync] the admin's sync failed", e);
      if (e instanceof MarketingUnavailable) return { error: keyRefused(e) ? "permission" : "unavailable" };
      return { error: "server" };
    }
  },
);

const rowId = z.number().int().min(1).max(ROW_ID_MAX);
const idOnly = z.object({ id: rowId });
const saveTarget = z.object({ id: rowId.nullable() });
const testInput = z.object({ id: rowId, to: z.enum(["maria", "me"]), locale: z.enum(["et", "ru"]) });
const scopeInput = z.enum(["all", "missing"]).default("all");
const prepareInput = z.object({ id: rowId, scope: scopeInput });
/** A count Maria confirmed: a whole number, never more than the plan's limit could ever hold. */
const confirmedCount = z.number().int().min(0).max(1_000_000);
const sendInput = z.object({ id: rowId, et: confirmedCount, ru: confirmedCount, scope: scopeInput });

type Server = { ok: false; error: "server" };
const SERVER: Server = { ok: false, error: "server" };

/**
 * „Salvesta“: `{ id, draft }`, `id` null for a new campaign. The draft goes through the rules (newsletter-campaigns.ts saveCampaign): saved
 * `{ ok: true, id }` and the page refreshed; refused fields by name in `fields`; `sent` for a campaign sent meanwhile, `notFound` for one that is gone.
 */
export const saveCampaignAction = adminAction(async (_admin, input: { id: number | null; draft: unknown }) => {
  const target = saveTarget.safeParse(input);
  if (!target.success) return { ok: false as const, error: "notFound" as const };
  const { id } = target.data;
  try {
    const result = await saveCampaign(getDb(), id, input.draft, new Date());
    if (result.ok) refresh();
    return result;
  } catch (e) {
    logFailure(id === null ? "[newsletter] a new campaign's save failed" : `[newsletter] campaign ${id}: the save failed`, e);
    return SERVER;
  }
});

/** „Kopeeri“: `{ id }`. The new draft's `{ ok: true, id }` and the page refreshed; `notFound` for a campaign that is gone. */
export const copyCampaignAction = adminAction(async (_admin, input: { id: number }) => {
  const parsed = idOnly.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "notFound" as const };
  const { id } = parsed.data;
  try {
    const result = await copyCampaign(getDb(), id, new Date());
    if (!result.ok) return { ok: false as const, error: "notFound" as const };
    refresh();
    return result;
  } catch (e) {
    logFailure(`[newsletter] campaign ${id}: the copy failed`, e);
    return SERVER;
  }
});

/**
 * „Saada proov“: `{ id, to, locale }`, `to` "maria" (MARIA_EMAIL) or "me" (the signed-in admin's own address). The stored campaign as one test
 * broadcast (newsletter-campaigns.ts sendTest): `{ ok: true, realLink }`, or a code. `address`: no such address (MARIA_EMAIL empty, an address
 * the page never sends). Nothing on the page changes, so nothing is refreshed.
 */
export const sendTestAction = adminAction(async (admin, input: { id: number; to: "maria" | "me"; locale: "et" | "ru" }) => {
  if (!rowId.safeParse((input as { id?: unknown } | null)?.id).success) return { ok: false as const, error: "notFound" as const };
  const parsed = testInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "address" as const };
  const { id, to, locale } = parsed.data;
  try {
    const deps = adminMarketingDeps(ADMIN_SYNC_BUDGET_MS);
    const address = normalizeEmail(to === "maria" ? deps.env.MARIA_EMAIL : admin.email);
    if (address === "") return { ok: false as const, error: "address" as const };
    return await sendTest(deps, id, address, locale);
  } catch (e) {
    logFailure(`[newsletter] campaign ${id}: the test failed`, e);
    return SERVER;
  }
});

/**
 * „Saada kõigile“ (or „Saada puuduv keel“: `scope` "missing", ruling R12), before the confirmation: `{ id, scope }`. The sync, then the plan
 * (newsletter-campaigns.ts prepareSend), or a code. Sends nothing.
 */
export const prepareSendAction = adminAction(async (_admin, input: { id: number; scope?: SendScope }): Promise<Awaited<ReturnType<typeof prepareSend>> | Server> => {
  const parsed = prepareInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "notFound" };
  const { id, scope } = parsed.data;
  try {
    const result = await prepareSend(adminMarketingDeps(ADMIN_SYNC_BUDGET_MS), id, scope);
    if (!result.ok && (result.error === "sent" || result.error === "notFound")) refresh(); // (the open page is behind: its row shows the new state)
    return result;
  } catch (e) {
    logFailure(`[newsletter] campaign ${id}: the send's preparation failed`, e);
    return SERVER;
  }
});

/**
 * „Saada“: `{ id, et, ru, scope }`, `et` / `ru` the counts Maria confirmed (ruling R14). The sync and the send (newsletter-campaigns.ts
 * sendCampaign); `changed` with the new plan when the counts moved meanwhile, nothing sent. The page is refreshed when the campaign changed (sent,
 * left half way) or the open page is behind (sent or gone meanwhile); not after a refusal that changed nothing.
 */
export const sendCampaignAction = adminAction(async (_admin, input: { id: number; et: number; ru: number; scope?: SendScope }): Promise<SendResult | Server> => {
  const parsed = sendInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "notFound" };
  const { id, et, ru, scope } = parsed.data;
  try {
    const result = await sendCampaign(adminMarketingDeps(ADMIN_SYNC_BUDGET_MS), id, { et, ru }, scope);
    if (result.ok || result.error === "interrupted" || result.error === "sent" || result.error === "notFound") refresh();
    return result;
  } catch (e) {
    logFailure(`[newsletter] campaign ${id}: the send failed`, e);
    refresh(); // (it may have stopped after `sending` was written: the page shows the state it left)
    return SERVER;
  }
});
