import { z, type ZodType } from "zod";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { lockTables, readSetting } from "@/db/queries/admin-site";
import type { SaveAnswer } from "@/domain/autosave";
import { FINANCING_KEY, readFinancingSettings } from "@/domain/financing";
import { contentVersion } from "@/lib/version";
import { SETTINGS_PARTS, settingsPartPatch, writeSettingsPart, type SettingsPart } from "./admin-site";
import { fieldCodes } from "./autosave-route";
import { CERTIFICATE_SETTINGS_PATCH, saveCertificateSettings } from "./certificates";
import { INVOICE_SETTINGS_PATCH, saveInvoiceSettings } from "./invoices";
import { revalidatePublic } from "./public-cache";

// Seaded's autosave (admin UX pass piece 3b, Task 4; README B4, B21; ruling R-f): every card of the page saves on POST /api/admin/seaded/<part>
// (server/autosave-route.ts' contract) under the page's one SaveStatus. The parts:
// - contact, newsletter, prepayment — the settings parts of server/admin-site.ts (writeSettingsPart), the version the stored setting's hash;
// - invoice — the invoice settings of the „Maksmine“ card (server/invoices.ts saveInvoiceSettings), certificate — „Tunnistus“
//   (server/certificates.ts saveCertificateSettings): each under its number series' lock, the version two hashes of the stored JSON (its texts, its
//   counter), so an issue meanwhile is no conflict of a text, and a number already issued is `taken`;
// - financing — „Järelmaks (Inbank)“'s switch, instant: `{ enabled }` and nothing else (domain/financing.ts, off unless exactly true).
// A write that changed something revalidates the public pages that show the part (server/cache-targets.ts "settings": the footer's contact and
// newsletter, the course pages' and the carts' financing; the others have no public page). The legal texts are not parts here: they keep their own
// save until their drafts (Task 5).

export const SEADED_PARTS = [...SETTINGS_PARTS, "invoice", "certificate", "financing"] as const;
export type SeadedPart = (typeof SEADED_PARTS)[number];

export const isSeadedPart = (value: string): value is SeadedPart => (SEADED_PARTS as readonly string[]).includes(value);
const isSettingsPart = (part: SeadedPart): part is SettingsPart => (SETTINGS_PARTS as readonly string[]).includes(part);

/** The switch's patch: a real boolean (not "true", not 1), nothing else. */
const FINANCING_PATCH = z.strictObject({ enabled: z.boolean({ error: "invalid" }) }, { error: "invalid" }).partial();

/** The route's schema of `part`'s patch. */
export function seadedPatch(part: SeadedPart): ZodType<Record<string, unknown>> {
  if (part === "invoice") return INVOICE_SETTINGS_PATCH;
  if (part === "certificate") return CERTIFICATE_SETTINGS_PATCH;
  if (part === "financing") return FINANCING_PATCH;
  return settingsPartPatch(part);
}

/** The switch's version: the hash of the stored setting (as the settings parts'); the page reads it of the row it shows, the write of the row it locks. */
export const financingVersionOf = (stored: unknown): Promise<string> => contentVersion(stored);

/**
 * „Järelmaks (Inbank)“: `{ enabled }` over the stored switch at `version`, with the settings table locked as every settings save locks it; another
 * version is a conflict with the switch as read (readFinancingSettings). Stored as `{ enabled }` and nothing else of what came; the same state again
 * writes nothing.
 */
async function writeFinancing(db: Db, patch: unknown, version: string, now: Date): Promise<SaveAnswer & { changed?: boolean }> {
  const parsed = FINANCING_PATCH.safeParse(patch);
  if (!parsed.success) return { ok: false, error: "invalid", fields: fieldCodes(parsed.error.issues) ?? {} };
  const savedAt = now.toISOString();
  return db.transaction(async (tx) => {
    await lockTables(tx, ["settings"]);
    const stored = await readSetting(tx, FINANCING_KEY);
    const current = await financingVersionOf(stored);
    if (current !== version) return { ok: false, error: "conflict", version: current, value: readFinancingSettings(stored) };
    const { enabled } = parsed.data;
    const next = { enabled: enabled ?? readFinancingSettings(stored).enabled };
    if ((await contentVersion(next)) === current) return { ok: true, version: current, savedAt };
    await setSetting(tx, FINANCING_KEY, next);
    return { ok: true, version: await financingVersionOf(next), savedAt, changed: true };
  });
}

/**
 * One Seaded part's autosave (the route's `write`): the part's own writer, then — after its commit, when it wrote — the public pages that show it
 * revalidated once. The answer is the writer's (SaveAnswer).
 */
export async function writeSeadedPart(db: Db, part: SeadedPart, patch: unknown, version: string, now: Date): Promise<SaveAnswer> {
  let answer: SaveAnswer & { changed?: boolean };
  if (part === "invoice") answer = await saveInvoiceSettings(db, patch, version, now);
  else if (part === "certificate") answer = await saveCertificateSettings(db, patch, version, now);
  else if (part === "financing") answer = await writeFinancing(db, patch, version, now);
  else if (isSettingsPart(part)) answer = await writeSettingsPart(db, part, patch, version, now);
  else answer = { ok: false, error: "invalid", fields: {} };
  if (answer.ok && answer.changed) revalidatePublic({ kind: "settings", parts: [part] });
  if (!answer.ok) return answer;
  return { ok: true, version: answer.version, savedAt: answer.savedAt };
}
