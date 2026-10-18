import { z } from "zod";
import { checkFeedback, type FeedbackAnswers } from "@/domain/protocols";
import { storable } from "@/lib/storable"; // Postgres rejects a NUL in text and a lone surrogate in jsonb: both would be a 500
import type { FeedbackTarget } from "./course-feedback";

// The bodies of the client account's data endpoints (account-api.ts), parsed without trusting anything: a wrong type, a value
// that is too long or text the database cannot store gives `{ ok: false, error: "<field>" }` (the endpoint's 400), never an
// exception and never a database error. The limits are the endpoints' contract:
// name 120, phone 40, message 1000, slugs 200 (at most 100 in a merge), language et or ru, kind cancel or change, watchedSec 0 … 172 800
// (two days; the real bound is the video's length + 5 s, checked with the lesson), a password 1 … 800 UTF-16 units (the 10 … 200 characters
// rule is domain/password.ts, checked with the account's address). Ids in a path are not parsed here: parseRowId (lib/row-id.ts).

export type Input<T> = { ok: true; data: T } | { ok: false; error: string };

export const LIMITS = { name: 120, phone: 40, message: 1000, slug: 200, mergeSlugs: 100, version: 64, watchedSec: 172_800, passwordInput: 800 } as const;

/** One line: inner whitespace (newlines too) becomes single spaces, the ends are trimmed. May be empty. */
const line = (max: number) =>
  z.string().transform((s) => s.replace(/\s+/g, " ").trim()).pipe(z.string().max(max).refine(storable));

/** Free text, line breaks kept, the ends trimmed. May be empty. */
const text = (max: number) => z.string().transform((s) => s.trim()).pipe(z.string().max(max).refine(storable));

const slug = z.string().min(1).max(LIMITS.slug).refine(storable);
/** A row id: a JSON whole number that fits the database's integer. */
const rowId = z.number().int().positive().max(2_147_483_647);

const favourite = z.object({ slug, on: z.boolean() });
const merge = z.object({ slugs: z.array(slug).max(LIMITS.mergeSlugs) });
const profile = z.object({ name: line(LIMITS.name), phone: line(LIMITS.phone), locale: z.enum(["et", "ru"]) });
const newsletter = z.object({ on: z.boolean() });
const changeRequest = z.object({ registrationId: rowId, kind: z.enum(["cancel", "change"]), message: text(LIMITS.message).optional().transform((m) => m ?? "") });
/**
 * The terms gate: the version the page showed, the page's language (the contract's, D6; a page from before contracts sends none) and, from an
 * account with no name, the name typed in the gate's „Nimi“ (ruling R19). The name is any string here: it is read only for an account with no
 * name (a name sent from an account that has one is ignored), and checked then (gateName).
 */
const terms = z.object({ slug, version: z.string().min(1).max(LIMITS.version).refine(storable), locale: z.enum(["et", "ru"]).optional(), name: z.string().optional() });
/**
 * „Kinnitan“ (contracts Task 6): the registration, the version of the text the card showed (absent or empty is not a version: a mismatch, the server's
 * 409, ruling R6; the length is checked, the match is not) and the page's language (the contract's, D6; her account's without it).
 */
const contractAccept = z.object({ registrationId: rowId, version: z.string().max(LIMITS.version).refine(storable).optional(), locale: z.enum(["et", "ru"]).optional() });
const deletion = z.object({ confirm: z.literal(true) });
const progress = z.object({ watchedSec: z.number().min(0).max(LIMITS.watchedSec) });
/** Kept exactly as typed (no trim): the length and the e-mail rules are the server's, with the account's address (domain/password.ts). */
const password = z.object({ password: z.string().min(1).max(LIMITS.passwordInput).refine(storable) });
const payStart = z.object({ registrationId: rowId });
/** The form a feedback request names (student reviews): a contact course's registration (`id`) or an e-course's slug (`kursus`); exactly one of them (feedbackTarget). */
const feedbackTargetFields = { id: rowId.optional(), kursus: slug.optional() };
/**
 * The feedback form (phase protocols; student reviews, D1): its target, the page's language, the answers (domain/protocols.ts checkFeedback) and her
 * consent, `{ name }` (the tick with the name to show; domain/review.ts checkConsent decides whether it will do) or null for none. A body that sends
 * none is read as null: no tick, no review.
 */
const feedbackPost = z.object({ ...feedbackTargetFields, locale: z.enum(["et", "ru"]), answers: z.unknown(), consent: z.object({ name: z.string() }).nullish() });
const feedbackHide = z.object(feedbackTargetFields);
/** „Võta luba tagasi“ (student reviews, D6): the review to take back. */
const reviewWithdrawal = z.object({ reviewId: rowId });

export type FavouriteInput = z.infer<typeof favourite>;
export type MergeInput = z.infer<typeof merge>;
export type ProfileInput = z.infer<typeof profile>;
export type NewsletterInput = z.infer<typeof newsletter>;
export type ChangeRequestInput = z.infer<typeof changeRequest>;
export type TermsInput = z.infer<typeof terms>;
export type ContractAcceptInput = z.infer<typeof contractAccept>;
export type ProgressInput = z.infer<typeof progress>;

/** `body` (the parsed JSON, or null when it was not an object) against `schema`; the first wrong field is the error ("body" when it is not an object at all). */
function parse<S extends z.ZodType>(schema: S, body: unknown): Input<z.infer<S>> {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  const field = result.error.issues[0]?.path[0];
  return { ok: false, error: typeof field === "string" ? field : "body" };
}

export const parseFavourite = (body: unknown) => parse(favourite, body);
export const parseMerge = (body: unknown) => parse(merge, body);
export const parseProfile = (body: unknown) => parse(profile, body);
export const parseNewsletter = (body: unknown) => parse(newsletter, body);
export const parseChangeRequest = (body: unknown) => parse(changeRequest, body);
export const parseTerms = (body: unknown) => parse(terms, body);
export const parseContractAccept = (body: unknown) => parse(contractAccept, body);
export const parseDeletion = (body: unknown) => parse(deletion, body);
export const parseProgress = (body: unknown) => parse(progress, body);
export const parsePassword = (body: unknown) => parse(password, body);
export const parsePayStart = (body: unknown) => parse(payStart, body);

/** The form a body names: `{ id }` a registration, `{ kursus }` an e-course's slug; null for neither or both (the error "target"). */
function feedbackTarget(fields: { id?: number; kursus?: string }): FeedbackTarget | null {
  if (fields.id !== undefined && fields.kursus === undefined) return { registrationId: fields.id };
  if (fields.kursus !== undefined && fields.id === undefined) return { courseSlug: fields.kursus };
  return null;
}

/**
 * POST /tagasiside's body: the target (`id` or `kursus`), the language, the answers and the consent (`{ name }` or null). The error is the first wrong
 * field ("id", "kursus", "locale", "consent"), "target" for neither or both of `id` and `kursus`, or the answers' own (checkFeedback: a key, "answers" or "empty").
 */
export function parseFeedbackPost(body: unknown): Input<{ target: FeedbackTarget; locale: "et" | "ru"; answers: FeedbackAnswers; consent: { name: string } | null }> {
  const base = parse(feedbackPost, body);
  if (!base.ok) return base;
  const target = feedbackTarget(base.data);
  if (!target) return { ok: false, error: "target" };
  const answers = checkFeedback(base.data.answers);
  if (!answers.ok) return { ok: false, error: answers.error };
  return { ok: true, data: { target, locale: base.data.locale, answers: answers.answers, consent: base.data.consent ?? null } };
}

/** POST /tagasiside/peida's body: the target, as the form's. */
export function parseFeedbackHide(body: unknown): Input<{ target: FeedbackTarget }> {
  const base = parse(feedbackHide, body);
  if (!base.ok) return base;
  const target = feedbackTarget(base.data);
  return target ? { ok: true, data: { target } } : { ok: false, error: "target" };
}

export const parseReviewWithdrawal = (body: unknown) => parse(reviewWithdrawal, body);

/**
 * The name the terms gate asks an account with no name for (ruling R19), as Minu andmed takes a name: on one line (inner whitespace one space, the
 * ends trimmed), at most LIMITS.name characters, text the database can store. null for no name: none sent, a blank one, a longer one, or one with
 * a character Postgres refuses.
 */
export function gateName(raw: string | undefined): string | null {
  const result = line(LIMITS.name).safeParse(raw ?? "");
  return result.success && result.data !== "" ? result.data : null;
}

/** A course slug already decoded (a query value), or null when it cannot be one (empty, too long, text the database cannot hold). */
export function checkSlug(value: string): string | null {
  const result = slug.safeParse(value);
  return result.success ? result.data : null;
}

/** The course slug of a request path (still percent-encoded), or null when it cannot be a slug (not decodable, empty, too long, text the database cannot hold). */
export function parseSlug(raw: string): string | null {
  try {
    return checkSlug(decodeURIComponent(raw));
  } catch {
    return null;
  }
}
