"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { adminAction } from "../auth";
import { serverEnv } from "../env";
import { serverKv } from "../kv";
import { logFailure } from "../log";
import { sendProtocol, sendProtocols, type BulkResult, type SendDeps, type SendInput, type SendOutcome } from "../protocols";
import { linkBase, requestOrigin } from "../site";

// The protocol screen's sends (phase protocols, spec §4, §8): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The work is in
// ../protocols.ts. The screen keeps its own state (the autosave's), so nothing is refreshed here, and no public page shows a protocol.

const item = z.object({
  registrationId: z.number().int().positive().max(2_147_483_647),
  version: z.number().int().positive().max(2_147_483_647),
  // the protocol's row the screen showed (a protocol deleted with the account and made again is "stale"); absent: an older screen, the version decides
  protocolId: z.number().int().positive().max(2_147_483_647).nullable().optional(),
});
const items = z.array(item).min(1).max(100);

async function deps(): Promise<SendDeps> {
  const env = { ...serverEnv(), KV: serverKv() };
  return {
    db: getDb(),
    env,
    // the mail's links: the address Maria works on (mslab.ee), or SITE_URL
    siteUrl: linkBase(requestOrigin(await headers()), env.SITE_URL),
    now: new Date(),
    later: (task) => after(() => task().catch((e) => logFailure("[protocols] a mail failed", e))),
  };
}

/** "Saada" / "Saada uuesti": one student's protocol, at the version the screen showed (after its last save was confirmed). */
export const sendProtocolAction = adminAction(async (_admin, input: SendInput): Promise<SendOutcome> => {
  const parsed = item.safeParse(input);
  if (!parsed.success) return { kind: "notFound" };
  try {
    return await sendProtocol(await deps(), parsed.data);
  } catch (e) {
    logFailure(`[protocols] registration ${parsed.data.registrationId}: the send failed`, e);
    return { kind: "failed" };
  }
});

/** "Lukusta ja saada kõik": the protocols the confirmation listed, each in a transaction of its own; a failure is reported by its id. */
export const sendProtocolsAction = adminAction(async (_admin, input: SendInput[]): Promise<BulkResult[]> => {
  const parsed = items.safeParse(input);
  if (!parsed.success) return [];
  return sendProtocols(await deps(), parsed.data);
});
