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
  createDraft,
  deleteDraft,
  prepareSend,
  PRESS_BUDGET_MS,
  sendTest,
  startSend,
  stopSend,
} from "../newsletter-campaigns";
import { campaignSendDeps } from "../send-deps";

// Maria's letter actions (newsletter campaigns, the „Kirjad“ tab): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is
// newsletter-campaigns.ts; here the input is checked once more (an id the page never sends is `notFound` without a read, and „Saada proov“'s address is
// MARIA_EMAIL or the signed-in admin's own, never one the browser names), each refusal is a code the editor puts into words
// (adminEt.newsletter.campaigns.errorsOf), a throw is `server` (logged by the error's class and the campaign's id, never a message), and a change
// refreshes the open page. The sends (the 20.10 design) run on SITE_URL (send-deps.ts campaignSendDeps), the press within PRESS_BUDGET_MS, under the
// page's own limit (uudiskiri/page.tsx maxDuration). A letter's fields autosave on their route (api/admin/kiri/<id>, piece 3b Task 6): no action saves
// them; „Uus kiri +“ and „Kustuta mustand“ are the actions of their own (createDraftAction, deleteDraftAction).

const rowId = z.number().int().min(1).max(ROW_ID_MAX);
const idOnly = z.object({ id: rowId });
/** „Saada kõigile“'s first step: the letter and its autosave version as the screen holds it (newsletter-campaigns.ts campaignVersion). */
const prepareInput = z.object({ id: rowId, version: z.string().min(1).max(100) });
/** A count Maria confirmed: a whole number, never more than a list could ever hold. */
const confirmedCount = z.number().int().min(0).max(1_000_000);
/** The campaign's last change as the confirmation read it (prepareSend's `updatedAt`): an ISO instant. */
const sendInput = z.object({ id: rowId, et: confirmedCount, ru: confirmedCount, updatedAt: z.iso.datetime() });
/** „Saada proov“: the letter, the address and language chosen, and the letter's version on the screen (ruling R-j; the same as `prepareInput`'s). */
const testInput = z.object({ id: rowId, to: z.enum(["maria", "me"]), locale: z.enum(["et", "ru"]), version: z.string().min(1).max(100) });

type Server = { ok: false; error: "server" };
const SERVER: Server = { ok: false, error: "server" };

/** „Uus kiri +“ (S3-P3-h, ruling R-g): a new draft „Uus kiri“ at once; `{ ok: true, id }` (the editor opens it, the cursor in „Nimi“) and the page refreshed. */
export const createDraftAction = adminAction(async () => {
  try {
    const { id } = await createDraft(getDb(), new Date());
    refresh();
    return { ok: true as const, id };
  } catch (e) {
    logFailure("[newsletter] a new letter's create failed", e);
    return SERVER;
  }
});

/**
 * „Kustuta mustand“ (B17): `{ id }`. A draft is deleted (newsletter-campaigns.ts deleteDraft, under the press's lock): `{ ok: true }` (the editor moves
 * to the list itself: a refresh here would first show the gone letter's „Seda kirja enam pole.“); `sent` for a letter sent or going out meanwhile and
 * `notFound` for one that is gone, the page refreshed (it is behind); `notFound` without a read for an id the page never sends.
 */
export const deleteDraftAction = adminAction(async (_admin, input: { id: number }) => {
  const parsed = idOnly.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "notFound" as const };
  const { id } = parsed.data;
  try {
    const result = await deleteDraft(getDb(), id);
    if (result === "ok") return { ok: true as const };
    refresh();
    return { ok: false as const, error: result };
  } catch (e) {
    logFailure(`[newsletter] campaign ${id}: the delete failed`, e);
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
 * „Saada kõigile“, before the confirmation: `{ id, version }`, `version` the letter's autosave version on the screen after its flush (`changed` when another
 * tab or device saved it since: the press would send a text she has not seen; piece 3b Task 6 review I2). What the confirmation shows (newsletter-campaigns.ts prepareSend: the counts by language, the
 * sample addresses left out, `ruFallsBack`, `updatedAt`), or a code: `busy` (another campaign is going out), `empty`, `sent`, `notFound`, `changed`, or
 * `invalid` with the fields the sends' rules refuse (ruling R-g). Sends nothing; the page is refreshed only when it is behind (the campaign sent, gone or
 * saved elsewhere meanwhile).
 */
export const prepareSendAction = adminAction(async (_admin, input: { id: number; version: string }): Promise<Awaited<ReturnType<typeof prepareSend>> | Server> => {
  const parsed = prepareInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "notFound" };
  const { id, version } = parsed.data;
  try {
    const result = await prepareSend(getDb(), id, version);
    if (!result.ok && !("fields" in result) && (result.error === "sent" || result.error === "notFound" || result.error === "changed")) refresh();
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
 * nothing sent), `busy`, `empty`, `sent`, `notFound`, `invalid` (the sends' rules). The page is refreshed when the campaign changed or the page is
 * behind; not after a refusal that changed nothing.
 */
export const startSendAction = adminAction(async (_admin, input: { id: number; et: number; ru: number; updatedAt: string }): Promise<Awaited<ReturnType<typeof startSend>> | Server> => {
  const parsed = sendInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "notFound" };
  const { id, et, ru, updatedAt } = parsed.data;
  try {
    const result = await startSend(campaignSendDeps(PRESS_BUDGET_MS), id, { et, ru, updatedAt });
    if (result.ok || (!("fields" in result) && (result.error === "sent" || result.error === "notFound"))) refresh();
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
 * „Saada proov“: `{ id, to, locale, version }`, `to` "maria" (MARIA_EMAIL) or "me" (the signed-in admin's own address), `version` the letter's autosave
 * version on the screen after its flush (ruling R-j, as `prepareSendAction`'s). One ordinary mail of the stored campaign (newsletter-campaigns.ts
 * sendTest): `{ ok: true }`, or a code: `changed` (another tab or device saved the letter since: nothing sent, and the page is refreshed, as the panel's
 * read does), `limited` (ten this hour), `mail` (it did not go), `notFound`, `address` (no such address: MARIA_EMAIL empty, or an address, a language or
 * a version the page never sends), `invalid` with the fields the sends' rules refuse (ruling R-g). A sent test changes nothing on the page, so only
 * `changed` refreshes it.
 */
export const sendTestAction = adminAction(async (admin, input: { id: number; to: "maria" | "me"; locale: "et" | "ru"; version: string }) => {
  if (!rowId.safeParse((input as { id?: unknown } | null)?.id).success) return { ok: false as const, error: "notFound" as const };
  const parsed = testInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "address" as const };
  const { id, to, locale, version } = parsed.data;
  try {
    const deps = campaignSendDeps(PRESS_BUDGET_MS);
    const address = normalizeEmail(to === "maria" ? deps.env.MARIA_EMAIL : admin.email);
    if (address === "") return { ok: false as const, error: "address" as const };
    const result = await sendTest(deps, id, address, locale, version);
    if (!result.ok && result.error === "changed") refresh();
    return result;
  } catch (e) {
    logFailure(`[newsletter] campaign ${id}: the test failed`, e);
    return SERVER;
  }
});
