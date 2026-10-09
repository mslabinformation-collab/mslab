import { z } from "zod";

// Public form schemas (zod) and their FormData parsing. Every form posts FormData to a server action in
// actions/public.ts; the action parses it here first, so nothing reaches rate limiting or the database unchecked.
//
// Error codes are the forms' UI contract: e-mail "invalid", other fields "required", values the visitor cannot see
// (course slug, session id of the waitlist) → "form": "invalid". Later checks in the database add session "full" /
// "unavailable", and the rate limit adds form "rate".

export type Errors = Record<string, string>;
export type Parsed<T> = { ok: true; data: T } | { ok: false; errors: Errors };

const MAX = { name: 120, email: 200, phone: 40, period: 200, message: 2000, slug: 120 } as const;

/** Inner whitespace (newlines too) collapses to single spaces: these values also go into e-mail subjects. */
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

const text = (max: number) => z.string().trim().min(1).max(max);
/** A single-line value (name, phone, period). */
const line = (max: number) => z.string().transform(collapse).pipe(z.string().min(1).max(max));
const optionalLine = (max: number) => z.string().transform(collapse).pipe(z.string().max(max)).default("");
/** E-mail addresses are stored trimmed and lowercased. */
const email = z.string().trim().toLowerCase().pipe(z.email().max(MAX.email));
const phone = z.string().transform(collapse).pipe(z.string().regex(/^[+()\d\s-]{5,40}$/));
const id = z.coerce.number().int().positive().max(2_147_483_647);
const slug = z.string().trim().min(1).max(MAX.slug).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
/** A checkbox: "on" when ticked, absent otherwise. */
const flag = z.union([z.boolean(), z.string()]).optional().transform((v) => v === true || v === "on");
/** An unknown or missing locale falls back to Estonian instead of failing the form. */
const locale = z.enum(["et", "ru"]).catch("et");
const terms = z.literal("on");

/** Fields both contact-course forms share (group registration and individual request). */
const contactCourseFields = {
  name: line(MAX.name),
  email,
  phone,
  wantsModelHelp: flag,
  wantsAccount: flag,
  terms,
  locale,
};

/** A registration as stored (brief interface): a group registration names a session; payment is 100% or 50%. */
export const registrationSchema = z
  .object({
    courseId: id,
    courseSessionId: id.optional(),
    kind: z.enum(["group", "individual"]),
    ...contactCourseFields,
    paymentChoice: z.enum(["full", "half"]),
    preferredPeriod: z.string().trim().max(MAX.period).default(""),
    message: z.string().trim().max(MAX.message).default(""),
  })
  .refine((v) => v.kind === "individual" || v.courseSessionId != null, { path: ["courseSessionId"], message: "session" });
export type RegistrationInput = Omit<z.output<typeof registrationSchema>, "terms">;

/** The group registration form (ContactRegister): the course comes as its slug and is resolved in the database. */
export const groupRegistrationFormSchema = z.object({
  course: slug,
  courseSessionId: id,
  ...contactCourseFields,
  paymentChoice: z.enum(["full", "half"]),
  /** "Soovin MS LABi uudiseid ja pakkumisi" (phase 2c): ticked, the newsletter's own sign-up follows the registration. */
  wantsNewsletter: flag,
  /** The optional "Sõnum" (phase 2c): the welcome code is written there. */
  message: z.string().trim().max(MAX.message).default(""),
});

/** Individual contact course: a request to Maria with the preferred period; she agrees the time and payment (P12). */
export const individualSchema = z.object({
  course: slug,
  ...contactCourseFields,
  wantsNewsletter: flag,
  preferredPeriod: line(MAX.period),
  message: z.string().trim().max(MAX.message).default(""),
});

export const contactSchema = z.object({ name: line(MAX.name), email, message: text(MAX.message), locale });

/** E-learning cart before payment exists (P9): "let me know" e-mail. Stored as a contact request. */
export const purchaseInterestSchema = z.object({ course: slug, email, locale, wantsNewsletter: flag });

/** The e-course cart's purchase (phase 2b, spec 6.4, D3): name, e-mail, the terms box (required) and the newsletter box (unticked). */
export const ecoursePurchaseSchema = z.object({ course: slug, name: line(MAX.name), email, terms, wantsNewsletter: flag, locale });

export const practiceSchema = z.object({
  package: z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/),
  name: line(MAX.name),
  email,
  phone,
  course: optionalLine(MAX.period),
  times: text(MAX.message),
  locale,
});

export const waitlistSchema = z.object({ session: id, name: line(MAX.name), email, locale, wantsNewsletter: flag });

/** The newsletter's own sign-up: sending it is the consent (the time is stored), so there is no consent field. */
export const subscribeSchema = z.object({ email, locale });

// ---------- FormData → schema ----------

/** Honeypot: people never see the `website` field, so anything in it means a bot. */
export function isSpam(formData: FormData): boolean {
  return String(formData.get("website") ?? "").trim() !== "";
}

/** Error placement per schema key: the form field it belongs to and the code (default: same key, "required"). */
type Placement = Record<string, readonly [field: string, code: string]>;

/**
 * Reads `fields` (schema key → FormData name) from the form, parses them and maps the issues to field codes.
 * A missing entry is `undefined` (not null), so optional fields and defaults work as with a plain object.
 */
function parseForm<S extends z.ZodType>(
  schema: S,
  formData: FormData,
  fields: Record<string, string>,
  placement: Placement = {},
): Parsed<z.output<S>> {
  const raw: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(fields)) {
    const v = formData.get(name);
    raw[key] = typeof v === "string" ? v : undefined;
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  const errors: Errors = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "form");
    const [field, code] = placement[key] ?? (key === "email" ? ["email", "invalid"] : [key, "required"]);
    errors[field] ??= code;
  }
  return { ok: false, errors };
}

const same = (...names: string[]) => Object.fromEntries(names.map((n) => [n, n]));
const contactCourseForm = { ...same("course", "name", "email", "phone", "terms", "locale"), wantsModelHelp: "modelHelp", wantsAccount: "account", wantsNewsletter: "newsletter" };
const slugPlacement: Placement = { course: ["form", "invalid"] };

/** Contact message (home, /kontakt). Fields: name, email, message, locale. */
export const parseContact = (fd: FormData) => parseForm(contactSchema, fd, same("name", "email", "message", "locale"));

/** Newsletter. Fields: email, locale (a "consent" field an older page may still send is not read). */
export const parseSubscribe = (fd: FormData) => parseForm(subscribeSchema, fd, same("email", "locale"));

/**
 * Group registration. Fields: course (slug), session, name, email, phone, payment, modelHelp, account, newsletter ("Soovin MS LABi
 * uudiseid ja pakkumisi", phase 2c), message (optional, phase 2c), terms, locale.
 */
export const parseGroupRegistration = (fd: FormData) =>
  parseForm(groupRegistrationFormSchema, fd, { ...contactCourseForm, courseSessionId: "session", paymentChoice: "payment", message: "message" }, {
    ...slugPlacement,
    courseSessionId: ["session", "required"],
    paymentChoice: ["payment", "required"],
  });

/** Individual request. Fields as the group form without session and payment, plus period and message (optional); newsletter as there. */
export const parseIndividual = (fd: FormData) =>
  parseForm(individualSchema, fd, { ...contactCourseForm, preferredPeriod: "period", message: "message" }, {
    ...slugPlacement,
    preferredPeriod: ["period", "required"],
  });

/** Cart "let me know". Fields: course (slug), email, newsletter ("Soovin MS LABi uudiseid ja pakkumisi", phase 2c), locale. */
export const parsePurchaseInterest = (fd: FormData) =>
  parseForm(purchaseInterestSchema, fd, { ...same("course", "email", "locale"), wantsNewsletter: "newsletter" }, slugPlacement);

/** The e-course purchase (phase 2b). Fields: course (slug), name, email, terms, newsletter ("Soovin MS LABi uudiseid ja pakkumisi"), locale. */
export const parseEcoursePurchase = (fd: FormData) =>
  parseForm(ecoursePurchaseSchema, fd, { ...same("course", "name", "email", "terms", "locale"), wantsNewsletter: "newsletter" }, slugPlacement);

/** Practice request. Fields: package, name, email, phone, course (optional), times, locale. */
export const parsePractice = (fd: FormData) => parseForm(practiceSchema, fd, same("package", "name", "email", "phone", "course", "times", "locale"));

/** Waitlist for a full session. Fields: session, name, email, newsletter ("Soovin MS LABi uudiseid ja pakkumisi", phase 2c), locale. */
export const parseWaitlist = (fd: FormData) =>
  parseForm(waitlistSchema, fd, { ...same("session", "name", "email", "locale"), wantsNewsletter: "newsletter" }, { session: ["form", "invalid"] });
