"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { FINANCING_KEY } from "@/domain/financing";
import { adminAction } from "../auth";
import { logFailure } from "../log";
import { revalidatePublic } from "../public-cache";

// Seaded's „Järelmaks (Inbank)“ toggle (instalments Task 5, spec D4): every export is wrapped in adminAction (a signed-in admin, or a redirect to
// /admin/login; tests/unit/admin-guards.test.ts fails otherwise), and Next.js refuses an action called from another origin. The setting is one
// switch, `settings.financing = { enabled }` (domain/financing.ts, off until Maria stores `true`); it needs no migration.

/** What the card sends: the checkbox, a real boolean (not "true", not 1). */
const input = z.object({ enabled: z.boolean() });

/**
 * Seaded → Järelmaks (Inbank) → „Salvesta“: `{ enabled }` as ticked. Stored as `{ enabled }` and nothing else of what came; the course pages (the
 * line, the form's choice) and the carts (the choice) are revalidated through the settings' path (server/cache-targets.ts "financing"), and the
 * page refreshes. Anything but a boolean is `{ ok: false, error: "invalid" }` and nothing is written. A throw is `{ ok: false, error: "server" }`,
 * logged by its label and the error's class only.
 */
export const saveFinancingSettingsAction = adminAction(async (_admin, raw: unknown) => {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: "invalid" as const };
  const { enabled } = parsed.data;
  try {
    await setSetting(getDb(), FINANCING_KEY, { enabled });
    revalidatePublic({ kind: "settings", parts: ["financing"] });
    refresh();
    return { ok: true as const, enabled };
  } catch (e) {
    logFailure("[financing] the settings save failed", e);
    return { ok: false as const, error: "server" as const };
  }
});
