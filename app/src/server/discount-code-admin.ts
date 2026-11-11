import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Q, Tx } from "@/db/client";
import { attemptEnds } from "@/db/queries/payments";
import { dbErrorCode } from "@/db/safe-error";
import { lockForPayment } from "@/db/queries/seats";
import { courses, discountCodeCourses, discountCodes, discountRedemptions, invoices, registrations, type Course, type Registration } from "@/db/schema";
import type { SaveAnswer } from "@/domain/autosave";
import { tallinnToday } from "@/domain/client-access";
import {
  CEILING_FIELDS,
  changedCodeFields,
  codeColumns,
  codeFieldProblems,
  CODE_FIELDS,
  highestListCents,
  type CodeFields,
} from "@/domain/discount-code-fields";
import { codeState, codeValueText, discountCents, listCentsOf, normalizeCode, registrationListCents, useMark, type CodeScope, type CodeState, type UseMark } from "@/domain/discount-codes";
import { normalizeEmail } from "@/domain/email";
import { centsToInput } from "@/domain/money";
import { pick } from "@/i18n/field";
import { ROW_ID_MAX } from "@/lib/row-id";
import { toStorable } from "@/lib/to-storable";
import { contentVersion } from "@/lib/version";
import { fieldCodes, refusedFields } from "./autosave-route";
import { countingUse, findCode, insertRedemption, lockCode, ruleOf, useJoins, type StoredCode } from "./discount-codes";
import { revalidatePublic } from "./public-cache";

// The Sooduskoodid page's server side (F1 Task 13, spec §4.10; R9, R16–R20). The drawer:
// - autosaves its fields (domain/discount-code-fields.ts CODE_FIELDS) on POST /api/admin/sooduskood/<id> (server/autosave-route.ts' contract): writeCode;
// - creates a new code only with the explicit „Lisa sooduskood“: createCode, which answers the id (the drawer goes on at ?kood=<id>);
// - pauses and resumes with an instant action (the switch „Aktiivne“, UndoBar „Sooduskood peatatud.“): setCodeActive;
// - deletes a code that has no uses at all: deleteCode;
// - lists the code's uses: codeUses.
// The version is "k:" and lib/version.ts contentVersion of the stored fields, the chosen courses and the switch (as a session's, R-a: a switch pressed in
// another tab is a conflict for the fields too). Lock order (spec D8): every write takes the code's row lock first (discount-codes.ts lockCode, `for no
// key update`, the same lock every use is written under) and never a purchase or session advisory lock after it. R16: a write is checked over the stored
// row merged with the patch, never the patch alone, by domain/discount-code-fields.ts codeFieldProblems. The welcome row (R9, R11) is the one row with
// `welcome`: a change to it (any field, the switch, its create or its delete) also revalidates every public page (`{ kind: "welcomeCode" }`), another
// code's change none. No Next.js here but the public pages' revalidation (server/public-cache.ts, mocked in tests/db/discount-code-admin.test.ts).

// ---------- the list ----------

/** One row of the list: the value as „10%“ / „15 €“ (the page puts the „−“ before it), the days as stored, the uses that count and where the code stands. */
export type CodeListRow = {
  id: number;
  code: string;
  welcome: boolean;
  value: string;
  scope: CodeScope;
  /** The chosen courses (scope `courses`; 0 otherwise). */
  courses: number;
  startsOn: string | null;
  endsOn: string | null;
  uses: number;
  maxUses: number | null;
  state: CodeState;
};

// (postgres-js answers an array, PGlite {rows}.)
const rowsOf = (result: unknown): Record<string, unknown>[] => (Array.isArray(result) ? result : ((result as { rows?: Record<string, unknown>[] }).rows ?? []));

/** The list (the page): the welcome code first, then the newest; `uses` are the ones that count at `now` (discount-codes.ts countingUse), `state` follows them. */
export async function listCodes(q: Q, now: Date): Promise<CodeListRow[]> {
  const rows = await q.select().from(discountCodes).orderBy(desc(discountCodes.welcome), desc(discountCodes.createdAt), desc(discountCodes.id));
  if (rows.length === 0) return [];
  const chosen = await q
    .select({ codeId: discountCodeCourses.codeId, n: sql<number>`count(*)::int` })
    .from(discountCodeCourses)
    .groupBy(discountCodeCourses.codeId);
  const counted = rowsOf(await q.execute(sql`select d.code_id as code_id, count(*)::int as n from ${useJoins} where ${countingUse(now)} group by d.code_id`));
  const usesOf = new Map(counted.map((r) => [Number(r.code_id), Number(r.n)]));
  const today = tallinnToday(now);
  return rows.map((row) => {
    const uses = usesOf.get(row.id) ?? 0;
    return {
      id: row.id,
      code: row.code,
      welcome: row.welcome,
      value: codeValueText(row),
      scope: row.scope,
      courses: row.scope === "courses" ? (chosen.find((c) => c.codeId === row.id)?.n ?? 0) : 0,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      uses,
      maxUses: row.maxUses,
      state: codeState(ruleOf({ ...row, courseIds: [] }), today, uses),
    };
  });
}

/** A course the drawer can choose, and the price a euro amount is held under (R18): its title (Estonian), kind, whether it is public, its list price. */
/**
 * The texts of the codes that are on and inside their dates today (Tallinn), the welcome code included: what the newsletter editor checks its „Kood“
 * against (D13). Uses, limits and scope are not looked at: the editor's warning only says „no such active code“, a full code is still a code Maria made.
 */
export async function activeCodeTexts(q: Q, now: Date): Promise<string[]> {
  const today = tallinnToday(now);
  const rows = await q.select().from(discountCodes).where(eq(discountCodes.active, true));
  return rows.filter((row) => codeState(ruleOf({ ...row, courseIds: [] }), today, 0) === "active").map((row) => row.code);
}

export type CodeCourse = { id: number; title: string; type: "e_learning" | "contact"; published: boolean; listCents: number | null };

/** Every course for the checklist, contact courses and e-courses, by their place in the catalogue. */
export async function listCodeCourses(q: Q): Promise<CodeCourse[]> {
  const rows = await q.select().from(courses).orderBy(courses.sort, courses.id);
  return rows.map((c) => ({ id: c.id, title: pick(c.title, "et"), type: c.type, published: c.published, listCents: listCentsOf(c) }));
}

// ---------- the fields' shapes ----------

/**
 * The fields as typed, the outer limits (the real ones are domain/discount-code-fields.ts codeFieldProblems, with their codes): each refusal is its
 * field's code. The text without what Postgres cannot store (lib/to-storable.ts).
 */
const shape = {
  code: z.string({ error: "codeFormat" }).max(200, "codeFormat").transform(toStorable),
  kind: z.enum(["percent", "euro"], { error: "invalid" }),
  percent: z.string({ error: "whole" }).max(40, "whole"),
  amount: z.string({ error: "amountEuro" }).max(40, "amountEuro"),
  scope: z.enum(["all", "ecourse", "contact", "courses"], { error: "invalid" }),
  courseIds: z.array(z.number({ error: "invalid" }).int("invalid").positive("invalid").max(ROW_ID_MAX, "invalid"), { error: "invalid" }).max(1000, "invalid"),
  startsOn: z.string({ error: "date" }).max(40, "date"),
  endsOn: z.string({ error: "date" }).max(40, "date"),
  maxUses: z.string({ error: "whole" }).max(40, "whole"),
  audience: z.enum(["all", "first", "returning"], { error: "invalid" }),
  oncePerPerson: z.boolean({ error: "invalid" }),
  daysAfterSignup: z.string({ error: "whole" }).max(40, "whole"),
  note: z.string({ error: "tooLong" }).max(10_000, "tooLong").transform(toStorable),
};

/** The drawer's autosave patch (the route's schema): some of its fields, no other (the switch has its own action: a field `active` is `invalid`). */
export const CODE_PATCH = z.strictObject(shape, { error: "invalid" }).partial();
/** „Lisa sooduskood“: every field. */
const NEW_CODE = z.strictObject(shape, { error: "invalid" });

// ---------- the stored code ----------

/** A stored code as the drawer holds it: the fields as typed, the switch, whether it is the welcome row, and whether any use of it exists (any: a cancelled one too). */
export type CodeValue = CodeFields & { welcome: boolean; active: boolean; used: boolean };

const fieldsOf = (c: StoredCode): CodeFields => ({
  code: c.code,
  kind: c.percent !== null ? "percent" : "euro",
  percent: c.percent !== null ? String(c.percent) : "",
  amount: c.amountCents !== null ? centsToInput(c.amountCents) : "",
  scope: c.scope,
  courseIds: c.scope === "courses" ? c.courseIds : [],
  startsOn: c.startsOn ?? "",
  endsOn: c.endsOn ?? "",
  maxUses: c.maxUses !== null ? String(c.maxUses) : "",
  audience: c.audience,
  oncePerPerson: c.oncePerPerson,
  daysAfterSignup: c.daysAfterSignup !== null ? String(c.daysAfterSignup) : "",
  note: c.note,
});

/** "k:" and the hash of the stored content: the fields, the chosen courses and the switch (never the uses: a booking changes no field). */
const versionOf = async (c: StoredCode): Promise<string> =>
  `k:${await contentVersion({ ...columnsOf(c), active: c.active, courseIds: c.scope === "courses" ? c.courseIds : [] })}`;

/** The stored columns the checks compare against (the shape codeColumns makes). */
const columnsOf = (c: StoredCode) => ({
  code: c.code,
  percent: c.percent,
  amountCents: c.amountCents,
  scope: c.scope,
  startsOn: c.startsOn,
  endsOn: c.endsOn,
  maxUses: c.maxUses,
  audience: c.audience,
  oncePerPerson: c.oncePerPerson,
  daysAfterSignup: c.daysAfterSignup,
  note: c.note,
});

/** Whether any use of the code exists: a registration's, a payment's or one whose order has gone (the delete and the code's text are held by any). */
async function hasUse(q: Q, id: number): Promise<boolean> {
  return rowsOf(await q.execute(sql`select 1 as used from discount_redemptions where code_id = ${id} limit 1`)).length > 0;
}

async function valueOf(q: Q, c: StoredCode): Promise<CodeValue> {
  return { ...fieldsOf(c), welcome: c.welcome, active: c.active, used: await hasUse(q, c.id) };
}

async function storedCode(q: Q, id: number): Promise<StoredCode | null> {
  const [row] = await q.select().from(discountCodes).where(eq(discountCodes.id, id)).limit(1);
  if (!row) return null;
  const chosen = await q.select({ courseId: discountCodeCourses.courseId }).from(discountCodeCourses).where(eq(discountCodeCourses.codeId, id));
  return { ...row, courseIds: chosen.map((c) => c.courseId).sort((a, b) => a - b) };
}

/** The code as the drawer reads it (the autosave route's `read`): its version and its value; null when there is none (404). */
export async function readCode(q: Q, id: number): Promise<{ version: string; value: CodeValue } | null> {
  const code = await storedCode(q, id);
  return code ? { version: await versionOf(code), value: await valueOf(q, code) } : null;
}

// ---------- the checks and the writes ----------

/** R18: the highest list price in the code's scope, read from the courses as they are now (null: none has a price). */
async function ceilingOf(q: Q, scope: CodeScope, courseIds: number[]): Promise<number | null> {
  const rows = await q.select({ id: courses.id, type: courses.type, price: courses.price, priceGroup: courses.priceGroup, priceIndividual: courses.priceIndividual }).from(courses);
  return highestListCents(scope, courseIds, rows.map((c) => ({ id: c.id, type: c.type, listCents: listCentsOf(c) })));
}

/** The id of another code that has this text (`except`: the code being saved), or null. */
async function takenBy(q: Q, code: string, except: number | null): Promise<number | null> {
  const [row] = await q.select({ id: discountCodes.id }).from(discountCodes).where(except === null ? eq(discountCodes.code, code) : and(eq(discountCodes.code, code), ne(discountCodes.id, except))).limit(1);
  return row?.id ?? null;
}

/** „Selline kood on juba olemas.“ with the id of the code that has it (R20: the field shows „Ava see kood“ to that drawer): the field's code is "codeTaken:<id>". */
const takenCode = (id: number): string => `codeTaken:${id}`;

/** Rewrites the chosen courses of the code: none unless the scope is `courses`. */
async function setCourses(tx: Tx, id: number, scope: CodeScope, courseIds: number[]): Promise<void> {
  await tx.delete(discountCodeCourses).where(eq(discountCodeCourses.codeId, id));
  if (scope !== "courses" || courseIds.length === 0) return;
  // (only courses that exist: one deleted meanwhile would be a foreign key error, and has no use for the code anyway)
  const existing = await tx.select({ id: courses.id }).from(courses).where(inArray(courses.id, courseIds));
  const ids = [...new Set(existing.map((c) => c.id))];
  if (ids.length > 0) await tx.insert(discountCodeCourses).values(ids.map((courseId) => ({ codeId: id, courseId })));
}

/** The patch's own fields (any other is not read: the switch has its own action). */
const ownFields = (patch: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).filter(([k]) => (CODE_FIELDS as readonly string[]).includes(k)));

type Done = { answer: SaveAnswer; wrote: boolean; welcome: boolean };

/**
 * The drawer's autosave (the route's `write`; server/autosave-route.ts' contract): `patch` (some of the fields; any other is not read) over the code at
 * `version`, under the code's row lock, taken as the transaction's first statement. The answers:
 * - ok with the code's version after it; a save that changes nothing answers the version it came from and writes nothing;
 * - a conflict with the stored version and value when `version` is not the code's (another tab saved a field or the switch first); a code deleted
 *   meanwhile: version "", value null;
 * - invalid with the fields' codes: each field's check over the stored row merged with the patch (R16), R18's ceiling when the kind, the euros or the
 *   scope are changed, `codeUsed` (the text of a used code, the welcome row excepted: T13-3), `codeTaken:<id>` (another code has the text), and `invalid` for the welcome row's audience and
 *   once per person (fixed rules).
 * A change to the welcome row revalidates every public page once, after the commit.
 */
export async function writeCode(db: Db, id: number, patch: Record<string, unknown>, version: string, now: Date): Promise<SaveAnswer> {
  const savedAt = now.toISOString();
  const own = ownFields(patch);
  const parsed = CODE_PATCH.safeParse(own);
  if (!parsed.success) return { ok: false, error: "invalid", fields: fieldCodes(parsed.error.issues) ?? Object.fromEntries(Object.keys(own).map((k) => [k, "invalid"])) };
  const sent = Object.keys(parsed.data);
  let done: Done;
  try {
    done = await db.transaction(async (tx): Promise<Done> => {
      const row = await lockCode(tx, id);
      if (!row) return { answer: { ok: false, error: "conflict", version: "", value: null }, wrote: false, welcome: false };
      const current = await versionOf(row);
      const welcome = row.welcome;
      if (version !== current) return { answer: { ok: false, error: "conflict", version: current, value: await valueOf(tx, row) }, wrote: false, welcome };
      // (the welcome row's two rules are fixed: the drawer does not show them, and the database's check would refuse the write)
      const fixed = welcome ? sent.filter((f) => f === "audience" || f === "oncePerPerson") : [];
      if (fixed.length > 0) return { answer: { ok: false, error: "invalid", fields: Object.fromEntries(fixed.map((f) => [f, "invalid"])) }, wrote: false, welcome };

      const stored = fieldsOf(row);
      const merged: CodeFields = { ...stored, ...parsed.data };
      const columns = codeColumns(merged, welcome);
      const unchanged = (Object.keys(columns) as (keyof typeof columns)[]).every((k) => columns[k] === columnsOf(row)[k]) && sameIds(merged, row);
      if (unchanged) return { answer: { ok: true, version: current, savedAt }, wrote: false, welcome };

      const ceilingMatters = changedCodeFields(merged, stored).some((f) => CEILING_FIELDS.includes(f));
      const highestCents = ceilingMatters ? await ceilingOf(tx, merged.scope, merged.courseIds) : null;
      const problems: Record<string, string> = { ...codeFieldProblems(merged, { welcome, highestCents }) };
      if (columns.code !== row.code) {
        if (!problems.code) {
          // T13-3: the welcome row stays replaceable (Seaded let Maria change it any time; its old text is in the mails already sent, which its hint says): its uses, and
          // the frozen code text on its bookings, stay as they are
          if (!welcome && (await hasUse(tx, id))) problems.code = "codeUsed";
          else {
            const other = await takenBy(tx, columns.code, id);
            if (other !== null) problems.code = takenCode(other);
          }
        }
      }
      if (Object.keys(problems).length > 0) return { answer: { ok: false, error: "invalid", fields: refusedFields(problems, sent) }, wrote: false, welcome };

      const [after] = await tx
        .update(discountCodes)
        .set({ ...columns, updatedAt: now })
        .where(eq(discountCodes.id, id))
        .returning();
      await setCourses(tx, id, columns.scope, merged.courseIds);
      const next = await storedCode(tx, after.id);
      return { answer: { ok: true, version: await versionOf(next!), savedAt }, wrote: true, welcome };
    });
  } catch (e) {
    // another code took the text between the check and the write (the unique index): the same answer as the check's
    const text = typeof parsed.data.code === "string" ? normalizeCode(parsed.data.code) : null;
    const other = dbErrorCode(e) === "23505" && text !== null ? await takenBy(db, text, id) : null;
    if (other === null) throw e;
    return { ok: false, error: "invalid", fields: refusedFields({ code: takenCode(other) }, sent) };
  }
  if (done.wrote && done.welcome) revalidatePublic({ kind: "welcomeCode" });
  return done.answer;
}

/** Whether the chosen courses are the stored ones (the scope's other values keep none). */
function sameIds(merged: CodeFields, row: StoredCode): boolean {
  const next = merged.scope === "courses" ? [...merged.courseIds].sort((a, b) => a - b) : [];
  const stored = row.scope === "courses" ? row.courseIds : [];
  return next.length === stored.length && next.every((v, i) => v === stored[i]);
}

/** „Lisa sooduskood“'s answer: the new code's id and version (the drawer goes on autosaving from it), or the refused fields. */
export type CreateCodeResult = { ok: true; id: number; version: string } | { ok: false; error: "invalid"; fields: Record<string, string> };

/**
 * „Lisa sooduskood“ (the one explicit create; the drawer autosaves after it): `input` the new drawer's every field (nothing the browser sends is
 * trusted: parsed, and every field checked, R18's ceiling too). `at.welcome`: the welcome row (`?kood=tervituskood`, R11; its audience and once per person are
 * fixed, and only one can exist: another is `codeTaken` of the existing one's id). A new code is active. The welcome row's create revalidates every public page.
 */
export async function createCode(db: Db, input: unknown, at: { welcome: boolean }, now: Date): Promise<CreateCodeResult> {
  const parsed = NEW_CODE.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid", fields: fieldCodes(parsed.error.issues) ?? {} };
  const v: CodeFields = parsed.data;
  const columns = codeColumns(v, at.welcome);
  let made: { ok: true; id: number; version: string } | { ok: false; fields: Record<string, string> };
  try {
    made = await db.transaction(async (tx) => {
      const problems: Record<string, string> = { ...codeFieldProblems(v, { welcome: at.welcome, highestCents: await ceilingOf(tx, v.scope, v.courseIds) }) };
      if (!problems.code) {
        const other = await takenBy(tx, columns.code, null);
        if (other !== null) problems.code = takenCode(other);
        else if (at.welcome) {
          const [welcome] = await tx.select({ id: discountCodes.id }).from(discountCodes).where(eq(discountCodes.welcome, true)).limit(1);
          if (welcome) problems.code = takenCode(welcome.id);
        }
      }
      if (Object.keys(problems).length > 0) return { ok: false as const, fields: problems };
      const [row] = await tx.insert(discountCodes).values({ ...columns, welcome: at.welcome, active: true, createdAt: now, updatedAt: now }).returning();
      await setCourses(tx, row.id, columns.scope, v.courseIds);
      return { ok: true as const, id: row.id, version: await versionOf((await storedCode(tx, row.id))!) };
    });
  } catch (e) {
    // another code (or the welcome row) was made between the check and the insert: the same answer as the check's
    if (dbErrorCode(e) !== "23505") throw e;
    const other = (await takenBy(db, columns.code, null)) ?? (at.welcome ? ((await db.select({ id: discountCodes.id }).from(discountCodes).where(eq(discountCodes.welcome, true)).limit(1))[0]?.id ?? null) : null);
    if (other === null) throw e;
    return { ok: false, error: "invalid", fields: { code: takenCode(other) } };
  }
  if (!made.ok) return { ok: false, error: "invalid", fields: made.fields };
  if (at.welcome) revalidatePublic({ kind: "welcomeCode" });
  return made;
}

/**
 * The switch „Aktiivne“, instant: `active` from `version` (the drawer's), under the code's lock. Stale when the code was saved elsewhere since (the drawer
 * reads the page again); the same state answers the version and writes nothing. A change to the welcome row revalidates every public page.
 */
export async function setCodeActive(db: Db, id: number, active: boolean, version: string, now: Date): Promise<{ ok: true; version: string } | { ok: false; error: "stale" | "notFound" }> {
  const done = await db.transaction(async (tx): Promise<{ answer: { ok: true; version: string } | { ok: false; error: "stale" | "notFound" }; wrote: boolean; welcome: boolean }> => {
    const row = await lockCode(tx, id);
    if (!row) return { answer: { ok: false, error: "notFound" }, wrote: false, welcome: false };
    const current = await versionOf(row);
    if (version !== current) return { answer: { ok: false, error: "stale" }, wrote: false, welcome: row.welcome };
    if (row.active === active) return { answer: { ok: true, version: current }, wrote: false, welcome: row.welcome };
    await tx.update(discountCodes).set({ active, updatedAt: now }).where(eq(discountCodes.id, id));
    return { answer: { ok: true, version: await versionOf({ ...row, active }) }, wrote: true, welcome: row.welcome };
  });
  if (done.wrote && done.welcome) revalidatePublic({ kind: "welcomeCode" });
  return done.answer;
}

/**
 * „Kustuta sooduskood“, only for a code with no use at all (a cancelled or abandoned booking's use holds it too: Maria pauses it), under the code's lock.
 * R19: a booking that committed after the check meets the use's foreign key (23503) when the row goes, and that is `used` too, never a 500. The welcome
 * row's delete revalidates every public page.
 */
export async function deleteCode(db: Db, id: number): Promise<{ ok: true } | { ok: false; error: "used" | "notFound" }> {
  let result: { ok: true; welcome: boolean } | { ok: false; error: "used" | "notFound" };
  try {
    result = await db.transaction(async (tx) => {
      const row = await lockCode(tx, id);
      if (!row) return { ok: false as const, error: "notFound" as const };
      if (await hasUse(tx, id)) return { ok: false as const, error: "used" as const };
      await tx.delete(discountCodes).where(eq(discountCodes.id, id));
      return { ok: true as const, welcome: row.welcome };
    });
  } catch (e) {
    if (dbErrorCode(e) === "23503") return { ok: false, error: "used" };
    throw e;
  }
  if (!result.ok) return result;
  if (result.welcome) revalidatePublic({ kind: "welcomeCode" });
  return { ok: true };
}

// ---------- the code's uses ----------

/** One use of a code as the drawer lists it: when, who, the course, the cents taken off, where it was taken, what it counts for and where it links (null: its order is gone). */
export type CodeUse = { id: number; at: Date; name: string; course: string; cents: number; via: "form" | "cart" | "admin"; mark: UseMark; href: string | null };

/** The code's uses, newest first, each marked by domain/discount-codes.ts useMark (the one rule the limit counts by) at `now`. */
export async function codeUses(q: Q, codeId: number, now: Date): Promise<CodeUse[]> {
  const rows = rowsOf(
    await q.execute(sql`
      select d.id as id, (extract(epoch from d.created_at) * 1000)::float8 as at_ms, d.email as email, d.discount_cents as cents, d.via as via, d.course_id as course_id,
        d.registration_id as registration_id, d.payment_id as payment_id,
        r.name as r_name, r.status as r_status, r.paid_cents as r_paid, (extract(epoch from r.created_at) * 1000)::float8 as r_created_ms,
        p.name as p_name, p.reference as p_reference, p.status as p_status,
        coalesce(${attemptEnds} > ${now.toISOString()}::timestamptz, false) as p_in_window,
        coalesce(p.status = 'refunded' and exists (select 1 from course_access ca where ca.client_id = p.client_id and ca.course_id = p.course_id and ca.revoked_at is null), false) as p_kept
      from ${useJoins}
      where d.code_id = ${codeId}
      order by d.created_at desc, d.id desc`),
  );
  if (rows.length === 0) return [];
  const courseIds = [...new Set(rows.flatMap((r) => (r.course_id === null ? [] : [Number(r.course_id)])))];
  const titles = new Map((courseIds.length > 0 ? await q.select({ id: courses.id, title: courses.title }).from(courses).where(inArray(courses.id, courseIds)) : []).map((c) => [c.id, pick(c.title, "et")]));
  return rows.map((r): CodeUse => {
    const registration = r.registration_id !== null && r.r_status !== null;
    const payment = r.payment_id !== null && r.p_status !== null;
    const mark = useMark(
      {
        registration: registration ? { status: r.r_status as never, paidCents: Number(r.r_paid), createdAt: new Date(Number(r.r_created_ms)) } : null,
        payment: payment ? { status: r.p_status as never, inWindow: r.p_in_window === true, accessKept: r.p_kept === true } : null,
      },
      now,
    );
    return {
      id: Number(r.id),
      at: new Date(Number(r.at_ms)),
      name: String((registration ? r.r_name : payment ? r.p_name : null) ?? r.email),
      course: r.course_id === null ? "" : (titles.get(Number(r.course_id)) ?? ""),
      cents: Number(r.cents),
      via: r.via as CodeUse["via"],
      mark,
      href: registration ? `/admin/registreerimised?id=${Number(r.registration_id)}` : payment ? `/admin/maksed?otsi=${encodeURIComponent(String(r.p_reference))}` : null,
    };
  });
}


// ---------- „Lisa sooduskood“ on a registration (D11) ----------

/** Why Maria's add or remove was refused (spec §5, R12): `paid` (Laekunud summa above 0), `unpaidInvoice`, `cancelled`, `unknown` (no such code), `stale` (a code there already to add over, none to remove, or the registration gone), `worthless` (the code takes nothing off this price). */
export type RegistrationDiscountError = "paid" | "unpaidInvoice" | "cancelled" | "unknown" | "stale" | "worthless";
export type RegistrationDiscountResult = { ok: true } | { ok: false; error: RegistrationDiscountError };

/**
 * The checks both actions share, under the locks they hold: the registration with its course, then `cancelled`, `paid` (`paid_cents > 0`) and
 * `unpaidInvoice` (any invoice of it with status `unpaid`: neither paid nor cancelled; D11's „Tühista enne maksmata arve.“). A registration that
 * is gone is `stale`.
 */
async function openRegistration(tx: Tx, registrationId: number): Promise<{ error: Exclude<RegistrationDiscountError, "unknown" | "worthless"> } | { registration: Registration; course: Course }> {
  const [found] = await tx.select({ registration: registrations, course: courses }).from(registrations).innerJoin(courses, eq(registrations.courseId, courses.id)).where(eq(registrations.id, registrationId)).limit(1);
  if (!found) return { error: "stale" as const };
  const r = found.registration;
  if (r.status === "cancelled") return { error: "cancelled" as const };
  if (r.paidCents > 0) return { error: "paid" as const };
  const [open] = await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.registrationId, registrationId), eq(invoices.status, "unpaid"))).limit(1);
  if (open) return { error: "unpaidInvoice" as const };
  return { registration: r, course: found.course };
}

/**
 * Maria puts a code on an unpaid registration (D11; spec §10 answer 2: NO rule of the code is checked, not its dates, pause, limit, scope or person
 * rules, only that it exists and takes something off this price). One transaction, in the booking's lock order (D8): lockForPayment (the session,
 * then the registration), the checks, then the use's insert, which takes only the code row's key-share lock (the foreign key; `no key update` does
 * not block it): never a session or advisory lock after a `discount_codes` lock. The use is written `via: "admin"` and counts like any other.
 * `unknown`: no such code (or deleted between the read and the insert); `stale`: the registration has a code already; `worthless`: the discount is 0
 * (discountCents caps it so that the total stays at MIN_TOTAL_CENTS, so a list price of 1,00 € or less gives 0; a course with no price too). The
 * price a contract froze stays.
 */
export async function addRegistrationDiscount(db: Db, registrationId: number, typed: string, now: Date): Promise<RegistrationDiscountResult> {
  try {
    return await db.transaction(async (tx): Promise<RegistrationDiscountResult> => {
      await lockForPayment(tx, registrationId);
      const open = await openRegistration(tx, registrationId);
      if ("error" in open) return { ok: false, error: open.error };
      const { registration: r, course } = open;
      const code = await findCode(tx, typed); // (takes no lock)
      if (!code) return { ok: false, error: "unknown" };
      if (r.discountCode !== "" || r.discountCents > 0) return { ok: false, error: "stale" };
      const list = registrationListCents(course, r);
      const off = list === null ? 0 : discountCents(ruleOf(code), list);
      if (list === null || off === 0) return { ok: false, error: "worthless" };
      await tx.update(registrations).set({ discountCents: off, discountCode: code.code }).where(eq(registrations.id, r.id));
      await insertRedemption(tx, { codeId: code.id, email: normalizeEmail(r.email), clientId: r.clientId, courseId: r.courseId, registrationId: r.id, listCents: list, discountCents: off, via: "admin" }, now);
      return { ok: true };
    });
  } catch (e) {
    if (dbErrorCode(e) === "23503") return { ok: false, error: "unknown" }; // the code was deleted after it was read
    if (dbErrorCode(e) === "23505") return { ok: false, error: "stale" }; // the registration has a use already
    throw e;
  }
}

/**
 * „Eemalda sooduskood“: the same locks and refusals as the add; deletes exactly this registration's use (whatever its `via`) and zeroes
 * `discount_cents` and `discount_code`. No code on the registration: `stale`. The code's own row is never locked.
 */
export async function removeRegistrationDiscount(db: Db, registrationId: number): Promise<RegistrationDiscountResult> {
  return db.transaction(async (tx): Promise<RegistrationDiscountResult> => {
    await lockForPayment(tx, registrationId);
    const open = await openRegistration(tx, registrationId);
    if ("error" in open) return { ok: false, error: open.error };
    const r = open.registration;
    if (r.discountCode === "" && r.discountCents === 0) return { ok: false, error: "stale" };
    await tx.delete(discountRedemptions).where(eq(discountRedemptions.registrationId, r.id));
    await tx.update(registrations).set({ discountCents: 0, discountCode: "" }).where(eq(registrations.id, r.id));
    return { ok: true };
  });
}
