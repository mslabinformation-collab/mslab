"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { normalizeEmail } from "@/domain/email";
import { ROW_ID_MAX } from "@/lib/row-id";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import {
  copyCampaign,
  prepareSend,
  PRESS_BUDGET_MS,
  saveCampaign,
  sendTest,
  startSend,
  stopSend,
} from "../newsletter-campaigns";
import { campaignSendDeps } from "../send-deps";

// Maria's campaign actions (newsletter campaigns, the „Kampaaniad“ tab): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is
// newsletter-campaigns.ts; here the input is checked once more (an id the page never sends is `notFound` without a read, and „Saada proov“'s address is
// MARIA_EMAIL or the signed-in admin's own, never one the browser names), each refusal is a code the editor puts into words
// (adminEt.newsletter.campaigns.errorsOf), a throw is `server` (logged by the error's class and the campaign's id, never a message), and a change
// refreshes the open page. The sends (the 20.10 design) run on SITE_URL (send-deps.ts campaignSendDeps), the press within PRESS_BUDGET_MS, under the
// page's own limit (uudiskiri/page.tsx maxDuration).

const rowId = z.number().int().min(1).max(ROW_ID_MAX);
const idOnly = z.object({ id: rowId });
const saveTarget = z.object({ id: rowId.nullable() });
/** A count Maria confirmed: a whole number, never more than a list could ever hold. */
const confirmedCount = z.number().int().min(0).max(1_000_000);
/** The campaign's last change as the confirmation read it (prepareSend's `updatedAt`): an ISO instant. */
const sendInput = z.object({ id: rowId, et: confirmedCount, ru: confirmedCount, updatedAt: z.iso.datetime() });
const testInput = z.object({ id: rowId, to: z.enum(["maria", "me"]), locale: z.enum(["et", "ru"]) });

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
 * „Saada kõigile“, before the confirmation: `{ id }`. What the confirmation shows (newsletter-campaigns.ts prepareSend: the counts by language,
 * `ruFallsBack`, `updatedAt`), or a code: `busy` (another campaign is going out), `empty`, `sent`, `notFound`. Sends nothing; the page is refreshed
 * only when it is behind (the campaign sent or gone meanwhile).
 */
export const prepareSendAction = adminAction(async (_admin, input: { id: number }): Promise<Awaited<ReturnType<typeof prepareSend>> | Server> => {
  const parsed = idOnly.safeParse(input);
  if (!parsed.success) return { ok: false, error: "notFound" };
  const { id } = parsed.data;
  try {
    const result = await prepareSend(getDb(), id);
    if (!result.ok && (result.error === "sent" || result.error === "notFound")) refresh();
    return result;
  } catch (e) {
    logFailure(`[newsletter] campaign ${id}: the send's preparation failed`, e);
    return SERVER;
  }
});

/**
 * „Saada“ after the confirmation: `{ id, et, ru, updatedAt }`, what the confirmation showed. The press and its first batch (newsletter-campaigns.ts
 * startSend, within PRESS_BUDGET_MS): `{ ok: true, progress, stopped }` (`stopped`: why rows still wait — `room`, the rest goes the next day;
 * `refused`, „Saatmine peatus: Resend keeldus. Kirjuta Dimile.“; `time`; or null, all sent), or a code: `changed` (the counts or the campaign moved:
 * nothing sent), `busy`, `empty`, `sent`, `notFound`. The page is refreshed when the campaign changed or the page is behind; not after a refusal that
 * changed nothing.
 */
export const startSendAction = adminAction(async (_admin, input: { id: number; et: number; ru: number; updatedAt: string }): Promise<Awaited<ReturnType<typeof startSend>> | Server> => {
  const parsed = sendInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "notFound" };
  const { id, et, ru, updatedAt } = parsed.data;
  try {
    const result = await startSend(campaignSendDeps(PRESS_BUDGET_MS), id, { et, ru, updatedAt });
    if (result.ok || result.error === "sent" || result.error === "notFound") refresh();
    return result;
  } catch (e) {
    logFailure(`[newsletter] campaign ${id}: the send failed`, e);
    refresh(); // (it may have stopped after `sending` was written: the page shows the state it left)
    return SERVER;
  }
});

/**
 * „Peata saatmine“: `{ id }`. What waits is skipped and the campaign is sent with its counts (newsletter-campaigns.ts stopSend): `{ ok: true, progress }`
 * and the page refreshed; `notSending` (a draft, or sent meanwhile: the page is refreshed too) or `notFound`.
 */
export const stopSendAction = adminAction(async (_admin, input: { id: number }): Promise<Awaited<ReturnType<typeof stopSend>> | Server> => {
  const parsed = idOnly.safeParse(input);
  if (!parsed.success) return { ok: false, error: "notFound" };
  const { id } = parsed.data;
  try {
    const result = await stopSend(getDb(), id, new Date());
    refresh();
    return result;
  } catch (e) {
    logFailure(`[newsletter] campaign ${id}: the stop failed`, e);
    return SERVER;
  }
});

/**
 * „Saada proov“: `{ id, to, locale }`, `to` "maria" (MARIA_EMAIL) or "me" (the signed-in admin's own address). One ordinary mail of the stored campaign
 * (newsletter-campaigns.ts sendTest): `{ ok: true }`, or a code: `limited` (ten this hour), `mail` (it did not go), `notFound`, `address` (no such
 * address: MARIA_EMAIL empty, or an address or a language the page never sends). Nothing on the page changes, so nothing is refreshed.
 */
export const sendTestAction = adminAction(async (admin, input: { id: number; to: "maria" | "me"; locale: "et" | "ru" }) => {
  if (!rowId.safeParse((input as { id?: unknown } | null)?.id).success) return { ok: false as const, error: "notFound" as const };
  const parsed = testInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "address" as const };
  const { id, to, locale } = parsed.data;
  try {
    const deps = campaignSendDeps(PRESS_BUDGET_MS);
    const address = normalizeEmail(to === "maria" ? deps.env.MARIA_EMAIL : admin.email);
    if (address === "") return { ok: false as const, error: "address" as const };
    return await sendTest(deps, id, address, locale);
  } catch (e) {
    logFailure(`[newsletter] campaign ${id}: the test failed`, e);
    return SERVER;
  }
});
