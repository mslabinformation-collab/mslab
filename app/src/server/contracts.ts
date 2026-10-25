import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db, Q, Tx } from "@/db/client";
import { setSetting, upsertPage } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import { lockRegistration } from "@/db/queries/seats";
import { clients, contracts, courseAccess, courses, courseSessions, pages, payments, registrations, type Contract } from "@/db/schema";
import {
  CONTRACT_CONTACT_KEY, CONTRACT_CONTACT_VERSION_KEY, contractCourseName, contractLocale, contractParts, contractValues, fillContract, schoolOf, type ContractFields, type ContractKind,
  type ContractSnapshot,
} from "@/domain/contract";
import { DEFAULT_TERMS_VERSION, nextTermsVersion, TERMS_PAGE_KEY, TERMS_VERSION_KEY } from "@/domain/course-terms";
import { isSampleAddress } from "@/domain/email";
import { euro } from "@/domain/invoice";
import { registrationPrice } from "@/domain/registration";
import { SITE_LIMITS } from "@/domain/site-editor";
import type { I18n } from "@/i18n/field";
import type { Locale } from "@/i18n/locales";
import { toStorable } from "@/lib/to-storable";
import { contentVersion } from "@/lib/version";
import { contractMail, contractRequestMail } from "./account-mail";
import { lockAccess } from "./completion";
import { Check } from "./edit-check";
import { getInvoiceSettings } from "./invoices";
import { logFailure } from "./log";
import { mailConfigured, sendMail, type Env } from "./notify";

// The contracts' server (contracts, Task 3; spec D1–D7, §3–§6), without Next.js: the frozen contract of a registration and of an e-course access,
// asking again and superseding under the row's lock, the reads of the student and of Maria, the contract texts of Seaded (the contact text, its
// version) and the PDF. A contract is a copy made at the acceptance (D3) and never changes after its insert but for `superseded_at` and `sent_at`.
//
// The locks. A contract is written inside the transaction of the act that accepts it (the registration's submit, settle's paid e-course, the terms
// gate, the account's „Kinnitan“): contractForRegistration and contractForAccess take that `tx` and open none, so a failure of the act undoes the
// contract with it. Each takes the lock of the row the contract belongs to, FOR UPDATE, before it supersedes the current contract and inserts the
// new one: the registration's (db/queries/seats.ts lockRegistration) or the access's (completion.ts lockAccess). A transaction never waits for a lock
// it holds, so a caller that has the row already pays nothing. What the caller must keep, so that no two writes wait for each other the other way
// round:
// - contractForRegistration before any payment row lock of its transaction: the order of seats.ts is course_sessions → registrations → payments, and
//   a transaction that holds a payment row must not then wait for a registration. The submit (its own new registration) and „Kinnitan“ (the
//   registration alone) keep it.
// - contractForAccess with the access row as the first row lock of the write about one access (completion.ts: „the first lock of every write about
//   one access“), or after settle's own order: its payment row, the address lock, the rows linked to the address, course_access last. The terms
//   gate of an account with no name (ruling R19) writes the client's row too: it takes the address lock (client-auth.ts lockAddress) before the
//   access row and updates the client after it. Settle's grant (the client, then her access) and the account's deletion (her access, then the
//   client) write both rows under that same address lock, so it orders them all: none of them waits for the other the other way round.
// The partial unique indexes (contracts_current_registration, contracts_current_access) are the backstop: a second current contract is refused whatever
// the code does. Logs carry ids only: only the mail's part logs (a PDF that fails to render, a mail that fails), by the contract's id.

/** The public „Õppetingimused“ page (`pages` key `terms`): the contact contract's text until Maria writes hers (D2). */
const PUBLIC_TERMS_KEY = "terms";
/** The version of a contact text before the first save, as the e-course text's is "1" (domain/course-terms.ts DEFAULT_TERMS_VERSION). */
const FIRST_CONTACT_VERSION = "1";
/** Seaded's save of the contact text holds this transaction lock (hashtext of it), so that two saves read and bump the version one after the other. */
const SAVE_LOCK = "contract-contact-text";

/** A contract text with its version and the language it is in: what a student reads, what a contract freezes, what a purchase keeps on its payment. */
export type ContractTemplate = Omit<ContractSnapshot, "acceptedAt">;

// ---------- the templates ----------

/** A stored `{ et, ru? }` of strings, or null for anything else (the column is jsonb, so a row written by hand or an old one can hold anything). */
function textOf(value: unknown): I18n | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { et, ru } = value as { et?: unknown; ru?: unknown };
  if (typeof et !== "string") return null;
  return typeof ru === "string" ? { et, ru } : { et };
}

/** The title and the text of the page `key`, or null when it is not there or its Estonian text is empty (the Estonian text is the one the others fall back to). */
async function pageTexts(q: Q, key: string): Promise<{ title: I18n; body: I18n } | null> {
  const [row] = await q.select().from(pages).where(eq(pages.key, key)).limit(1);
  const body = textOf(row?.body);
  if (!row || !body || !body.et.trim()) return null;
  return { title: textOf(row.title) ?? { et: "" }, body };
}

/** A version setting, or `fallback` while it is not stored (or is not a text). */
async function versionOf(q: Q, key: string, fallback: string): Promise<string> {
  const value = await readSetting(q, key);
  return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * The text of a kind in both languages with its version, before a language is chosen. The version is read BEFORE the text, as client-data.ts reads
 * the terms' (versionThenText): a save of Maria's that lands in between then pairs the old version with the new text (the next acceptance of that
 * version is refused and shown again), never a new version with the old text, which a student would accept unseen.
 * - ecourse: the terms gate's version (`courseTermsVersion`), then the page `course_terms`.
 * - contact: `contractContactVersion`, then Maria's page `contract_contact`; until she has written it (D2) the public „Õppetingimused“ text, whose
 *   version is of its text (a hash of the very value returned, so the two can never come apart), so that an edit of it is another version for whoever
 *   compares versions (the account's „Kinnita leping“ refuses an acceptance of a text that was edited since it was shown) although nothing bumps a
 *   setting for it. A first save that lands between the version and the page gives Maria's text with "1", which no acceptance of the old text matches.
 * With no text at all the contract is empty rather than registering blocked (D2: never block registration).
 */
async function storedTemplate(q: Q, kind: ContractKind): Promise<{ title: I18n; body: I18n; version: string }> {
  const none = { title: { et: "" }, body: { et: "" } };
  if (kind === "ecourse") {
    const version = await versionOf(q, TERMS_VERSION_KEY, DEFAULT_TERMS_VERSION);
    return { ...((await pageTexts(q, TERMS_PAGE_KEY)) ?? none), version };
  }
  const version = await versionOf(q, CONTRACT_CONTACT_VERSION_KEY, FIRST_CONTACT_VERSION);
  const own = await pageTexts(q, CONTRACT_CONTACT_KEY);
  if (own) return { ...own, version };
  const terms = (await pageTexts(q, PUBLIC_TERMS_KEY)) ?? none;
  return { ...terms, version: `terms:${(await contentVersion(terms)).slice(0, 16)}` };
}

/**
 * The text a student reads for a contract of `kind`, in her language (D6): Russian when `locale` is "ru" and the Russian text exists, else Estonian
 * (the `locale` it answers is the language the text is in, the one the contract is stored and printed in). The title falls back to the Estonian one.
 * The placeholders are not filled here (fillContract with contractValues does that, at the acceptance).
 */
export async function contractTemplate(q: Q, kind: ContractKind, locale: "et" | "ru"): Promise<ContractTemplate> {
  return inLanguage(await storedTemplate(q, kind), locale);
}

/**
 * contractTemplate for a page in Estonian and for one in Russian, from ONE read of the text (its version before it, storedTemplate): what the terms
 * gate shows on either page (ruling R18), each the very template acceptTerms freezes on a page in that language.
 */
export async function contractTemplates(q: Q, kind: ContractKind): Promise<Record<"et" | "ru", ContractTemplate>> {
  const stored = await storedTemplate(q, kind);
  return { et: inLanguage(stored, "et"), ru: inLanguage(stored, "ru") };
}

/** The stored text in the language a page in `locale` reads it in (D6; contractTemplate). */
function inLanguage(stored: { title: I18n; body: I18n; version: string }, locale: "et" | "ru"): ContractTemplate {
  const used = contractLocale(locale, (stored.body.ru ?? "").trim() !== "");
  const pick = (f: I18n): string => (used === "ru" && (f.ru ?? "").trim() ? (f.ru as string) : f.et);
  return { version: stored.version, locale: used, title: pick(stored.title), body: pick(stored.body) };
}

/**
 * Whether the text a form's page showed is the one a contract made now freezes (ruling R6): `shown` is the version the page rendered (the
 * registration form's hidden field, the cart's purchase input), `template` the text read for the contract (contractTemplate: the version before the
 * text). The version is read once more after that text, so a save of Maria's that lands anywhere between the page and here, or between the
 * template's version and its text, refuses. A page without a version (cached before the forms sent one) is refused too: it may show anything.
 */
export async function shownVersionHolds(q: Q, kind: ContractKind, locale: "et" | "ru", template: ContractTemplate, shown: string | undefined): Promise<boolean> {
  if (!shown || shown !== template.version) return false;
  return (await contractTemplate(q, kind, locale)).version === shown;
}

// ---------- the fields ----------

/**
 * What a contact registration's contract is made of: its fields (D3), `prepaymentText` and the `template` it is made from, from one read of the
 * registration and one read of the text, so that the language, the payment words, the course's name and the text agree and the caller reads none again.
 * The fields come from the registration, its course and its session: the school (Seaded → Maksmine), the student as she typed herself, the course's
 * name in the contract's language, the session's date and place, the price (the group or the individual price: registrationPrice) and the payment
 * choice in words. `prepaymentText` is „Ettemaks“, the half the choice asks first (or the whole price), for the placeholder. `locale` (the template's
 * too) is the language the contract is made in (D6: the registration's, when that text exists in it, else Estonian). The template's version is read
 * before its text (storedTemplate). Null for an unknown registration. The fields are domain/contract.ts contractParts of the stored registration:
 * the function the form's inline contract fills itself with in the browser (Review Focus 3).
 * `pageLocale`: the language of the page the contract is shown and accepted on, when it is not the registration's own (the account's „Kinnitan“,
 * D6: the language of the page she accepts it on, as the terms gate's); without it, the registration's.
 */
export async function registrationContractFields(
  q: Q,
  registrationId: number,
  pageLocale?: "et" | "ru",
): Promise<{ fields: ContractFields; prepaymentText: string; locale: "et" | "ru"; template: ContractTemplate } | null> {
  const [row] = await q
    .select({ registration: registrations, course: courses, session: courseSessions })
    .from(registrations)
    .innerJoin(courses, eq(registrations.courseId, courses.id))
    .leftJoin(courseSessions, eq(registrations.courseSessionId, courseSessions.id))
    .where(eq(registrations.id, registrationId))
    .limit(1);
  if (!row) return null;
  const { registration: r, course, session } = row;
  const template = await contractTemplate(q, "contact", pageLocale ?? (r.locale === "ru" ? "ru" : "et"));
  const { locale } = template;
  const parts = contractParts({
    name: r.name,
    email: r.email,
    course: contractCourseName(course.title, locale),
    session,
    priceCents: registrationPrice(course, r.kind),
    choice: r.paymentChoice,
    locale,
  });
  return {
    fields: { school: schoolOf(await getInvoiceSettings(q, new Date())), ...parts.fields },
    prepaymentText: parts.prepayment,
    locale,
    template,
  };
}

/**
 * What an e-course access's contract holds besides the text (D3): the school, the student (her account's name and e-mail), the course's name in the
 * contract's language (`locale`: the language of the text it goes with, the template's or the snapshot's), no session and no payment choice, and the
 * price: the amount of the payment `paymentId` names (a purchase; settle calls it with the payment it has just marked paid), empty for none, for a
 * free grant and for a payment that is gone. Null for an unknown access.
 */
export async function accessContractFields(q: Q, accessId: number, paymentId: number | null, locale: "et" | "ru"): Promise<ContractFields | null> {
  const [row] = await q
    .select({ name: clients.name, email: clients.email, title: courses.title })
    .from(courseAccess)
    .innerJoin(clients, eq(courseAccess.clientId, clients.id))
    .innerJoin(courses, eq(courseAccess.courseId, courses.id))
    .where(eq(courseAccess.id, accessId))
    .limit(1);
  if (!row) return null;
  let price = "";
  if (paymentId != null) {
    const [paid] = await q.select({ amountCents: payments.amountCents }).from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (paid) price = euro(paid.amountCents);
  }
  return {
    school: schoolOf(await getInvoiceSettings(q, new Date())),
    student: { name: row.name, email: row.email },
    course: contractCourseName(row.title, locale),
    session: "",
    price,
    payment: "",
  };
}

// ---------- the contracts ----------

/** Marks the current contracts matching `owner` superseded at `now`: a newer one replaces them (D4). */
const supersede = (tx: Tx, owner: SQL, now: Date) => tx.update(contracts).set({ supersededAt: now }).where(and(owner, isNull(contracts.supersededAt)));

/**
 * A contact registration's contract (D1, D4): the template filled with the registration's fields (fillContract over contractValues, in one pass; the
 * filled title and text are what is stored), inserted as the registration's current contract, with the way it was accepted (`form`: the box of the
 * registration form; `account`: „Kinnitan“ after Maria asked again) and `now` as the time. A contract the registration has is superseded by it, in
 * the same transaction, and `contract_requested_at` is cleared (Maria's ask is answered). Runs in the caller's transaction, after its locks, and
 * takes the registration's row lock (FOR UPDATE) first; it opens no transaction of its own. Two accepts at once leave one current contract.
 *
 * It makes a contract on every call. A caller that must not make a second one for the same act (the account's „Kinnitan“ tapped twice) checks that
 * Maria's ask is still open (contract_requested_at is set) after taking the registration's lock itself, before it calls: the lock is reentrant.
 */
export async function contractForRegistration(
  tx: Tx,
  input: { registrationId: number; clientId: number | null; courseId: number; template: ContractTemplate; fields: ContractFields; prepaymentText: string; via: "form" | "account"; now: Date },
): Promise<Contract> {
  await lockRegistration(tx, input.registrationId);
  const values = contractValues(input.fields, input.prepaymentText);
  await supersede(tx, eq(contracts.registrationId, input.registrationId), input.now);
  const [row] = await tx
    .insert(contracts)
    .values({
      kind: "contact",
      registrationId: input.registrationId,
      courseId: input.courseId,
      clientId: input.clientId,
      version: input.template.version,
      locale: input.template.locale,
      title: fillContract(input.template.title, values),
      body: fillContract(input.template.body, values),
      fields: input.fields,
      acceptedAt: input.now,
      acceptedVia: input.via,
    })
    .returning();
  await tx.update(registrations).set({ contractRequestedAt: null }).where(eq(registrations.id, input.registrationId));
  return row;
}

/**
 * An e-course access's contract (D1), inserted as the access's current contract: `terms` (the terms gate) or `purchase` (settle's paid winner, with
 * `paymentId`). Runs in the caller's transaction, after its locks, and opens none of its own. It takes the access's row lock (completion.ts
 * lockAccess, FOR UPDATE) first and throws when the access is gone or is not `clientId`'s access to `courseId` (the ids the caller passes belong
 * together; a contract is never written under the wrong owner).
 * - `terms`: null, and nothing written, when the access already has a current contract of this version (accepting the same text twice makes no second
 *   contract; a purchase's contract of that version satisfies the gate too). A current contract of another version is superseded.
 * - `purchase` (ruling R4): always freezes its own contract with the paid price and supersedes the access's current one, whatever its version. One
 *   access row serves a free grant followed by a purchase and a renewal, and each paid purchase is a contract of its own.
 *
 * `snapshotOrTemplate` is what the way says it is. A `purchase` brings the snapshot the cart showed (payments.contract_snapshot), which is filled
 * already (a value of it such as a name typed "{hind}" must not be filled a second time), so it is stored exactly as it is. A `terms` brings the
 * current template, which is filled here with the access's fields (fillContract over contractValues; an e-course has no „Ettemaks“).
 *
 * The times (ruling R7): `now` is when this is written, the time the current contract is superseded at; `acceptedAt`, when the acceptance was
 * given, if earlier (a purchase: the press of „Maksa“ that filled its snapshot); `now` by default. A superseded contract is so never marked
 * superseded before the contract that replaces it exists.
 */
export async function contractForAccess(
  tx: Tx,
  input: {
    accessId: number;
    clientId: number;
    courseId: number;
    paymentId?: number | null;
    snapshotOrTemplate: ContractTemplate;
    fields: ContractFields;
    via: "purchase" | "terms";
    now: Date;
    acceptedAt?: Date;
  },
): Promise<Contract | null> {
  const access = await lockAccess(tx, input.accessId);
  if (!access || access.clientId !== input.clientId || access.courseId !== input.courseId) {
    throw new Error(`contracts: access ${input.accessId} does not belong to client ${input.clientId} and course ${input.courseId}`); // ids only
  }
  const [current] = await tx.select({ id: contracts.id, version: contracts.version }).from(contracts).where(and(eq(contracts.accessId, input.accessId), isNull(contracts.supersededAt))).limit(1);
  const shown = input.snapshotOrTemplate;
  if (input.via === "terms" && current?.version === shown.version) return null;
  if (current) await supersede(tx, eq(contracts.accessId, input.accessId), input.now);
  const values = contractValues(input.fields, "");
  const [row] = await tx
    .insert(contracts)
    .values({
      kind: "ecourse",
      accessId: input.accessId,
      courseId: input.courseId,
      clientId: input.clientId,
      paymentId: input.paymentId ?? null,
      version: shown.version,
      locale: shown.locale,
      title: input.via === "purchase" ? shown.title : fillContract(shown.title, values),
      body: input.via === "purchase" ? shown.body : fillContract(shown.body, values),
      fields: input.fields,
      acceptedAt: input.acceptedAt ?? input.now,
      acceptedVia: input.via,
    })
    .returning();
  return row;
}

export type RequestContractResult = { ok: true } | { ok: false; error: "notFound" | "noAccount" | "cancelled" };

/**
 * „Saada leping kinnitamiseks“ (D4): records that Maria asked, `contract_requested_at` = `now` (asking again moves it), so that the student's account
 * offers „Kinnita leping“ until she accepts. Only a registration linked to an account (`noAccount`: the drawer says so) and not cancelled (`cancelled`)
 * can be asked; `notFound` for an unknown id, and for any registration that is not a group registration of a contact course: an individual one (D4 asks
 * on a group registration and D1 puts individual courses out of scope), and one of an e-course (its contract is the access's, not a registration's).
 * Under the registration's row lock. The mail with the link is the action's.
 */
export async function requestContract(db: Db, registrationId: number, now: Date): Promise<RequestContractResult> {
  return db.transaction(async (tx): Promise<RequestContractResult> => {
    const [r] = await tx.select({ kind: registrations.kind, clientId: registrations.clientId, status: registrations.status, courseId: registrations.courseId }).from(registrations).where(eq(registrations.id, registrationId)).for("update");
    if (!r || r.kind !== "group") return { ok: false, error: "notFound" };
    const [course] = await tx.select({ type: courses.type }).from(courses).where(eq(courses.id, r.courseId)).limit(1);
    if (course?.type !== "contact") return { ok: false, error: "notFound" };
    if (r.clientId === null) return { ok: false, error: "noAccount" };
    if (r.status === "cancelled") return { ok: false, error: "cancelled" };
    await tx.update(registrations).set({ contractRequestedAt: now }).where(eq(registrations.id, registrationId));
    return { ok: true };
  });
}

// ---------- the reads ----------

/** A registration's contracts for Maria's drawer: the current one first, then the superseded ones, the newest first. None once the registration is gone (the link is set null). */
export async function contractsOfRegistration(db: Db, registrationId: number): Promise<Contract[]> {
  return db
    .select()
    .from(contracts)
    .where(eq(contracts.registrationId, registrationId))
    .orderBy(sql`${contracts.supersededAt} is not null`, desc(contracts.acceptedAt), desc(contracts.id));
}

/**
 * Whose a contract is (ruling R14): the client its registration is linked to NOW, else the client its access belongs to, else the client the contract
 * froze (`contracts.client_id`: what the registration or the access said at the acceptance; null for a registration with no account yet). The live link
 * comes first, so a contract made before the student had an account is hers once the registration is linked to it (`linkClientRecords` never touches a
 * frozen row), and a registration Maria re-links moves with its contracts to the new client and is never shown to two. Needs both left joins below
 * (registrations, course_access) in the query it is used in; every query that reads a contract by its owner uses this one expression.
 */
export const CONTRACT_OWNER = sql<number | null>`coalesce(${registrations.clientId}, ${courseAccess.clientId}, ${contracts.clientId})`;

/** An account's contracts (the client drawer's list), the newest acceptance first, the superseded ones too: the contracts it owns (CONTRACT_OWNER). */
export async function contractsOfClient(db: Db, clientId: number): Promise<Contract[]> {
  const rows = await db
    .select({ contract: contracts })
    .from(contracts)
    .leftJoin(registrations, eq(contracts.registrationId, registrations.id))
    .leftJoin(courseAccess, eq(contracts.accessId, courseAccess.id))
    .where(sql`${CONTRACT_OWNER} = ${clientId}`)
    .orderBy(desc(contracts.acceptedAt), desc(contracts.id));
  return rows.map((r) => r.contract);
}

/**
 * What a course card needs of the contracts she owns (the dashboard, ruling R14: the same owner as contractsOfClient, in ONE query for all the
 * cards): the id, the registration or the access it belongs to, and when it was accepted, of her CURRENT contracts only (not superseded), the
 * newest acceptance first. No title, text or fields: the card links the PDF by the id, and the text is read when she asks for it.
 */
export async function currentContractsOfClient(q: Q, clientId: number): Promise<{ id: number; registrationId: number | null; accessId: number | null; acceptedAt: Date }[]> {
  return q
    .select({ id: contracts.id, registrationId: contracts.registrationId, accessId: contracts.accessId, acceptedAt: contracts.acceptedAt })
    .from(contracts)
    .leftJoin(registrations, eq(contracts.registrationId, registrations.id))
    .leftJoin(courseAccess, eq(contracts.accessId, courseAccess.id))
    .where(and(isNull(contracts.supersededAt), sql`${CONTRACT_OWNER} = ${clientId}`))
    .orderBy(desc(contracts.acceptedAt), desc(contracts.id));
}

/** Her contract `id` (GET /api/konto/leping/<id>), a superseded one too, or null: another's, none. "Hers" is CONTRACT_OWNER. */
export async function contractForStudent(db: Db, clientId: number, id: number): Promise<Contract | null> {
  const [row] = await db
    .select({ contract: contracts })
    .from(contracts)
    .leftJoin(registrations, eq(contracts.registrationId, registrations.id))
    .leftJoin(courseAccess, eq(contracts.accessId, courseAccess.id))
    .where(and(eq(contracts.id, id), sql`${CONTRACT_OWNER} = ${clientId}`))
    .limit(1);
  return row?.contract ?? null;
}

/** The client contract `id` belongs to now (CONTRACT_OWNER), or null: no account behind it (or an unknown id). */
export async function contractOwner(q: Q, id: number): Promise<number | null> {
  const [row] = await q
    .select({ owner: CONTRACT_OWNER })
    .from(contracts)
    .leftJoin(registrations, eq(contracts.registrationId, registrations.id))
    .leftJoin(courseAccess, eq(contracts.accessId, courseAccess.id))
    .where(eq(contracts.id, id))
    .limit(1);
  return row?.owner ?? null;
}

/** Any contract, for Maria; null for an unknown id. */
export async function contractForAdmin(db: Db, id: number): Promise<Contract | null> {
  const [row] = await db.select().from(contracts).where(eq(contracts.id, id)).limit(1);
  return row ?? null;
}

/** Records that the PDF of contract `id` was mailed to the student at `now` („Saada koopia õpilasele“ and the acceptance's own mail). The one other write a contract takes. */
export async function markContractSent(db: Db, id: number, now: Date): Promise<void> {
  await db.update(contracts).set({ sentAt: now }).where(eq(contracts.id, id));
}

// ---------- Seaded → Kontaktkoolituse leping (its writer; the card types into a draft, server/legal-drafts.ts) ----------

/** The longest raw string taken before it is cleaned and checked against its limit: Seaded's parts cap every string at this (admin-site.ts `i18n`). */
const RAW_MAX = 40_000;
const i18nInput = z.object({ et: z.string().max(RAW_MAX), ru: z.string().max(RAW_MAX).optional() });
const textsInput = z.object({ title: i18nInput, body: i18nInput });

/** `f` as Postgres can store it (toStorable): a pasted control character never reaches the page or a contract. */
const storable = (f: { et: string; ru?: string }): I18n => ({ et: toStorable(f.et), ...(f.ru === undefined ? {} : { ru: toStorable(f.ru) }) });
const sameText = (a: I18n, b: I18n): boolean => a.et === b.et && (a.ru ?? "") === (b.ru ?? "");

/**
 * The contact contract's writer (D2; since admin UX pass piece 3b, Task 5 the publish of its draft, „Avalda uus leping“: server/legal-drafts.ts, which
 * calls it unchanged inside its own transaction — `db` is then that transaction and this one a savepoint of it): the title and text in both
 * languages, `{ title: { et, ru? }, body: { et, ru? } }`, stored as
 * the page `contract_contact`. Both are texts of Maria's: trimmed, the Estonian one required (a Russian text without it is refused), within the
 * legal texts' limits (SITE_LIMITS.legalTitle, SITE_LIMITS.legal), a blank Russian one left out; the refusals name their field (`title`, `body`) with
 * the editors' codes ("required", "tooLong"), and anything that is not that shape, or a string past RAW_MAX, is `form: "invalid"`. Nothing is stored when a field is refused.
 * The version (`contractContactVersion`, as `courseTermsVersion` is the e-course text's) moves to the time of the save only when the text or the title
 * changed, in the same transaction as the page, and never to the version already stored: the same text again keeps it. A first save is a change.
 */
export async function saveContractTexts(db: Q, raw: unknown, now: Date = new Date()): Promise<{ ok: true } | { ok: false; fields: Record<string, string> }> {
  const parsed = textsInput.safeParse(raw);
  if (!parsed.success) return { ok: false, fields: { form: "invalid" } };
  const c = new Check();
  const title = c.text("title", storable(parsed.data.title), SITE_LIMITS.legalTitle, { required: true });
  const body = c.text("body", storable(parsed.data.body), SITE_LIMITS.legal, { required: true });
  if (!c.ok || !title || !body) return { ok: false, fields: { ...c.errors } };
  await (db as Db).transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${SAVE_LOCK}))`);
    const [stored] = await tx.select().from(pages).where(eq(pages.key, CONTRACT_CONTACT_KEY)).limit(1);
    await upsertPage(tx, { key: CONTRACT_CONTACT_KEY, title, body });
    if (stored && sameText(stored.title, title) && sameText(stored.body, body)) return;
    await setSetting(tx, CONTRACT_CONTACT_VERSION_KEY, nextTermsVersion(now, await readSetting(tx, CONTRACT_CONTACT_VERSION_KEY)));
  });
  return { ok: true };
}

// ---------- the PDF ----------

/**
 * The PDF of a contract row, rendered on each download from its frozen copy alone (spec §5), like the invoice's. contract-pdf.ts (pdf-lib and its
 * fontkit) and the fonts' loader are imported here, when a contract is rendered: this module comes with the registration's submit, settle and the
 * account's routes, which then never load the PDF stack at a cold start. The font is the certificate's and the invoice's (no new font).
 */
export async function contractPdf(c: Contract): Promise<Uint8Array> {
  const [{ renderContract }, { loadCertificateAssets }] = await Promise.all([import("./contract-pdf"), import("./certificate-pdf")]);
  const fonts = await loadCertificateAssets();
  return renderContract(c, { sans: fonts.sans });
}

// ---------- the mails (D7) ----------

/**
 * The PDF of `c` for a mail (contractPdf), or null when it fails to render: the mail then goes without it and without its line „Leping on lisatud.“
 * (D7: mails are best effort, and Maria can send a copy). The log has the contract's id and the error's class, never its message.
 */
export async function contractPdfForMail(c: Contract): Promise<Uint8Array | null> {
  try {
    return await contractPdf(c);
  } catch (e) {
    logFailure(`[contracts] contract ${c.id}: the mail went without its PDF`, e);
    return null;
  }
}

/**
 * „MS LAB leping kinnitamiseks“ to the student (account-mail.ts contractRequestMail; ruling R9), after Maria's „Saada leping kinnitamiseks“ was
 * recorded (requestContract): to the registration's address, in its language, with a plain link to her account page, where the card shows
 * „Kinnita leping“. Best effort, as every mail of the contracts: never to a sample address (`@example.test`), nothing without Resend (local
 * development), never throws; true when the mail went out. The registration is read here, so the caller passes the id alone. Not counted in the
 * daily caps (it follows Maria's own press). The log has the registration's id only.
 */
export async function mailContractRequest(deps: { db: Db; env: Env; siteUrl: string }, registrationId: number): Promise<boolean> {
  try {
    const [row] = await deps.db
      .select({ email: registrations.email, name: registrations.name, locale: registrations.locale, title: courses.title })
      .from(registrations)
      .innerJoin(courses, eq(registrations.courseId, courses.id))
      .where(eq(registrations.id, registrationId))
      .limit(1);
    if (!row) return false;
    if (isSampleAddress(row.email)) {
      console.info(`[contracts] registration ${registrationId}: the ask was not mailed (sample address)`);
      return false;
    }
    if (!mailConfigured(deps.env)) return false;
    const locale = row.locale === "ru" ? "ru" : "et";
    const sent = await sendMail(deps.env, contractRequestMail({ siteUrl: deps.siteUrl, email: row.email, name: row.name, locale, course: contractCourseName(row.title, locale) }), { count: deps.db });
    console.info(`[contracts] registration ${registrationId}: the ask was mailed: ${sent}`);
    return sent;
  } catch (e) {
    logFailure(`[contracts] registration ${registrationId}: the ask's mail failed`, e);
    return false;
  }
}

/**
 * „MS LAB leping“ to the student (account-mail.ts contractMail), after the act that accepted `c` (the terms gate; Tasks 5 and 6 send it too): to
 * the address the contract froze, in `locale` (the language of the page she accepted it on; the contract's own by default), with its PDF attached
 * (none when it fails to render: contractPdfForMail), and `sent_at` recorded at `now` once Resend took a mail that carried the PDF (a failure of
 * that record alone is logged, and the mail still counts as sent). Never to a
 * sample address (`@example.test`), and nothing without Resend (local development). Not counted in the daily caps: it follows her own act (or
 * Maria's). Never throws; true when the mail went out. The log has the contract's id only. `opts.pdf`: a PDF the caller drew already (Maria's copy
 * draws it first, so that it never sends a mail without it: ruling R15), attached as it is instead of drawing it again.
 */
export async function mailContract(
  deps: { db: Db; env: Env; siteUrl: string; now: Date },
  c: Contract,
  opts: { locale?: Locale; noAccount?: boolean; pdf?: Uint8Array } = {},
): Promise<boolean> {
  try {
    const { email, name } = c.fields.student;
    if (isSampleAddress(email)) {
      console.info(`[contracts] contract ${c.id}: not mailed (sample address)`);
      return false;
    }
    if (!mailConfigured(deps.env)) return false;
    // (`opts.pdf`: the caller rendered it already and has seen it render, as Maria's copy does: it is not drawn twice)
    const pdf = opts.pdf ?? (await contractPdfForMail(c));
    const sent = await sendMail(deps.env, contractMail({ siteUrl: deps.siteUrl, email, name, locale: opts.locale ?? c.locale, contract: c, pdf, noAccount: opts.noAccount }), { count: deps.db });
    console.info(`[contracts] contract ${c.id}: mailed: ${sent}`);
    // the mail is out once Resend took it: a failure to record that (sent_at) is logged on its own, and the answer stays true
    if (sent && pdf) {
      try {
        await markContractSent(deps.db, c.id, deps.now);
      } catch (e) {
        logFailure(`[contracts] contract ${c.id}: mailed, but the send was not recorded`, e);
      }
    }
    return sent;
  } catch (e) {
    logFailure(`[contracts] contract ${c.id}: the mail failed`, e);
    return false;
  }
}
