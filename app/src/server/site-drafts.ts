import { sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db, Q, Tx } from "@/db/client";
import { lockTables, type SiteTable } from "@/db/queries/admin-site";
import type { SaveAnswer } from "@/domain/autosave";
import { missingCase, sameSiteValue, siteChangeLabels, siteFieldLabel } from "@/domain/site-changes";
import { MISSING_CODES } from "@/domain/site-checks";
import { fromEditorValue, isListPart, SITE_ENTITY_ID, toEditorValue, type SiteEntity, type SitePartState } from "@/domain/site-entities";
import { contentVersion } from "@/lib/version";
import { homeParts, practiceParts, trainerParts, type Part, type Parts, type Write } from "./admin-site";
import { discardDrafts, draftVersion, finishDraftSave, publishDrafts, readDrafts, type DraftPart, type Publisher } from "./drafts";
import { Check, type FieldError } from "./edit-check";
import { revalidatePublic } from "./public-cache";
import { readStamp, stampOrNull } from "./read-stamp";

// The site content on the draft layer (admin UX pass piece 4a, Task 1; README B2, §1.8; rulings R-a … R-e): Avaleht ("home"), Koolitaja ("trainer")
// and Praktika ("practice"), each one `content_drafts` row (entity_id 0) whose parts are server/admin-site.ts' (domain/site-entities.ts). Their
// editors save one part at a time (POST /api/admin/sisu/<entity>/0/osa/<part>, server/autosave-route.ts' contract):
// - A save goes to the part's draft; live is left alone. It passes the part's schema (the types) and its LOOSE check (R-d, domain/site-checks.ts:
//   lengths, list caps, forms; nothing is required), so a new slide without its picture waits in the draft. Typed back to live, the draft goes.
// - „Avalda muudatused“ (publishSite) writes every part whose live value is still the one its draft began from, through the part's STRICT check
//   (Part.check, the old „Salvesta“'s) and the Write it answers, all in one transaction. A part that fails the check is held back with its missing
//   fields' labels (`Puudub: slaid 3 pilt`, S4-2), one changed live meanwhile is held back as changed; both keep their drafts, the others publish.
//   The public pages are revalidated once, after the commit.
// - „Loobu muudatustest“ (discardSite) deletes every draft of the entity (R-e); live stays as it is.
// - Versions (R-b), as server/course-parts.ts': "l:<hash>" while a part has no draft, the hash being lib/version.ts contentVersion of the part's
//   DRAFT-SHAPED live value (its editor value, never the stored row: a column outside the part, like the trainer setting's contactPhotoKey, never
//   blocks its draft); "d:<draft row id>.<n>" with one. The row's id keeps a new draft's versions apart from an ended one's.
// - Locks (R-c): a save and a discard take only the entity's advisory lock (`site-draft:<entity>:0`, a transaction lock), never a table lock: the
//   settings table also holds number series other writers lock. The publish takes the same advisory lock first, then every table of the entity's
//   parts at once (lockTables: EXCLUSIVE, in alphabetical order, as every site save locks them), before it reads a draft or a live value.
// No Next.js here but the revalidation (server/public-cache.ts, mocked in the tests): tests/db/site-drafts.test.ts runs it on PGlite.

export { isSiteEntity, SITE_ENTITY_ID, type SiteEntity, type SitePartState } from "@/domain/site-entities";

/** An entity's parts by name, in its screen's order: Praktika's are read from the packages. */
export async function partsOf(q: Q, entity: SiteEntity): Promise<Parts> {
  if (entity === "home") return homeParts;
  if (entity === "trainer") return trainerParts;
  return practiceParts(q);
}

/** Is `part` one of the entity's parts (the routes' 404)? */
export async function hasSitePart(q: Q, entity: SiteEntity, part: string): Promise<boolean> {
  return Object.hasOwn(await partsOf(q, entity), part);
}

/** The entity's advisory lock, first thing in every transaction that writes its drafts or publishes them (R-c). */
const lockEntity = (tx: Tx, entity: SiteEntity) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`site-draft:${entity}:${SITE_ENTITY_ID}`}))`);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A part's live value as its editor holds it (its Part.draft of the stored value) and that value's hash (R-b). */
async function liveOf(entity: SiteEntity, part: string, def: Part<unknown>, stored: unknown): Promise<{ live: Record<string, unknown>; hash: string }> {
  const live = toEditorValue(entity, part, def.draft(stored));
  return { live, hash: await contentVersion(live) };
}

/**
 * A stored draft's value read defensively (jsonb holds anything): its part's fields over live's, through the part's schema; live when it does not pass.
 */
function draftValueOf(entity: SiteEntity, part: string, def: Part<unknown>, live: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  const own = isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter(([k]) => Object.hasOwn(live, k))) : {};
  const parsed = def.schema.safeParse(fromEditorValue(entity, part, { ...live, ...own }));
  return parsed.success ? toEditorValue(entity, part, parsed.data) : live;
}

/**
 * A part's draft as „Avalda muudatused“ takes it (R-d): its stored value `raw` read defensively over the live value of `stored` (draftValueOf), through
 * the part's STRICT check (Part.check). `value`: the editor value checked; `check`: what it refused; `write`: the Write it answered (null: refused). The
 * publish's hold and the admin's preview of the public pages (server/site-preview.ts, R-f) decide by it alike.
 */
export function strictDraft(entity: SiteEntity, part: string, def: Part<unknown>, stored: unknown, raw: unknown): { value: Record<string, unknown>; check: Check; write: Write | null } {
  const value = draftValueOf(entity, part, def, toEditorValue(entity, part, def.draft(stored)), raw);
  const check = new Check();
  const write = def.check(check, fromEditorValue(entity, part, value), part);
  return { value, check, write };
}

type PartState = { live: Record<string, unknown>; liveHash: string; draft: DraftPart | null; version: string; value: Record<string, unknown> };

async function partStateOf(q: Q, entity: SiteEntity, part: string, def: Part<unknown>, drafts: DraftPart[]): Promise<PartState> {
  const { live, hash } = await liveOf(entity, part, def, await def.read(q));
  const draft = drafts.find((d) => d.part === part) ?? null;
  if (!draft) return { live, liveHash: hash, draft: null, version: `l:${hash}`, value: live };
  return { live, liveHash: hash, draft, version: draftVersion(draft.id, draft.version), value: draftValueOf(entity, part, def, live, draft.value) };
}

/**
 * The editor's start (Tasks 4–6; README B2): the read's stamp first (server/read-stamp.ts: a read at or past a press's answer shows what it did), then
 * every part of the entity, each with its version (R-b), its value (the draft over live) and live's value beside it, in the screen's order.
 */
export async function readSiteEditor(q: Q, entity: SiteEntity): Promise<{ stamp: number; parts: Record<string, SitePartState> }> {
  const stamp = await readStamp(q);
  const parts = await partsOf(q, entity);
  const drafts = await readDrafts(q, entity, SITE_ENTITY_ID);
  const out: Record<string, SitePartState> = {};
  for (const [part, def] of Object.entries(parts)) {
    const s = await partStateOf(q, entity, part, def, drafts);
    out[part] = { version: s.version, value: s.value, live: s.live };
  }
  return { stamp, parts: out };
}

// ---------- a save ----------

/** A check's field name (`<part>.<path>`, the strict check's; or a path already) → the path in the editor value (a list part's starts with its own name). */
function pathOf(entity: SiteEntity, part: string, name: string): string {
  if (isListPart(entity, part)) return name;
  return name.startsWith(`${part}.`) ? name.slice(part.length + 1) : name;
}

/** The field of the editor value a path is in: a list part's one field (its own name), a record's first key. */
const fieldOf = (entity: SiteEntity, part: string, path: string): string =>
  isListPart(entity, part) && (path === part || path.startsWith(`${part}.`)) ? part : path.split(".")[0];

/**
 * A refusal by field, for the autosave (server/autosave-route.ts): each path with its first code, and the field of the editor value it is in with
 * the first code of its paths (the screen holds back the fields named among those it sent; the paths say where in a list the error is). When none of
 * the fields `sent` is named (the problem is in a field the save did not carry: a stored value a limit refuses since), every field sent is named with
 * the first code, as course-parts.ts refusedFields does: the screen then holds them back and says so, instead of waiting with nothing held.
 */
function refusal(entity: SiteEntity, part: string, problems: [path: string, code: string][], sent: string[]): SaveAnswer {
  const fields: Record<string, string> = {};
  for (const [path, code] of problems) {
    fields[path] ??= code;
    fields[fieldOf(entity, part, path)] ??= code;
  }
  const first = problems[0]?.[1] ?? "invalid";
  if (!sent.some((n) => Object.hasOwn(fields, n))) for (const n of sent) fields[n] ??= first;
  return { ok: false, error: "invalid", fields };
}

/** A schema's issue as a path and a code: over its length or its list's cap, or of the wrong type. */
function issueOf(entity: SiteEntity, part: string, issue: z.core.$ZodIssue): [string, string] {
  const name = [part, ...issue.path.map(String)].join(".");
  const code = issue.code === "too_big" ? (issue.origin === "array" ? "tooMany" : "tooLong") : "invalid";
  return [pathOf(entity, part, name), code];
}

/**
 * An editor card's save (the autosave route's `write`; server/autosave-route.ts' contract): `patch` (some of the part's fields; another field is
 * refused) over the part's value at `version`, under the entity's advisory lock, into its draft. The answers: ok with the part's version after it; a
 * conflict with the stored version and value (another tab, a publish or a discard meanwhile; a part that is gone: version "", value null); invalid
 * by field: the part's schema (types), then its loose check (R-d: nothing required, so an incomplete row is kept). The same value again writes
 * nothing; typed back to live, the draft goes ("l:" again). Never a live row, never a table lock (R-c). `admin`: the admin's e-mail.
 */
export async function writeSitePart(db: Db, entity: SiteEntity, part: string, patch: unknown, version: string, admin: string, now: Date): Promise<SaveAnswer> {
  const savedAt = now.toISOString();
  return db.transaction(async (tx): Promise<SaveAnswer> => {
    await lockEntity(tx, entity);
    const parts = await partsOf(tx, entity);
    const def = Object.hasOwn(parts, part) ? parts[part] : undefined;
    if (!def) return { ok: false, error: "conflict", version: "", value: null };
    const s = await partStateOf(tx, entity, part, def, await readDrafts(tx, entity, SITE_ENTITY_ID, { only: [part] }));
    if (version !== s.version) return { ok: false, error: "conflict", version: s.version, value: s.value };
    const sent = isRecord(patch) ? patch : {};
    const names = Object.keys(sent);
    const unknown = names.filter((k) => !Object.hasOwn(s.live, k));
    if (unknown.length > 0) return refusal(entity, part, unknown.map((k) => [k, "invalid"]), names);
    const parsed = def.schema.safeParse(fromEditorValue(entity, part, { ...s.value, ...sent }));
    if (!parsed.success) return refusal(entity, part, parsed.error.issues.map((i) => issueOf(entity, part, i)), names);
    const problems = Object.entries(def.loose?.(parsed.data) ?? {});
    if (problems.length > 0) return refusal(entity, part, problems, names);
    const value = toEditorValue(entity, part, parsed.data);
    if (sameSiteValue(value, s.value)) return { ok: true, version: s.version, savedAt };
    // typed back to what is live, the draft goes; else the draft is made or saved (server/drafts.ts finishDraftSave)
    return finishDraftSave(tx, {
      entity,
      entityId: SITE_ENTITY_ID,
      part,
      value,
      liveHash: s.liveHash,
      draft: s.draft,
      sameAsLive: sameSiteValue(value, s.live),
      by: admin,
      savedAt,
      reread: async () => partStateOf(tx, entity, part, def, await readDrafts(tx, entity, SITE_ENTITY_ID, { only: [part] })),
    });
  });
}

// ---------- „Avalda muudatused“ ----------

/**
 * A part „Avalda muudatused“ left in its draft (S3-P3-b): "changed", its live value changed after the draft began, `fields` the labels of the
 * draft's changes; "missing", its strict check refused it, `fields` the refused fields' labels as „Puudub: …“ writes them (S4-2: `slaid 3 pilt`).
 */
export type SiteBlockedPart = { part: string; reason: "changed" | "missing"; fields: string[] };

/**
 * A strict check's refusal of a package's point without its Estonian text names the list (Check.list "listEt": its first such row, not empty): the
 * row it means, as the label numbers it (`MAXI punkt 2`). Any other path as it is (the list's own problems are the list's: `MAXI punktid`).
 */
function rowOfList(entity: SiteEntity, path: string, code: string, value: Record<string, unknown>): string {
  if (entity !== "practice" || path !== "items" || code !== "listEt" || !Array.isArray(value.items)) return path;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const i = (value.items as { et?: unknown; ru?: unknown }[]).findIndex((item) => isRecord(item) && !text(item.et) && text(item.ru) !== "");
  return i < 0 ? path : `items.${i}`;
}

/**
 * The labels of a strict check's refused fields, as „Puudub: …“ lists them (S4-2), once each: the missing ones (MISSING_CODES) in the check's order,
 * then any other refusal. Those others cannot come from a draft the loose check let through, since it runs the same Check rules without `required`
 * (domain/site-checks.ts); one saved before a rule was tightened still holds its part back, named by its field.
 */
function missingOf(entity: SiteEntity, part: string, errors: Record<string, FieldError>, value: Record<string, unknown>): string[] {
  const entries = Object.entries(errors);
  const ordered = [...entries.filter(([, code]) => MISSING_CODES.includes(code)), ...entries.filter(([, code]) => !MISSING_CODES.includes(code))];
  const out: string[] = [];
  for (const [name, code] of ordered) {
    const label = missingCase(siteFieldLabel(entity, part, rowOfList(entity, pathOf(entity, part, name), code, value)));
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** The public pages an entity's publish revalidates (server/cache-targets.ts): Koolitaja's by the parts written. */
function revalidateEntity(entity: SiteEntity, written: string[]): void {
  if (entity === "home") revalidatePublic({ kind: "home" });
  else if (entity === "trainer") revalidatePublic({ kind: "trainer", parts: written });
  else revalidatePublic({ kind: "practice" });
}

/**
 * The entity's Publisher (server/drafts.ts) with what it decided:
 * - lock (R-c): the entity's advisory lock, then every table of its parts at once (lockTables, alphabetical), before any draft is read;
 * - liveVersion: the hash of the part's draft-shaped live value (R-b), read under that lock (and kept for its write);
 * - hold: each part's strict check (Part.check) on its draft's value; a part it refuses is held as "missing" with its fields' labels (R-d, R-i);
 * - write: the Write the check answered, with the stored value read under the lock;
 * - revalidate: once, after the commit, the entity's pages (Koolitaja's by the parts written).
 */
function makeSitePublisher(entity: SiteEntity) {
  let parts: Parts | null = null;
  const stored = new Map<string, unknown>();
  const writes = new Map<string, Write>();
  const held = new Map<string, Omit<SiteBlockedPart, "part">>();
  const written: string[] = [];
  const defOf = (part: string): Part<unknown> | undefined => (parts && Object.hasOwn(parts, part) ? parts[part] : undefined);
  const publisher: Publisher = {
    async lock(tx) {
      await lockEntity(tx, entity);
      parts = await partsOf(tx, entity);
      const tables = new Set<SiteTable>(Object.values(parts).flatMap((p) => p.tables));
      await lockTables(tx, tables);
    },
    // (a part this entity no longer has, a package deleted meanwhile, never matches: its draft stays)
    async liveVersion(tx, part) {
      const def = defOf(part);
      if (!def) return "";
      const value = await def.read(tx);
      stored.set(part, value);
      return (await liveOf(entity, part, def, value)).hash;
    },
    async hold(_tx, candidates) {
      for (const { part, value: raw } of candidates) {
        const def = defOf(part);
        if (!def) continue;
        const { value: shown, check: c, write } = strictDraft(entity, part, def, stored.get(part), raw);
        if (c.ok && write) writes.set(part, write);
        else held.set(part, { reason: "missing", fields: missingOf(entity, part, c.errors, shown) });
      }
      return [...held.keys()];
    },
    async write(tx, part) {
      const write = writes.get(part);
      if (!write) throw new Error(`[site-drafts] ${entity} ${part} was not checked before its write`);
      await write(tx, stored.get(part));
      written.push(part);
    },
    revalidate: () => revalidateEntity(entity, written),
  };
  return { publisher, held };
}

/**
 * The blocked parts with their reasons: the held ones as decided, the others changed meanwhile, with their drafts' changes' labels row by row, as the
 * PublishBar names them (domain/site-changes.ts siteChangeLabels: `Slaid 2 pealkiri`; read after the publish).
 */
async function blockedOf(db: Q, entity: SiteEntity, names: string[], held: Map<string, Omit<SiteBlockedPart, "part">>): Promise<SiteBlockedPart[]> {
  if (names.length === 0) return [];
  const parts = await partsOf(db, entity);
  const drafts = await readDrafts(db, entity, SITE_ENTITY_ID, { only: names });
  const out: SiteBlockedPart[] = [];
  for (const part of names) {
    const decided = held.get(part);
    if (decided) {
      out.push({ part, ...decided });
      continue;
    }
    const def = Object.hasOwn(parts, part) ? parts[part] : undefined;
    const s = def ? await partStateOf(db, entity, part, def, drafts) : null;
    out.push({ part, reason: "changed", fields: s ? siteChangeLabels(entity, [{ part, live: s.live, draft: s.value }]) : [] });
  }
  return out;
}

/**
 * „Avalda muudatused“ of an entity (R-c, R-d): its drafts with its Publisher, in ONE transaction (server/drafts.ts publishDrafts: the locks, every
 * part's live version against its draft's base, the strict checks, the writes); the pages revalidated once after the commit when anything was
 * published (a failure there is logged: the publish stands). The answer: the parts written, those left in their drafts with why, in the order
 * their drafts were first saved, and the database's clock after the commit (`stamp`, server/read-stamp.ts, as the course's publish answers it: null
 * when it cannot be read, the editor then takes the next read). The site's writers store no time, so it takes none.
 */
export async function publishSite(db: Db, entity: SiteEntity): Promise<{ stamp: number | null; published: string[]; blocked: SiteBlockedPart[] }> {
  const { publisher, held } = makeSitePublisher(entity);
  const result = await publishDrafts(db, entity, SITE_ENTITY_ID, publisher);
  const blocked = await blockedOf(db, entity, result.blocked, held);
  return { stamp: await stampOrNull(db), published: result.published, blocked };
}

// ---------- „Loobu muudatustest“ ----------

/**
 * „Loobu muudatustest“ (R-e): every draft of the entity deleted under its advisory lock; live stays as it is, so nothing is revalidated. `stamp`: the
 * database's clock after the commit, null when it cannot be read (as the course's discard answers it).
 */
export async function discardSite(db: Db, entity: SiteEntity): Promise<{ stamp: number | null }> {
  await db.transaction(async (tx) => {
    await lockEntity(tx, entity);
    await discardDrafts(tx, entity, SITE_ENTITY_ID);
  });
  return { stamp: await stampOrNull(db) };
}
