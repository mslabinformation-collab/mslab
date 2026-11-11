import { and, asc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Q } from "@/db/client";
import { certificateDesigns, contentDrafts, courses } from "@/db/schema";
import type { SaveAnswer } from "@/domain/autosave";
import {
  BACKGROUND_MAX_BYTES, checkDesignName, firstDesign, isBackgroundKey, isDesignTone, type CertificateDesign, type DesignTone,
} from "@/domain/certificate-design";
import { contentVersion } from "@/lib/version";
import { fieldCodes, refusedFields } from "./autosave-route";
import { hasImageSignature, type MediaSource } from "./media";

// Seaded → Tunnistus → „Kujundused“ (2026-11-11 certificate designs, spec §3, §5.1), without Next.js: the list of certificate designs (a name, a tone,
// an optional background photo), each row autosaved on its own (POST /api/admin/tunnistuse-kujundus/<id>, server/autosave-route.ts' contract) from
// its own version, „Lisa kujundus“ (an explicit create) and „Kustuta“. An e-course picks one on its „Tunnistus“ card (courses.certificate_design_id,
// none: the first design) and each certificate keeps a copy of its look from its issue (server/certificates.ts), so nothing here changes a
// certificate already issued, and a photo is never removed from the store (spec §5.1, my call: no clean-up of background images).
// The name's uniqueness, the create's name and the delete's „last one“ and „in use“ are judged under one transaction lock
// (`certificate-designs`); the delete also locks the design rows, which a course's save of its pick reads FOR KEY SHARE
// (server/admin-content.ts checkCourseCertificateDesign), so a delete and a pick of the same design never both go through.

const DESIGN_LOCK = "certificate-designs";
const lockDesigns = (q: Q) => q.execute(sql`select pg_advisory_xact_lock(hashtext(${DESIGN_LOCK}))`);

/** The name a new design gets: „Uus kujundus“, else the first of „Uus kujundus 2“, „… 3“, … no other design has. */
const NEW_NAME = "Uus kujundus";

/** A row's fields as its autosave holds them. */
export type DesignFields = { name: string; tone: DesignTone; backgroundKey: string };

/** The designs, the first first (lowest sort, then lowest id: domain/certificate-design.ts firstDesign's order). */
export async function listCertificateDesigns(q: Q): Promise<CertificateDesign[]> {
  return q.select().from(certificateDesigns).orderBy(asc(certificateDesigns.sort), asc(certificateDesigns.id));
}

/** A row's version: "k:" and the hash of its name, tone and photo (its sort moves nothing: no screen changes it). */
const versionOf = async (d: DesignFields): Promise<string> => `k:${await contentVersion({ name: d.name, tone: d.tone, backgroundKey: d.backgroundKey })}`;
const fieldsOf = (d: DesignFields): DesignFields => ({ name: d.name, tone: d.tone, backgroundKey: d.backgroundKey });

/**
 * How many courses use each design (the „Kustuta“ rule, spec §5.1: live or draft): an e-course's pick as stored, and the pick in its „Tunnistus“
 * draft when the draft names one; a pick of none (null) is the first design's. A contact course uses none. A course is counted once per design.
 */
export async function designUsage(q: Q, designs: readonly CertificateDesign[]): Promise<Map<number, number>> {
  const first = firstDesign(designs)?.id ?? null;
  const rows = await q.select({ id: courses.id, type: courses.type, pick: courses.certificateDesignId }).from(courses);
  const drafts = await q
    .select({ courseId: contentDrafts.entityId, value: contentDrafts.value })
    .from(contentDrafts)
    .where(and(eq(contentDrafts.entity, "course"), eq(contentDrafts.part, "certificate")));
  const drafted = new Map<number, number | null>();
  for (const d of drafts) {
    const value = d.value as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || !("certificateDesignId" in value)) continue;
    const pick = value.certificateDesignId;
    if (pick === null || (typeof pick === "number" && Number.isInteger(pick))) drafted.set(d.courseId, pick);
  }
  const usage = new Map<number, number>(designs.map((d) => [d.id, 0]));
  for (const course of rows) {
    if (course.type !== "e_learning") continue;
    const used = new Set<number | null>([course.pick ?? first]);
    if (drafted.has(course.id)) used.add(drafted.get(course.id) ?? first);
    for (const id of used) if (id !== null && usage.has(id)) usage.set(id, usage.get(id)! + 1);
  }
  return usage;
}

/** What Seaded's card shows of each design: its fields, its version (its autosave goes from it) and how many courses use it. */
export type DesignCardRow = CertificateDesign & { version: string; courses: number };

/** Seaded → Tunnistus → „Kujundused“ as the page reads it: the designs in order, each with its version and its courses. */
export async function certificateDesignsCard(q: Q): Promise<DesignCardRow[]> {
  const designs = await listCertificateDesigns(q);
  const usage = await designUsage(q, designs);
  return Promise.all(designs.map(async (d) => ({ ...d, version: await versionOf(d), courses: usage.get(d.id) ?? 0 })));
}

/**
 * The patch of a row's autosave (the route's schema): some of its fields as typed, no other key. The outer limits only, each refusal its field's
 * code: the real rules are the write's (the name's checkDesignName, the tone, the photo).
 */
export const DESIGN_PATCH = z
  .strictObject(
    {
      name: z.string({ error: "invalid" }).max(1_000, "tooLong"),
      tone: z.string({ error: "invalid" }).max(20, "invalid"),
      backgroundKey: z.string({ error: "invalid" }).max(300, "image"),
    },
    { error: "invalid" },
  )
  .partial();

/** A row as its autosave reads it (the route's `read`): its version and fields; null when there is no such design (404). */
export async function readCertificateDesign(q: Q, id: number): Promise<{ version: string; value: DesignFields } | null> {
  const [row] = await q.select().from(certificateDesigns).where(eq(certificateDesigns.id, id)).limit(1);
  return row ? { version: await versionOf(row), value: fieldsOf(row) } : null;
}

/**
 * Is the photo one a certificate can embed as it is (spec §4): a JPEG upload (img/<uuid>.jpg) that the store has, whose bytes start as a JPEG's,
 * of at most 1.5 MB? The upload route held it to that (POST /api/admin/upload?for=certificate-background); this holds a key from anywhere else to it
 * too, so a design can never make every download of its certificates fail or grow. No store: no photo can be checked, none is taken.
 */
async function photoUsable(key: string, store: MediaSource | null): Promise<boolean> {
  if (!isBackgroundKey(key) || key === "" || !store) return false;
  const object = await store.get(key);
  if (!object) return false;
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  return bytes.byteLength > 0 && bytes.byteLength <= BACKGROUND_MAX_BYTES && hasImageSignature("image/jpeg", bytes.subarray(0, 16));
}

/**
 * A row's autosave (the route's `write`): `patch` (some of its fields) over the design at `version`, under the designs' lock and the row's. The
 * answers (server/autosave-route.ts):
 * - ok with the version after it; a patch that changes nothing answers the version it came from and writes nothing;
 * - a conflict with the stored version and fields when `version` is not the row's (another tab saved first); a design deleted meanwhile: version
 *   "", value null;
 * - invalid by field: `name` required | tooLong | taken (another design's, in any case), `tone` invalid, `backgroundKey` image (not a JPEG upload
 *   the store has, or over 1.5 MB). A new photo is looked at in the store before the transaction (no lock waits for the store).
 */
export async function writeCertificateDesign(db: Db, id: number, patch: Record<string, unknown>, version: string, store: MediaSource | null): Promise<SaveAnswer> {
  const parsed = DESIGN_PATCH.safeParse(patch);
  if (!parsed.success) return { ok: false, error: "invalid", fields: fieldCodes(parsed.error.issues) ?? Object.fromEntries(Object.keys(patch).map((k) => [k, "invalid"])) };
  const p = parsed.data;
  const sent = Object.keys(p);
  const savedAt = new Date().toISOString();
  const photo = p.backgroundKey;
  // the store is asked outside the transaction; an unchanged photo is not asked again (the transaction compares it with the stored one)
  const photoOk = photo === undefined || photo === "" ? true : await photoUsable(photo, store);
  return db.transaction(async (tx): Promise<SaveAnswer> => {
    await lockDesigns(tx);
    const [row] = await tx.select().from(certificateDesigns).where(eq(certificateDesigns.id, id)).for("update");
    if (!row) return { ok: false, error: "conflict", version: "", value: null };
    const current = await versionOf(row);
    if (version !== current) return { ok: false, error: "conflict", version: current, value: fieldsOf(row) };
    const fields: Record<string, string> = {};
    let name = row.name;
    if (p.name !== undefined) {
      const others = (await tx.select({ id: certificateDesigns.id, name: certificateDesigns.name }).from(certificateDesigns)).filter((d) => d.id !== id).map((d) => d.name);
      const checked = checkDesignName(p.name, others);
      if (checked.ok) name = checked.name;
      else fields.name = checked.error;
    }
    let tone = row.tone;
    if (p.tone !== undefined) {
      if (isDesignTone(p.tone)) tone = p.tone;
      else fields.tone = "invalid";
    }
    let backgroundKey = row.backgroundKey;
    if (photo !== undefined && photo !== row.backgroundKey) {
      if (photoOk) backgroundKey = photo;
      else fields.backgroundKey = "image";
    }
    if (Object.keys(fields).length > 0) return { ok: false, error: "invalid", fields: refusedFields(fields, sent) };
    const next = { name, tone, backgroundKey };
    if (name === row.name && tone === row.tone && backgroundKey === row.backgroundKey) return { ok: true, version: current, savedAt };
    await tx.update(certificateDesigns).set(next).where(eq(certificateDesigns.id, id));
    return { ok: true, version: await versionOf(next), savedAt };
  });
}

/**
 * „Lisa kujundus“ (the card's explicit create): a light design without a photo, last in the list (the highest sort plus one), named „Uus kujundus“
 * or the first „Uus kujundus {n}“ no design has; Maria renames it in its row. Under the designs' lock, so two at once get two names.
 */
export async function createCertificateDesign(db: Db): Promise<{ id: number }> {
  return db.transaction(async (tx) => {
    await lockDesigns(tx);
    const names = new Set((await tx.select({ name: certificateDesigns.name }).from(certificateDesigns)).map((d) => d.name.toLocaleLowerCase("et")));
    let name = NEW_NAME;
    for (let n = 2; names.has(name.toLocaleLowerCase("et")); n++) name = `${NEW_NAME} ${n}`;
    const [{ top }] = await tx.select({ top: max(certificateDesigns.sort) }).from(certificateDesigns);
    // (returning(fields) has no common overload on the Db union: the whole row)
    const [row] = await tx.insert(certificateDesigns).values({ name, tone: "light", backgroundKey: "", sort: (top ?? 0) + 1 }).returning();
    return { id: row.id };
  });
}

export type DeleteDesignResult = { ok: true } | { ok: false; error: "gone" } | { ok: false; error: "last" } | { ok: false; error: "inUse"; courses: number };

/**
 * „Kustuta“ (spec §5.1): the design goes when no course uses it (designUsage: live or draft, the first design also for an e-course with no pick)
 * and it is not the last one. Certificates keep their copy of its look, and its photo stays in the store. Under the designs' lock, with every
 * design row locked (a course's save of a pick reads its design FOR KEY SHARE and waits for this, or this waits for it and then sees the course).
 */
export async function deleteCertificateDesign(db: Db, id: number): Promise<DeleteDesignResult> {
  return db.transaction(async (tx): Promise<DeleteDesignResult> => {
    await lockDesigns(tx);
    const designs = await tx.select().from(certificateDesigns).orderBy(asc(certificateDesigns.sort), asc(certificateDesigns.id)).for("update");
    if (!designs.some((d) => d.id === id)) return { ok: false, error: "gone" };
    const n = (await designUsage(tx, designs)).get(id) ?? 0;
    if (n > 0) return { ok: false, error: "inUse", courses: n };
    if (designs.length <= 1) return { ok: false, error: "last" };
    await tx.delete(certificateDesigns).where(eq(certificateDesigns.id, id));
    return { ok: true };
  });
}
