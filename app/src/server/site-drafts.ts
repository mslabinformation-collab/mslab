import { sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db, Q, Tx } from "@/db/client";
import { deletePostRow, insertPost, lockTables, readPost, updatePost, type SiteTable } from "@/db/queries/admin-site";
import type { SaveAnswer } from "@/domain/autosave";
import { missingCase, sameSiteValue, siteChangeLabels, siteFieldLabel } from "@/domain/site-changes";
import { MISSING_CODES } from "@/domain/site-checks";
import { fromEditorValue, isListPart, POST_PART, siteDraftLockKey, siteRowOf, toEditorValue, type SiteDraftEntity, type SitePartState, type SiteTarget } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { slugify } from "@/lib/slug";
import { contentVersion } from "@/lib/version";
import { homeParts, postParts, practiceParts, trainerParts, type Part, type Parts, type Write } from "./admin-site";
import { discardDrafts, draftVersion, finishDraftSave, publishDrafts, publishDraftsIn, readDrafts, SwitchRefused, type DraftPart, type Publisher } from "./drafts";
import { Check, type FieldError } from "./edit-check";
import { logFailure } from "./log";
import { revalidatePublic } from "./public-cache";
import { readStamp, stampOrNull } from "./read-stamp";

// The site content on the draft layer (admin UX pass piece 4a, Task 1; README B2, §1.8; rulings R-a … R-e): Avaleht ("home"), Koolitaja ("trainer")
// and Praktika ("practice"), each one `content_drafts` row (entity_id 0) whose parts are server/admin-site.ts' (domain/site-entities.ts). Their
// editors save one part at a time (POST /api/admin/sisu/<entity>/0/osa/<part>, server/autosave-route.ts' contract):
// - A save goes to the part's draft; live is left alone. It passes the part's schema (the types) and its LOOSE check (R-d, domain/site-checks.ts:
//   lengths, list caps, forms; nothing is required), so a new slide without its picture waits in the draft. Typed back to live, the draft goes.
// - „Avalda muudatused“ (publishSite) carries the screen's versions, every part's as the screen holds it after its flush (piece 4a final review I-1):
//   it writes every part whose draft is the one the screen sent and whose live value is still the one its draft began from, through the part's
//   STRICT check (Part.check, the old „Salvesta“'s) and the Write it answers, all in one transaction. A part that fails the check is held back with
//   its missing fields' labels (`Puudub: slaid 3 pilt`, S4-2); one whose draft another window saved after the screen read it (or one with a draft
//   the screen did not send), or whose live value changed meanwhile, is held back as changed; all keep their drafts, the others publish. The
//   public pages are revalidated once, after the commit.
// - „Loobu muudatustest“ (discardSite) deletes every draft of the entity (R-e); live stays as it is.
// - Versions (R-b), as server/course-parts.ts': "l:<hash>" while a part has no draft, the hash being lib/version.ts contentVersion of the part's
//   DRAFT-SHAPED live value (its editor value, never the stored row: a column outside the part, like the trainer setting's contactPhotoKey, never
//   blocks its draft); "d:<draft row id>.<n>" with one. The row's id keeps a new draft's versions apart from an ended one's.
// - Locks (R-c): a save and a discard take only the entity's advisory lock (`site-draft:<entity>:<id>`, a transaction lock), never a table lock: the
//   settings table also holds number series other writers lock. The publish takes the same advisory lock first, then every table of the entity's
//   parts at once (lockTables: EXCLUSIVE, in alphabetical order, as every site save locks them), before it reads a draft or a live value.
// Piece 4b (Task 1; rulings R-a, R-b, R-g, R-h) adds the posts: the entity "post" with the post's id (a SiteTarget `{ entity: "post", id }`; the three
// above are named by themselves, row 0), one part `post`. Its rules, beside the above:
// - A post that is not published saves straight to its row (Part.live, R-a): no draft and no bar. Its save takes the post's advisory lock, then the
//   posts table (as every post writer locks it), reads the row again under it, checks it as any save (schema, loose check) and its address against
//   the other posts (Part.rowCheck: `slugTaken`, held at the field), and writes the row. A draft left on such a post (by an earlier way of saving) is
//   neither shown nor saved; the switch on drops it.
// - A published post saves into its draft as the other parts do; „Avalda muudatused“ runs S4-Q1 A's strict check (Part.check), then the address
//   against the other posts: a taken one is held back as "invalid" with its code (`errors: { slug: "slugTaken" }`, ADM:2281).
// - „Avaldatud“ (switchPostPublished, R-b), „Lisa postitus +“ (createPost, S4-19) and „Kustuta postitus“ (deletePost, R-h): at the end of this file.
// No Next.js here but the revalidation (server/public-cache.ts, mocked in the tests): tests/db/site-drafts.test.ts and post-drafts.test.ts run it on
// PGlite.

export { isSiteEntity, parseSiteTarget, SITE_ENTITY_ID, siteRowOf, type SiteDraftEntity, type SiteEntity, type SitePartState, type SiteTarget } from "@/domain/site-entities";

/** A target's parts by name, in its screen's order: Praktika's are read from the packages; a post's is its one part, none when the post is gone. */
export async function partsOf(q: Q, target: SiteTarget): Promise<Parts> {
  if (target === "home") return homeParts;
  if (target === "trainer") return trainerParts;
  if (target === "practice") return practiceParts(q);
  return postParts(q, target.id);
}

/** Is `part` one of the target's parts (the routes' 404)? */
export async function hasSitePart(q: Q, target: SiteTarget, part: string): Promise<boolean> {
  return Object.hasOwn(await partsOf(q, target), part);
}

/** Is the target there (the publish and discard routes' 404): Avaleht, Koolitaja and Praktika always, a post while its row is. */
export async function siteTargetExists(q: Q, target: SiteTarget): Promise<boolean> {
  return typeof target === "string" || (await readPost(q, target.id)) !== null;
}

/** The target's advisory lock, first thing in every transaction that writes its drafts or publishes them (R-c): `site-draft:<entity>:<id>`. */
const lockEntity = (tx: Tx, target: SiteTarget) => {
  const { entity, id } = siteRowOf(target);
  return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${siteDraftLockKey(entity, id)}))`);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A part's live value as its editor holds it (its Part.draft of the stored value) and that value's hash (R-b). */
async function liveOf(entity: SiteDraftEntity, part: string, def: Part<unknown>, stored: unknown): Promise<{ live: Record<string, unknown>; hash: string }> {
  const live = toEditorValue(entity, part, def.draft(stored));
  return { live, hash: await contentVersion(live) };
}

/**
 * A stored draft's value read defensively (jsonb holds anything): its part's fields over live's, through the part's schema; live when it does not pass.
 */
function draftValueOf(entity: SiteDraftEntity, part: string, def: Part<unknown>, live: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  const own = isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter(([k]) => Object.hasOwn(live, k))) : {};
  const parsed = def.schema.safeParse(fromEditorValue(entity, part, { ...live, ...own }));
  return parsed.success ? toEditorValue(entity, part, parsed.data) : live;
}

/**
 * A part's draft as „Avalda muudatused“ takes it (R-d): its stored value `raw` read defensively over the live value of `stored` (draftValueOf), through
 * the part's STRICT check (Part.check). `value`: the editor value checked; `check`: what it refused; `write`: the Write it answered (null: refused). The
 * publish's hold and the admin's preview of the public pages (server/site-preview.ts, R-f) decide by it alike.
 */
export function strictDraft(entity: SiteDraftEntity, part: string, def: Part<unknown>, stored: unknown, raw: unknown): { value: Record<string, unknown>; check: Check; write: Write | null } {
  const value = draftValueOf(entity, part, def, toEditorValue(entity, part, def.draft(stored)), raw);
  const check = new Check();
  const write = def.check(check, fromEditorValue(entity, part, value), part);
  return { value, check, write };
}

/**
 * A part as a save, the editor's read and the publish's labels see it: live (and its hash), its draft, the version and the value the editor holds.
 * `direct`: the part's row saves straight (Part.live, R-a: a post that is not published), so a draft of it is not taken; `stored`: the stored value read.
 */
type PartState = { live: Record<string, unknown>; liveHash: string; draft: DraftPart | null; version: string; value: Record<string, unknown>; stored: unknown; direct: boolean };

async function partStateOf(q: Q, entity: SiteDraftEntity, part: string, def: Part<unknown>, drafts: DraftPart[]): Promise<PartState> {
  const stored = await def.read(q);
  const { live, hash } = await liveOf(entity, part, def, stored);
  const direct = def.live?.now(stored) ?? false;
  const draft = direct ? null : (drafts.find((d) => d.part === part) ?? null);
  if (!draft) return { live, liveHash: hash, draft: null, version: `l:${hash}`, value: live, stored, direct };
  return { live, liveHash: hash, draft, version: draftVersion(draft.id, draft.version), value: draftValueOf(entity, part, def, live, draft.value), stored, direct };
}

/**
 * The editor's start (Tasks 4–6; README B2): the read's stamp first (server/read-stamp.ts: a read at or past a press's answer shows what it did), then
 * every part of the target, each with its version (R-b), its value (the draft over live) and live's value beside it, in the screen's order. A post
 * that is not published has its row's value and version (R-a); a post that is gone, no part.
 */
export async function readSiteEditor(q: Q, target: SiteTarget): Promise<{ stamp: number; parts: Record<string, SitePartState> }> {
  const { entity, id } = siteRowOf(target);
  const stamp = await readStamp(q);
  const parts = await partsOf(q, target);
  const drafts = await readDrafts(q, entity, id);
  const out: Record<string, SitePartState> = {};
  for (const [part, def] of Object.entries(parts)) {
    const s = await partStateOf(q, entity, part, def, drafts);
    out[part] = { version: s.version, value: s.value, live: s.live };
  }
  return { stamp, parts: out };
}

// ---------- a save ----------

/** A check's field name (`<part>.<path>`, the strict check's; or a path already) → the path in the editor value (a list part's starts with its own name). */
function pathOf(entity: SiteDraftEntity, part: string, name: string): string {
  if (isListPart(entity, part)) return name;
  return name.startsWith(`${part}.`) ? name.slice(part.length + 1) : name;
}

/** The field of the editor value a path is in: a list part's one field (its own name), a record's first key. */
const fieldOf = (entity: SiteDraftEntity, part: string, path: string): string =>
  isListPart(entity, part) && (path === part || path.startsWith(`${part}.`)) ? part : path.split(".")[0];

/**
 * A refusal by field, for the autosave (server/autosave-route.ts): each path with its first code, and the field of the editor value it is in with
 * the first code of its paths (the screen holds back the fields named among those it sent; the paths say where in a list the error is). When none of
 * the fields `sent` is named (the problem is in a field the save did not carry: a stored value a limit refuses since), every field sent is named with
 * the first code, as course-parts.ts refusedFields does: the screen then holds them back and says so, instead of waiting with nothing held.
 */
function refusal(entity: SiteDraftEntity, part: string, problems: [path: string, code: string][], sent: string[]): SaveAnswer {
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
function issueOf(entity: SiteDraftEntity, part: string, issue: z.core.$ZodIssue): [string, string] {
  const name = [part, ...issue.path.map(String)].join(".");
  const code = issue.code === "too_big" ? (issue.origin === "array" ? "tooMany" : "tooLong") : "invalid";
  return [pathOf(entity, part, name), code];
}

/**
 * The rules of a value written straight into its part's row (Part.live; R-a, R-g), the one sequence for a save of a post that is not published
 * (writeSitePart) and for the drafts a post switched off takes into its row (the publisher's rule "row"): the part's loose check; then the value as
 * the row stores it (Part.live.follow: an address that follows its title, made again from the new title — only for a save that `sent` the title and
 * no address; null for a draft, which is taken whole); then the rules against the stored rows (Part.rowCheck). The value to write, or what refused
 * it, by path: "loose", the loose check; "row", Part.rowCheck (`slugTaken`).
 */
async function rowDecision(
  q: Q,
  def: Part<unknown>,
  value: unknown,
  stored: unknown,
  sent: readonly string[] | null,
): Promise<{ ok: true; value: unknown } | { ok: false; by: "loose" | "row"; problems: Record<string, FieldError> }> {
  const loose = (def.loose?.(value) ?? {}) as Record<string, FieldError>;
  if (Object.keys(loose).length > 0) return { ok: false, by: "loose", problems: loose };
  const followed = def.live?.follow ? await def.live.follow(q, value, stored, sent) : value;
  const refused = (await def.rowCheck?.(q, followed)) ?? {};
  if (Object.keys(refused).length > 0) return { ok: false, by: "row", problems: refused };
  return { ok: true, value: followed };
}

/**
 * An editor card's save (the autosave route's `write`; server/autosave-route.ts' contract): `patch` (some of the part's fields; another field is
 * refused) over the part's value at `version`, under the entity's advisory lock, into its draft. The answers: ok with the part's version after it; a
 * conflict with the stored version and value (another tab, a publish or a discard meanwhile; a part that is gone: version "", value null); invalid
 * by field: the part's schema (types), then its loose check (R-d: nothing required, so an incomplete row is kept). The same value again writes
 * nothing; typed back to live, the draft goes ("l:" again). Never a live row, never a table lock (R-c) — but for a part whose row saves straight
 * (Part.live, R-a: a post that is not published): its tables are locked after the advisory lock and it is read again under them, the row's rules
 * decide (rowDecision: the loose check, the address's follow of the title, Part.rowCheck; refused by field, `slugTaken`), and the row is written;
 * the answer is the row's new version "l:<hash>". `admin`: the admin's e-mail.
 */
export async function writeSitePart(db: Db, target: SiteTarget, part: string, patch: unknown, version: string, admin: string, now: Date): Promise<SaveAnswer> {
  const savedAt = now.toISOString();
  const { entity, id } = siteRowOf(target);
  return db.transaction(async (tx): Promise<SaveAnswer> => {
    await lockEntity(tx, target);
    const parts = await partsOf(tx, target);
    const def = Object.hasOwn(parts, part) ? parts[part] : undefined;
    if (!def) return { ok: false, error: "conflict", version: "", value: null };
    const stateNow = async () => partStateOf(tx, entity, part, def, await readDrafts(tx, entity, id, { only: [part] }));
    let s = await stateNow();
    if (s.direct) {
      // the row is written: its tables locked as its other writers lock them (after the advisory lock, as the publish), and the row read again
      await lockTables(tx, def.tables);
      s = await stateNow();
    }
    if (version !== s.version) return { ok: false, error: "conflict", version: s.version, value: s.value };
    const sent = isRecord(patch) ? patch : {};
    const names = Object.keys(sent);
    const unknown = names.filter((k) => !Object.hasOwn(s.live, k));
    if (unknown.length > 0) return refusal(entity, part, unknown.map((k) => [k, "invalid"]), names);
    const parsed = def.schema.safeParse(fromEditorValue(entity, part, { ...s.value, ...sent }));
    if (!parsed.success) return refusal(entity, part, parsed.error.issues.map((i) => issueOf(entity, part, i)), names);
    if (s.direct && def.live) {
      const decided = await rowDecision(tx, def, parsed.data, s.stored, names);
      if (!decided.ok) return refusal(entity, part, Object.entries(decided.problems), names);
      if (sameSiteValue(toEditorValue(entity, part, decided.value), s.value)) return { ok: true, version: s.version, savedAt };
      await def.live.write(tx, decided.value, s.stored);
      return { ok: true, version: `l:${(await liveOf(entity, part, def, await def.read(tx))).hash}`, savedAt };
    }
    const problems = Object.entries(def.loose?.(parsed.data) ?? {});
    if (problems.length > 0) return refusal(entity, part, problems, names);
    const value = toEditorValue(entity, part, parsed.data);
    if (sameSiteValue(value, s.value)) return { ok: true, version: s.version, savedAt };
    // typed back to what is live, the draft goes; else the draft is made or saved (server/drafts.ts finishDraftSave)
    return finishDraftSave(tx, {
      entity,
      entityId: id,
      part,
      value,
      liveHash: s.liveHash,
      draft: s.draft,
      sameAsLive: sameSiteValue(value, s.live),
      by: admin,
      savedAt,
      reread: stateNow,
    });
  });
}

// ---------- „Avalda muudatused“ ----------

/**
 * A part „Avalda muudatused“ left in its draft (S3-P3-b): "changed", its draft is not the one the screen sent (another window saved it after the
 * screen's read) or its live value changed after the draft began, `fields` the labels of the draft's changes; "missing", its strict check refused
 * it, `fields` the refused fields' labels as „Puudub: …“ writes them (S4-2: `slaid 3 pilt`); "invalid" (piece 4b, R-g), its value passed the strict
 * check but a rule against the stored rows refused it (Part.rowCheck: a post's address another post has), `fields` the refused fields' labels as the
 * bar names them (`Aadress`) and `errors` their codes by path (`{ slug: "slugTaken" }`: the editor says ADM:2281's text).
 */
export type SiteBlockedPart = { part: string; reason: "changed" | "missing" | "invalid"; fields: string[]; errors?: Record<string, FieldError> };

/**
 * A strict check's refusal of a package's point without its Estonian text names the list (Check.list "listEt": its first such row, not empty): the
 * row it means, as the label numbers it (`MAXI punkt 2`). Any other path as it is (the list's own problems are the list's: `MAXI punktid`).
 */
function rowOfList(entity: SiteDraftEntity, path: string, code: string, value: Record<string, unknown>): string {
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
function missingOf(entity: SiteDraftEntity, part: string, errors: Record<string, FieldError>, value: Record<string, unknown>): string[] {
  const entries = Object.entries(errors);
  const ordered = [...entries.filter(([, code]) => MISSING_CODES.includes(code)), ...entries.filter(([, code]) => !MISSING_CODES.includes(code))];
  const out: string[] = [];
  for (const [name, code] of ordered) {
    const label = missingCase(siteFieldLabel(entity, part, rowOfList(entity, pathOf(entity, part, name), code, value)));
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** A part held as "invalid" (Part.rowCheck refused its value): the refused fields' labels as the bar names them, once each, with their codes. */
function invalidOf(entity: SiteDraftEntity, part: string, errors: Record<string, FieldError>): Omit<SiteBlockedPart, "part"> {
  const fields: string[] = [];
  for (const path of Object.keys(errors)) {
    const label = siteFieldLabel(entity, part, path);
    if (!fields.includes(label)) fields.push(label);
  }
  return { reason: "invalid", fields, errors };
}

/** The public pages an entity's publish revalidates (server/cache-targets.ts): Koolitaja's by the parts written; a post's, the post pages. */
function revalidateEntity(entity: SiteDraftEntity, written: string[]): void {
  if (entity === "home") revalidatePublic({ kind: "home" });
  else if (entity === "trainer") revalidatePublic({ kind: "trainer", parts: written });
  else if (entity === "post") revalidatePublic({ kind: "posts" });
  else revalidatePublic({ kind: "practice" });
}

/**
 * S4-Q1 A's one decision on a part's value as it goes public, which the bar's „Avalda muudatused“ and a post's „Avaldatud“ switched on (R-b) both
 * run: `raw` (a draft's value; null: the stored value itself) over the stored value, through the part's strict check (strictDraft: Part.check), then
 * the rules against the stored rows (Part.rowCheck). The Write, or why the part is held: "missing" with the refused fields' labels as „Puudub: …“
 * lists them, or "invalid" with the codes (`slugTaken`).
 */
async function strictDecision(tx: Tx, entity: SiteDraftEntity, part: string, def: Part<unknown>, stored: unknown, raw: unknown): Promise<Write | Omit<SiteBlockedPart, "part">> {
  const { value: shown, check: c, write } = strictDraft(entity, part, def, stored, raw);
  if (!c.ok || !write) return { reason: "missing", fields: missingOf(entity, part, c.errors, shown) };
  const refused = (await def.rowCheck?.(tx, fromEditorValue(entity, part, shown))) ?? {};
  return Object.keys(refused).length > 0 ? invalidOf(entity, part, refused) : write;
}

/**
 * How a publish takes the drafts:
 * - `versions`: the screen's (review I-1: a draft at another version, or one the screen sent none for, is held as changed); null for a publish that
 *   takes the drafts as they are stored (a post's „Avaldatud“ switched off, R-b: no screen's bar is published, the pending drafts are kept);
 * - `rule`: "strict", each part's strict check (Part.check) and its Write, then Part.rowCheck (the bar's publish); "row" (a post switched off: a
 *   hidden post needs no cover or Russian text, as a course switched off needs no price), the save's own rules — the loose check and Part.rowCheck —
 *   and the row written as a save of a post that is not published writes it (Part.live).
 */
type PublishRules = { versions: Readonly<Record<string, string>> | null; rule: "strict" | "row" };

/**
 * The target's Publisher (server/drafts.ts) with what it decided:
 * - lock (R-c): the target's advisory lock, then every table of its parts at once (lockTables, alphabetical), before any draft is read;
 * - liveVersion: the hash of the part's draft-shaped live value (R-b), read under that lock (and kept for its write);
 * - hold: a part whose row saves straight (a post that is not published, R-a) keeps its draft unwritten and unnamed (ignored); each other part's draft
 *   against the screen's `versions` (when given): one that is newer than what the screen showed is held, and named as changed (blockedOf); then each
 *   other part's rules (`rule` above: strictDecision, or rowDecision) on its draft's value: a part they refuse is held as "missing" with its fields'
 *   labels (R-d, R-i), or as "invalid" with its codes (Part.rowCheck);
 * - write: the Write the rules answered, with the stored value read under the lock;
 * - revalidate: once, after the commit, the target's pages (Koolitaja's by the parts written).
 */
function makeSitePublisher(target: SiteTarget, o: PublishRules) {
  const { entity } = siteRowOf(target);
  let parts: Parts | null = null;
  const stored = new Map<string, unknown>();
  const writes = new Map<string, Write>();
  const held = new Map<string, Omit<SiteBlockedPart, "part">>();
  /** The parts whose draft is not the one the screen sent: changed (their labels are worked out after the commit, as a live change's). */
  const newer = new Set<string>();
  const written: string[] = [];
  const defOf = (part: string): Part<unknown> | undefined => (parts && Object.hasOwn(parts, part) ? parts[part] : undefined);
  /** The parts whose row saves straight (a post that is not published, R-a): their drafts are ignored — not written, not named, kept. */
  const ignored = new Set<string>();
  /** The row's rules on a draft (rule "row", rowDecision as a save to the row runs them): the Write into the row, or why it is held. */
  const rowRules = async (tx: Tx, part: string, def: Part<unknown>, raw: unknown): Promise<Write | Omit<SiteBlockedPart, "part">> => {
    const value = draftValueOf(entity, part, def, toEditorValue(entity, part, def.draft(stored.get(part))), raw);
    const decided = await rowDecision(tx, def, fromEditorValue(entity, part, value), stored.get(part), null);
    if (!decided.ok) return decided.by === "loose" ? { reason: "missing", fields: missingOf(entity, part, decided.problems, value) } : invalidOf(entity, part, decided.problems);
    const live = def.live;
    if (!live) throw new Error(`[site-drafts] ${entity} ${part} has no row of its own to save into`);
    return async (t: Tx, s: unknown) => live.write(t, decided.value, s);
  };
  const publisher: Publisher = {
    async lock(tx) {
      await lockEntity(tx, target);
      parts = await partsOf(tx, target);
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
    async hold(tx, candidates) {
      for (const { part, value: raw, id, version } of candidates) {
        const def = defOf(part);
        if (!def) continue;
        if (def.live?.now(stored.get(part))) {
          ignored.add(part);
          continue;
        }
        // (another window saved this draft after the screen read it, or the screen did not know of it: never published from a bar that did not show it)
        if (o.versions && (!Object.hasOwn(o.versions, part) || o.versions[part] !== draftVersion(id, version))) {
          newer.add(part);
          continue;
        }
        const decided = o.rule === "row" ? await rowRules(tx, part, def, raw) : await strictDecision(tx, entity, part, def, stored.get(part), raw);
        if (typeof decided === "function") writes.set(part, decided);
        else held.set(part, decided);
      }
      return [...held.keys(), ...newer, ...ignored];
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
 * The blocked parts with their reasons: the held ones as decided, the others changed meanwhile (live, or their draft by another window), with their
 * drafts' changes' labels row by row, as the PublishBar names them (domain/site-changes.ts siteChangeLabels: `Slaid 2 pealkiri`; read after the
 * publish). A part whose row saves straight (a post that is not published) is left out: its draft is ignored (R-a).
 */
async function blockedOf(db: Q, target: SiteTarget, names: string[], held: Map<string, Omit<SiteBlockedPart, "part">>): Promise<SiteBlockedPart[]> {
  if (names.length === 0) return [];
  const { entity, id } = siteRowOf(target);
  const parts = await partsOf(db, target);
  const drafts = await readDrafts(db, entity, id, { only: names });
  const out: SiteBlockedPart[] = [];
  for (const part of names) {
    const decided = held.get(part);
    if (decided) {
      out.push({ part, ...decided });
      continue;
    }
    const def = Object.hasOwn(parts, part) ? parts[part] : undefined;
    const s = def ? await partStateOf(db, entity, part, def, drafts) : null;
    if (s?.direct) continue;
    out.push({ part, reason: "changed", fields: s ? siteChangeLabels(entity, [{ part, live: s.live, draft: s.value }]) : [] });
  }
  return out;
}

/**
 * „Avalda muudatused“ of a target (R-c, R-d): its drafts with its Publisher, in ONE transaction (server/drafts.ts publishDrafts: the locks, every
 * part's live version against its draft's base, the drafts against `versions`, the strict checks, the writes); the pages revalidated once after the
 * commit when anything was published (a failure there is logged: the publish stands). `versions`: every part's version as the screen holds it after
 * its flush (its engine's confirmed version: "d:<id>.<n>", or "l:<hash>" for a part with no draft on the screen) — a part whose draft is another
 * is held back as changed (review I-1: the bar publishes what it showed, never a newer text another window saved). A post's draft goes through
 * S4-Q1 A's check, then its address against the other posts ("invalid", `slugTaken`). The answer: the parts written, those left in their drafts with
 * why, in the order their drafts were first saved, and the database's clock after the commit (`stamp`, server/read-stamp.ts, as the course's
 * publish answers it: null when it cannot be read, the editor then takes the next read). The site's writers store no time, so it takes none.
 */
export async function publishSite(
  db: Db,
  target: SiteTarget,
  versions: Readonly<Record<string, string>>,
): Promise<{ stamp: number | null; published: string[]; blocked: SiteBlockedPart[] }> {
  const { entity, id } = siteRowOf(target);
  const { publisher, held } = makeSitePublisher(target, { versions, rule: "strict" });
  const result = await publishDrafts(db, entity, id, publisher);
  const blocked = await blockedOf(db, target, result.blocked, held);
  return { stamp: await stampOrNull(db), published: result.published, blocked };
}

// ---------- „Loobu muudatustest“ ----------

/**
 * „Loobu muudatustest“ (R-e): every draft of the target deleted under its advisory lock; live stays as it is, so nothing is revalidated. `stamp`: the
 * database's clock after the commit, null when it cannot be read (as the course's discard answers it).
 */
export async function discardSite(db: Db, target: SiteTarget): Promise<{ stamp: number | null }> {
  const { entity, id } = siteRowOf(target);
  await db.transaction(async (tx) => {
    await lockEntity(tx, target);
    await discardDrafts(tx, entity, id);
  });
  return { stamp: await stampOrNull(db) };
}

// ---------- Uudised: „Lisa postitus +“, „Avaldatud“ and „Kustuta postitus“ (piece 4b, Task 1) ----------

const postTarget = (id: number): SiteTarget => ({ entity: "post", id });

/** The post pages revalidated (/uudised with each post's page, the home page's carousel: server/cache-targets.ts "posts"); a failure is logged, the change stands. */
function revalidatePosts(what: string): void {
  try {
    revalidatePublic({ kind: "posts" });
  } catch (e) {
    logFailure(`[site-drafts] ${what}: revalidating the post pages failed`, e);
  }
}

/**
 * „Lisa postitus +“ (S4-19, R-g): a post made at once, not published, titled „Uus postitus“ (adminEt.post.newTitle) with no category, text or cover,
 * dated `now`. Its address is its title's (`uus-postitus`), or the series' first free one (`uus-postitus-2`, `uus-postitus-3` …), found and inserted
 * under the posts table's lock (db/queries/admin-site.ts insertPost): two presses at once, or two tabs, make two posts with two addresses, never a
 * unique-index error. Nothing public changes, so nothing is revalidated.
 */
export async function createPost(db: Db, now: Date): Promise<{ id: number; slug: string }> {
  const title = adminEt.post.newTitle;
  const row = await db.transaction(async (tx) => {
    await lockTables(tx, ["posts"]);
    return insertPost(tx, { slug: slugify(title), title: { et: title }, excerpt: { et: "" }, body: { et: "" }, category: { et: "" }, coverKey: "", publishedAt: now, published: false });
  });
  return { id: row.id, slug: row.slug };
}

/**
 * „Avaldatud“'s answer (R-b): done (also when the post was so already), with the database's clock after the commit (null when it cannot be read);
 * refused on: `missing`, S4-Q1 A's fields the post lacks, as „Puudub: …“ lists them (S4-22: `kaanepilt, tekst, pealkiri (RU), tekst (RU)`), or
 * `blocked` with the address another post has ("invalid", `slugTaken`); refused off: `blocked`, a pending draft that could not be published first
 * ("changed" meanwhile, "invalid"); notFound for a post that is not there.
 */
export type PostSwitchResult =
  | { ok: true; stamp: number | null }
  | { ok: false; error: "notFound" }
  | { ok: false; missing: string[] }
  | { ok: false; blocked: SiteBlockedPart[] };

/**
 * A post's „Avaldatud“, instant (R-b), under the post's advisory lock, then the posts table (the lock order of its saves and its publish):
 * - ON, for a post that is not published: the post's publish, by the bar's own decision (strictDecision: S4-Q1 A's strict check — the cover, the
 *   title and the text in Estonian and Russian, the category, the address's form and the day — then the address against the other posts) on the
 *   row's value; then it is written trimmed with `published` true, and a draft an earlier way of saving left on it is dropped (R-a: such a post's
 *   drafts are ignored, so it never takes effect). Refused ("missing" → `missing`, "invalid" → `blocked`), nothing is written.
 * - OFF, on a published post: its pending drafts are published first in the same transaction, by the save's own rules (rowDecision: a hidden post
 *   needs no cover or Russian text), then `published` is false; a draft that cannot be published (changed meanwhile, its address taken) refuses the
 *   switch, and nothing is published or hidden (3a's switchCoursePublished rule, with its SwitchRefused) — the drafts are never lost.
 * The post pages are revalidated once after a change. `now`: the request's time, as the course's switch takes it (a post stores no time of change).
 */
export async function switchPostPublished(db: Db, id: number, on: boolean, now: Date): Promise<PostSwitchResult> {
  void now;
  const target = postTarget(id);
  if (on) {
    const done = await db.transaction(async (tx): Promise<PostSwitchResult | "same" | "changed"> => {
      await lockEntity(tx, target);
      await lockTables(tx, ["posts"]);
      const stored = await readPost(tx, id);
      if (!stored) return { ok: false, error: "notFound" };
      if (stored.published) return "same";
      const def: Part<unknown> = (await partsOf(tx, target))[POST_PART];
      const decided = await strictDecision(tx, "post", POST_PART, def, stored, null);
      if (typeof decided !== "function") return decided.reason === "invalid" ? { ok: false, blocked: [{ part: POST_PART, ...decided }] } : { ok: false, missing: decided.fields };
      await decided(tx, stored);
      await updatePost(tx, id, { published: true });
      await discardDrafts(tx, "post", id);
      return "changed";
    });
    if (done === "changed") revalidatePosts(`post ${id} switched on`);
    return done === "same" || done === "changed" ? { ok: true, stamp: await stampOrNull(db) } : done;
  }
  const { publisher, held } = makeSitePublisher(target, { versions: null, rule: "row" });
  try {
    const done = await db.transaction(async (tx): Promise<"notFound" | "same" | "changed"> => {
      await lockEntity(tx, target);
      await lockTables(tx, ["posts"]);
      const stored = await readPost(tx, id);
      if (!stored) return "notFound";
      if (!stored.published) return "same";
      const { blocked } = await publishDraftsIn(tx, "post", id, publisher);
      if (blocked.length > 0) throw new SwitchRefused(blocked); // the transaction takes the published drafts back
      await updatePost(tx, id, { published: false });
      return "changed";
    });
    if (done === "notFound") return { ok: false, error: "notFound" };
    if (done === "changed") revalidatePosts(`post ${id} switched off`);
    return { ok: true, stamp: await stampOrNull(db) };
  } catch (e) {
    if (e instanceof SwitchRefused) return { ok: false, blocked: await blockedOf(db, target, e.blocked, held) };
    throw e;
  }
}

/**
 * „Kustuta postitus“ (R-h; the new editor's route and the old editor's form alike): the post and its drafts deleted in one transaction, under the
 * post's advisory lock and then the posts table (the lock order of its saves, publish and switch: no save writes a draft of a post that is going);
 * the post pages revalidated when it was published. False when there was no such post.
 */
export async function deletePost(db: Db, id: number): Promise<boolean> {
  const row = await db.transaction(async (tx) => {
    await lockEntity(tx, postTarget(id));
    await lockTables(tx, ["posts"]);
    await discardDrafts(tx, "post", id);
    return deletePostRow(tx, id);
  });
  if (row?.published) revalidatePosts(`post ${id} deleted`);
  return row !== null;
}
