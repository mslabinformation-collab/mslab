"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ROW_ID_MAX } from "@/lib/row-id";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import { copyCampaign, saveCampaign } from "../newsletter-campaigns";

// Maria's campaign actions (newsletter campaigns, the „Kampaaniad“ tab): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is
// newsletter-campaigns.ts; here the input is checked once more (an id the page never sends is `notFound` without a read), each refusal is a code the
// editor puts into words (adminEt.newsletter.campaigns.errorsOf), a throw is `server` (logged by the error's class and the campaign's id, never a
// message), and a change refreshes the open page.

const rowId = z.number().int().min(1).max(ROW_ID_MAX);
const idOnly = z.object({ id: rowId });
const saveTarget = z.object({ id: rowId.nullable() });

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
