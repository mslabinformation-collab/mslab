import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Q, Tx } from "@/db/client";
import { readPage } from "@/db/queries/admin-site";
import { contentDrafts, courseAccess, type Page } from "@/db/schema";
import type { I18n } from "@/i18n/field";
import type { SaveAnswer } from "@/domain/autosave";
import { CONTRACT_CONTACT_KEY } from "@/domain/contract";
import { TERMS_PAGE_KEY, TERMS_PAGE_TITLE } from "@/domain/course-terms";
import { LEGAL_KEYS, legalI18n, legalProblems, sameLegalText, type LegalKey, type LegalState, type LegalText } from "@/domain/legal-text";
import { toStorable } from "@/lib/to-storable";
import { contentVersion } from "@/lib/version";
import { saveLegalParts } from "./admin-site";
import type { ContractSampleValues } from "./contract-sample";
import { saveContractTexts } from "./contracts";
import { dropDraftPart, readDrafts, saveDraftPart, type DraftPart } from "./drafts";
import { logFailure } from "./log";
import { revalidatePublic } from "./public-cache";

// The legal texts on the draft layer (admin UX pass piece 3b, Task 5; README B4, spec C6; rulings R-d, R-e; behaviours.md "Contract texts on the draft
// layer"): Privaatsus, Õppetingimused, E-koolituse leping and Kontaktkoolituse leping, each a `pages` row. Before, every changed save of a contract
// text published a new contract version (the e-course students gated again, open forms and carts refused, the pages revalidated); under autosave
// that would be one version per pause in typing. So:
// - Typing saves only to a draft: `content_drafts` (server/drafts.ts), entity "legal", entity_id 1 privacy, 2 terms, 3 course_terms,
//   4 contract_contact, part "text", value `{ title, body }` (both languages; ruling R-d). Never a `pages` row, never a version setting.
// - „Avalda uus leping“ / „Avalda uus tekst“ (publishLegal) writes the draft live through the existing writers UNCHANGED (spec C6): the legal parts of
//   admin-site.ts (privacy, terms, course_terms: their checks, their table lock, the e-course version's bump) or contracts.ts saveContractTexts (its
//   lock and the contact version's bump), then deletes the draft, and revalidates the pages that show the text as their saves did. A new contract
//   version is made exactly as a save made one, so a student's open form or cart that showed the old one is refused as today (shownVersionHolds).
// - There is no discard (R-d: the design draws none): typing the live text back removes the draft.
// - The versions the card's autosave holds are course-parts.ts': "l:<hash>" while there is no draft (the hash of the stored page row, which is the
//   version the writer compares), "d:<id>.<n>" with one (the draft row's own id and its counter), so a tab on an earlier draft never writes into a
//   later one. A publish names the version its screen holds: a draft another tab changed since is not published unseen.
// - One lock order: a text's own lock (a transaction lock of "legal-text:<key>") first, then its draft, then the writer's locks (the pages table, the
//   contact text's lock). Every draft save and every publish of the text takes it; nothing else writes these drafts.
// No Next.js here but the revalidation (server/public-cache.ts, mocked in the tests): tests/db/legal-drafts.test.ts runs it on PGlite.

export { LEGAL_KEYS, isLegalKey, type LegalKey, type LegalState, type LegalText } from "@/domain/legal-text";

const ENTITY = "legal";
const PART = "text";

/** Each text's row in `content_drafts` (ruling R-d). */
export const LEGAL_IDS: Record<LegalKey, number> = { privacy: 1, terms: 2, course_terms: 3, contract_contact: 4 };
/** Each text's page. */
const PAGE_KEYS: Record<LegalKey, string> = { privacy: "privacy", terms: "terms", course_terms: TERMS_PAGE_KEY, contract_contact: CONTRACT_CONTACT_KEY };

/** Text as typed, at most what the writers take raw (the real limits are the field's rule), without what Postgres cannot store (a NUL…). */
const raw = z.string({ error: "invalid" }).max(40_000, "tooLong").transform(toStorable);
const i18n = z.object({ et: raw, ru: raw.optional() }, { error: "invalid" }).transform((f) => ({ et: f.et, ru: f.ru ?? "" }));

/** A draft save's patch (the autosave route's schema): the title, the text, or both; no other field. */
export const legalPatch = z.strictObject({ title: i18n, body: i18n }, { error: "invalid" }).partial();
export type LegalPatch = z.infer<typeof legalPatch>;

const empty = (): { et: string; ru: string } => ({ et: "", ru: "" });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The live text as its card shows it: the page row's title and body; the e-course text's default title before its page exists (as its part reads it). */
function liveOf(key: LegalKey, row: Page | null): LegalText {
  if (!row) return { title: key === "course_terms" ? legalI18n(TERMS_PAGE_TITLE) : empty(), body: empty() };
  return { title: legalI18n(row.title), body: legalI18n(row.body) };
}

/** A stored draft's value read defensively (jsonb holds anything): its fields over live's. */
function draftValueOf(value: unknown, live: LegalText): LegalText {
  if (!isRecord(value)) return live;
  return { title: value.title === undefined ? live.title : legalI18n(value.title), body: value.body === undefined ? live.body : legalI18n(value.body) };
}

const draftVersion = (id: number, n: number): string => `d:${id}.${n}`;

type Stored = { state: LegalState; base: string; draft: DraftPart | null };

/** The text now: its page row's version (`base`), live, its draft. */
async function storedOf(q: Q, key: LegalKey): Promise<Stored> {
  const row = await readPage(q, PAGE_KEYS[key]);
  const base = await contentVersion(row);
  const live = liveOf(key, row);
  const [draft] = await readDrafts(q, ENTITY, LEGAL_IDS[key], { only: [PART] });
  if (!draft) return { state: { version: `l:${base}`, value: live, live, changed: false }, base, draft: null };
  const value = draftValueOf(draft.value, live);
  return { state: { version: draftVersion(draft.id, draft.version), value, live, changed: !sameLegalText(value, live) }, base, draft };
}

/** The text's lock, first thing in every transaction that writes its draft or publishes it (the lock order above). */
const lockText = (tx: Tx, key: LegalKey) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`legal-text:${key}`}))`);

/** A legal text as its card reads it (the autosave route's `read` too): the version, the draft over live, live, whether it differs. */
export async function readLegal(q: Q, key: LegalKey): Promise<LegalState> {
  return (await storedOf(q, key)).state;
}

/** The four, for the Seaded page. */
export async function readLegalTexts(q: Q): Promise<Record<LegalKey, LegalState>> {
  const out = {} as Record<LegalKey, LegalState>;
  for (const key of LEGAL_KEYS) out[key] = await readLegal(q, key);
  return out;
}

const conflict = (s: LegalState): SaveAnswer => ({ ok: false, error: "conflict", version: s.version, value: s.value });

/**
 * A card's save (the autosave route's `write`, server/autosave-route.ts' contract): `patch` (the title, the text or both, as typed) over the text the
 * card holds at `version`, into its draft. Each field sent is checked by the writers' rule first (domain/legal-text.ts: the Estonian text required, at
 * most 120 / 30 000 characters): a refused one is named, nothing stored. Then, under the text's lock: a version that is not the stored one's is a
 * conflict with what is stored (another tab, a publish meanwhile); the same text again writes nothing; typed back to live, the draft goes ("l:"
 * again); else the draft is made (from live's version) or saved (its compare-and-set). Never a `pages` row, never a version setting.
 */
export async function writeLegalDraft(db: Db, key: LegalKey, patch: { title?: I18n; body?: I18n }, version: string, admin: { email: string }): Promise<SaveAnswer> {
  const problems = legalProblems(patch);
  if (Object.keys(problems).length > 0) return { ok: false, error: "invalid", fields: problems as Record<string, string> };
  const savedAt = new Date().toISOString();
  const id = LEGAL_IDS[key];
  return db.transaction(async (tx): Promise<SaveAnswer> => {
    await lockText(tx, key);
    const s = await storedOf(tx, key);
    if (version !== s.state.version) return conflict(s.state);
    const next: LegalText = { title: patch.title ? legalI18n(patch.title) : s.state.value.title, body: patch.body ? legalI18n(patch.body) : s.state.value.body };
    if (sameLegalText(next, s.state.value)) return { ok: true, version: s.state.version, savedAt };
    if (sameLegalText(next, s.state.live)) {
      // typed back to what is live: no change is left to publish
      if (s.draft) await dropDraftPart(tx, ENTITY, id, PART);
      return { ok: true, version: `l:${s.base}`, savedAt };
    }
    const saved = await saveDraftPart(tx, { entity: ENTITY, entityId: id, part: PART, value: next, baseVersion: s.base, version: s.draft?.version ?? null, by: admin.email });
    if (saved.ok) {
      const rowId = s.draft?.id ?? (await readDrafts(tx, ENTITY, id, { only: [PART] }))[0]?.id;
      if (rowId !== undefined) return { ok: true, version: draftVersion(rowId, saved.version), savedAt };
    }
    // (under the text's lock nothing saves the draft between the read and the write: answered as any conflict)
    return conflict((await storedOf(tx, key)).state);
  });
}

/**
 * What „Jah, avalda“ gets: the text as stored after it (`state`: no draft, live the published text, at its new version); "changed", the screen's
 * version is not the stored one's (another tab typed into the draft, or published it, meanwhile: P-11 „Seda teksti muudeti vahepeal teises aknas.“)
 * or live was written another way after the draft began, with the text as stored now; "invalid", the writer refused a field (a first contact text
 * without its title), by field.
 */
export type PublishAnswer = { ok: true; state: LegalState } | { ok: false; error: "changed"; state: LegalState } | { ok: false; error: "invalid"; fields: Record<string, string> };

/** The writers' answer by the card's field names: "course_terms.title" → "title"; a refusal of the whole shape is the form's. */
function byField(fields: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, code] of Object.entries(fields ?? { form: "invalid" })) out[name.slice(name.lastIndexOf(".") + 1)] = code;
  return out;
}

/** The draft's value written live through the text's existing writer, unchanged, inside `tx` (its own transaction a savepoint of it). */
async function writeLive(tx: Tx, key: LegalKey, base: string, value: LegalText, now: Date): Promise<"ok" | "stale" | Record<string, string>> {
  if (key === "contract_contact") {
    const result = await saveContractTexts(tx, value, now);
    return result.ok ? "ok" : byField(result.fields);
  }
  const result = await saveLegalParts(tx, { [key]: { version: base, value } });
  if (result.ok) return "ok";
  return result.error === "stale" ? "stale" : byField(result.fields as Record<string, string> | undefined);
}

/**
 * „Avalda uus leping“ / „Avalda uus tekst“ of `key` from the `version` its screen holds (spec C6), in one transaction under the text's lock:
 * - the screen's version must be the stored one's, else "changed" with what is stored (nothing written);
 * - no draft: nothing to publish (pressed again, or typed back meanwhile): ok, nothing written — a second publish never bumps a version;
 * - live written another way after the draft began (its base is not live's version): "changed", nothing overwritten unseen; the draft is kept on the
 *   live version now, so once she has looked, the next press publishes it (there is no discard to start again from);
 * - else the existing writer (writeLive) stores it — refused by field: "invalid", nothing written — and the draft is deleted.
 * After the commit, a published text revalidates the pages that show it, as its save did (server/cache-targets.ts "settings"; a failure is logged:
 * the publish stands).
 */
export async function publishLegal(db: Db, key: LegalKey, version: string, now: Date): Promise<PublishAnswer> {
  const answer = await db.transaction(async (tx): Promise<PublishAnswer & { published?: boolean }> => {
    await lockText(tx, key);
    const s = await storedOf(tx, key);
    if (version !== s.state.version) return { ok: false, error: "changed", state: s.state };
    if (!s.draft) return { ok: true, state: s.state };
    if (s.draft.baseVersion !== s.base) {
      await tx.update(contentDrafts).set({ baseVersion: s.base }).where(eq(contentDrafts.id, s.draft.id));
      return { ok: false, error: "changed", state: s.state };
    }
    const written = await writeLive(tx, key, s.base, s.state.value, now);
    if (written === "stale") return { ok: false, error: "changed", state: s.state };
    if (written !== "ok") return { ok: false, error: "invalid", fields: written };
    await tx.delete(contentDrafts).where(eq(contentDrafts.id, s.draft.id));
    return { ok: true, state: (await storedOf(tx, key)).state, published: true };
  });
  if (answer.ok && answer.published) {
    try {
      revalidatePublic({ kind: "settings", parts: [key] });
    } catch (e) {
      logFailure(`[legal] ${key}: revalidating after the publish failed`, e);
    }
  }
  if (!answer.ok) return answer;
  return { ok: true, state: answer.state };
}

/**
 * The count in the e-course contract's ConfirmPanel (ruling R-e): the distinct clients with an active e-course access now — not revoked, not expired,
 * as activeAccess (client-data.ts) reads one. The terms gate asks each of them again at their next opening of a course (R11); a client with two
 * courses is one student.
 */
export async function reacceptCount(q: Q, now: Date): Promise<number> {
  const [row] = await q
    .select({ n: sql<number>`count(distinct ${courseAccess.clientId})::int` })
    .from(courseAccess)
    .where(and(isNull(courseAccess.revokedAt), gt(courseAccess.expiresAt, now)));
  return Number(row?.n ?? 0);
}

/** The sample's text fields, by their form names. */
const SAMPLE_TEXTS = ["titleEt", "titleRu", "bodyEt", "bodyRu"] as const;

/**
 * The texts „Näidisleping (PDF)“ draws (ruling R-d: the draft when there is one): the card's own when it posts any (its screen: the draft as typed,
 * newer than the stored draft while a save waits), else the contact text's draft, else live's. `lang` is kept as posted.
 */
export async function sampleTexts(q: Q, posted: ContractSampleValues): Promise<ContractSampleValues> {
  if (SAMPLE_TEXTS.some((name) => posted[name] !== undefined)) return posted;
  const { value } = await readLegal(q, "contract_contact");
  return { ...posted, titleEt: value.title.et, titleRu: value.title.ru, bodyEt: value.body.et, bodyRu: value.body.ru };
}
