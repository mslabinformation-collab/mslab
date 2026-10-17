import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db, Q, Tx } from "@/db/client";
import { setSetting, upsertPage } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import { lockRegistration } from "@/db/queries/seats";
import { clients, contracts, courseAccess, courses, courseSessions, pages, payments, registrations, type Contract } from "@/db/schema";
import {
  CONTRACT_CONTACT_KEY, CONTRACT_CONTACT_VERSION_KEY, contractLocale, contractValues, fillContract, paymentText, schoolOf, sessionText, type ContractFields, type ContractKind,
  type ContractSnapshot,
} from "@/domain/contract";
import { DEFAULT_TERMS_VERSION, nextTermsVersion, TERMS_PAGE_KEY, TERMS_VERSION_KEY } from "@/domain/course-terms";
import { euro } from "@/domain/invoice";
import { prepaymentDue, registrationPrice } from "@/domain/registration";
import { SITE_LIMITS } from "@/domain/site-editor";
import type { I18n } from "@/i18n/field";
import { toStorable } from "@/lib/to-storable";
import { contentVersion } from "@/lib/version";
import { lockAccess } from "./completion";
import { Check } from "./edit-check";
import { getInvoiceSettings } from "./invoices";

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
//   one access“), or after settle's own order: its payment row, the address lock, the rows linked to the address, course_access last.
// The partial unique indexes (contracts_current_registration, contracts_current_access) are the backstop: a second current contract is refused whatever
// the code does. Logs carry ids only (this module logs nothing).

/** The public „Õppetingimused“ page (`pages` key `terms`): the contact contract's text until Maria writes hers (D2). */
const PUBLIC_TERMS_KEY = "terms";
/** The version of a contact text before the first save, as the e-course text's is "1" (domain/course-terms.ts DEFAULT_TERMS_VERSION). */
const FIRST_CONTACT_VERSION = "1";
/** Seaded's save of the contact text holds this transaction lock (hashtext of it), so that two saves read and bump the version one after the other. */
const SAVE_LOCK = "contract-contact-text";

/** A contract text with its version and the language it is in: what a student reads, what a contract freezes, what a purchase keeps on its payment. */
export type ContractTemplate = ContractSnapshot;

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
  const stored = await storedTemplate(q, kind);
  const used = contractLocale(locale, (stored.body.ru ?? "").trim() !== "");
  const pick = (f: I18n): string => (used === "ru" && (f.ru ?? "").trim() ? (f.ru as string) : f.et);
  return { version: stored.version, locale: used, title: pick(stored.title), body: pick(stored.body) };
}

// ---------- the fields ----------

/** A course's name in the contract's language (D6): the Russian title for a Russian contract when the course has one, else the Estonian title. */
const courseName = (title: I18n, locale: "et" | "ru"): string => (locale === "ru" && (title.ru ?? "").trim() ? (title.ru as string) : title.et);

/**
 * What a contact registration's contract is made of: its fields (D3), `prepaymentText` and the `template` it is made from, from one read of the
 * registration and one read of the text, so that the language, the payment words, the course's name and the text agree and the caller reads none again.
 * The fields come from the registration, its course and its session: the school (Seaded → Arve andmed), the student as she typed herself, the course's
 * name in the contract's language, the session's date and place, the price (the group or the individual price: registrationPrice) and the payment
 * choice in words. `prepaymentText` is „Ettemaks“, the half the choice asks first (or the whole price), for the placeholder. `locale` (the template's
 * too) is the language the contract is made in (D6: the registration's, when that text exists in it, else Estonian). The template's version is read
 * before its text (storedTemplate). Null for an unknown registration.
 */
export async function registrationContractFields(
  q: Q,
  registrationId: number,
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
  const template = await contractTemplate(q, "contact", r.locale === "ru" ? "ru" : "et");
  const { locale } = template;
  const price = registrationPrice(course, r.kind);
  return {
    fields: {
      school: schoolOf(await getInvoiceSettings(q, new Date())),
      student: { name: r.name, email: r.email },
      course: courseName(course.title, locale),
      session: sessionText(session),
      price: price === null ? "" : euro(price),
      payment: paymentText(r.paymentChoice, locale),
    },
    prepaymentText: price === null ? "" : euro(prepaymentDue(price, r.paymentChoice)),
    locale,
    template,
  };
}

/**
 * What an e-course access's contract holds besides the text (D3): the school, the student (her account's name and e-mail), the course's name in the
 * contract's language (`locale`: the language of the text it goes with, the template's or the snapshot's; Estonian when omitted), no session and no
 * payment choice, and the price: the amount of the payment `paymentId` names (a purchase; settle calls it with the payment it has just marked paid),
 * empty for none, for a free grant and for a payment that is gone. Null for an unknown access.
 */
export async function accessContractFields(q: Q, accessId: number, paymentId?: number | null, locale: "et" | "ru" = "et"): Promise<ContractFields | null> {
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
    course: courseName(row.title, locale),
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
 */
export async function contractForAccess(
  tx: Tx,
  input: { accessId: number; clientId: number; courseId: number; paymentId?: number | null; snapshotOrTemplate: ContractTemplate; fields: ContractFields; via: "purchase" | "terms"; now: Date },
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
      acceptedAt: input.now,
      acceptedVia: input.via,
    })
    .returning();
  return row;
}

export type RequestContractResult = { ok: true } | { ok: false; error: "notFound" | "noAccount" | "cancelled" };

/**
 * „Saada leping kinnitamiseks“ (D4): records that Maria asked, `contract_requested_at` = `now` (asking again moves it), so that the student's account
 * offers „Kinnita leping“ until she accepts. Only a registration linked to an account (`noAccount`: the drawer says so) and not cancelled (`cancelled`)
 * can be asked; `notFound` for an unknown id, and for an individual registration (D4 asks on a group registration and D1 puts individual courses out of
 * scope: it is not one a contract is asked for). Under the registration's row lock. The mail with the link is the action's.
 */
export async function requestContract(db: Db, registrationId: number, now: Date): Promise<RequestContractResult> {
  return db.transaction(async (tx): Promise<RequestContractResult> => {
    const [r] = await tx.select({ kind: registrations.kind, clientId: registrations.clientId, status: registrations.status }).from(registrations).where(eq(registrations.id, registrationId)).for("update");
    if (!r || r.kind !== "group") return { ok: false, error: "notFound" };
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

/** An account's contracts (the client drawer's list), the newest acceptance first, the superseded ones too. */
export async function contractsOfClient(db: Db, clientId: number): Promise<Contract[]> {
  return db.select().from(contracts).where(eq(contracts.clientId, clientId)).orderBy(desc(contracts.acceptedAt), desc(contracts.id));
}

/** Her contract `id` (GET /api/konto/leping/<id>), a superseded one too, or null: another's, none. */
export async function contractForStudent(db: Db, clientId: number, id: number): Promise<Contract | null> {
  const [row] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.clientId, clientId))).limit(1);
  return row ?? null;
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

// ---------- Seaded → Lepingud ----------

/** The longest raw string taken before it is cleaned and checked against its limit: Seaded's parts cap every string at this (admin-site.ts `i18n`). */
const RAW_MAX = 40_000;
const i18nInput = z.object({ et: z.string().max(RAW_MAX), ru: z.string().max(RAW_MAX).optional() });
const textsInput = z.object({ title: i18nInput, body: i18nInput });

/** `f` as Postgres can store it (toStorable): a pasted control character never reaches the page or a contract. */
const storable = (f: { et: string; ru?: string }): I18n => ({ et: toStorable(f.et), ...(f.ru === undefined ? {} : { ru: toStorable(f.ru) }) });
const sameText = (a: I18n, b: I18n): boolean => a.et === b.et && (a.ru ?? "") === (b.ru ?? "");

/**
 * Seaded → Lepingud „Salvesta“ (D2): the contact contract's title and text in both languages, `{ title: { et, ru? }, body: { et, ru? } }`, stored as
 * the page `contract_contact`. Both are texts of Maria's: trimmed, the Estonian one required (a Russian text without it is refused), within the
 * legal texts' limits (SITE_LIMITS.legalTitle, SITE_LIMITS.legal), a blank Russian one left out; the refusals name their field (`title`, `body`) with
 * the editors' codes ("required", "tooLong"), and anything that is not that shape, or a string past RAW_MAX, is `form: "invalid"`. Nothing is stored when a field is refused.
 * The version (`contractContactVersion`, as `courseTermsVersion` is the e-course text's) moves to the time of the save only when the text or the title
 * changed, in the same transaction as the page, and never to the version already stored: the same text again keeps it. A first save is a change.
 */
export async function saveContractTexts(db: Db, raw: unknown, now: Date = new Date()): Promise<{ ok: true } | { ok: false; fields: Record<string, string> }> {
  const parsed = textsInput.safeParse(raw);
  if (!parsed.success) return { ok: false, fields: { form: "invalid" } };
  const c = new Check();
  const title = c.text("title", storable(parsed.data.title), SITE_LIMITS.legalTitle, { required: true });
  const body = c.text("body", storable(parsed.data.body), SITE_LIMITS.legal, { required: true });
  if (!c.ok || !title || !body) return { ok: false, fields: { ...c.errors } };
  await db.transaction(async (tx) => {
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
