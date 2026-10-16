import { relations, sql } from "drizzle-orm";
import { pgTable, serial, text, integer, boolean, jsonb, timestamp, pgEnum, uniqueIndex, index, primaryKey, customType, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { I18n } from "@/i18n/field";
import type { FeedbackAnswers } from "@/domain/protocols";

export const courseType = pgEnum("course_type", ["e_learning", "contact"]);
export const courseLevel = pgEnum("course_level", ["basic", "advanced"]);
export const regStatus = pgEnum("registration_status", ["awaiting_prepayment", "confirmed", "cancelled"]);
export const regKind = pgEnum("registration_kind", ["group", "individual"]);
export const payChoice = pgEnum("payment_choice", ["full", "half"]);
export const sessionStatus = pgEnum("session_status", ["scheduled", "cancelled"]);
export const requestKind = pgEnum("request_kind", ["contact", "individual", "practice", "waitlist", "change_request"]);
/** An online payment (phase 2b): a registration's prepayment, its rest after the prepayment, or an e-course purchase. */
export const payKind = pgEnum("payment_kind", ["prepayment", "balance", "ecourse"]);
/** pending: started; paid; failed (ended unpaid, or voided by the bank after paid); refunded; held: paid, but the amount or currency did not match. */
export const payStatus = pgEnum("payment_status", ["pending", "paid", "failed", "refunded", "held"]);

/** A badge's text: Estonian, and Russian when Maria gave one (the RU pages fall back to the Estonian text). */
export type BadgeLabel = { et: string; ru?: string };
/** A course badge as written now. */
export type Badge = { label: BadgeLabel; bg: string; fg: string } | null;
/** A course badge as it may be stored: rows written before round 2 have a plain Estonian label (domain/badge.ts reads both). */
export type StoredBadge = Badge | { label: string; bg: string; fg: string };

export const courses = pgTable("courses", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull(),
  type: courseType("type").notNull(),
  level: courseLevel("level").notNull(),
  title: jsonb("title").$type<I18n>().notNull(),
  summary: jsonb("summary").$type<I18n>().notNull(),
  body: jsonb("body").$type<I18n>().notNull(),
  outcomes: jsonb("outcomes").$type<I18n[]>().notNull().default([]),
  includes: jsonb("includes").$type<I18n[]>().notNull().default([]),
  language: text("language").notNull().default("ET"),        // "ET" | "RU" | "ET / RU"
  price: integer("price"),                                     // e-learning, cents
  priceGroup: integer("price_group"),                          // contact, cents
  priceIndividual: integer("price_individual"),                // contact, cents
  accessMonths: integer("access_months"),
  videoCount: integer("video_count"),
  durationLabel: jsonb("duration_label").$type<I18n>(),        // e.g. {et:"8 ak"}
  nextDiscount: jsonb("next_discount").$type<I18n>(),
  badge: jsonb("badge").$type<StoredBadge>(),
  recommendationIds: jsonb("recommendation_ids").$type<number[]>().notNull().default([]),
  /**
   * Maria's stage headings for a contact course's protocols (phase protocols, spec §3): plain strings in the language she writes in, not
   * translated; at most 30, each at most 120 characters, trimmed, no empty ones (domain/protocols.ts checkStages). A protocol copies them when
   * it is created (its first save); a change here reaches only protocols not created yet.
   */
  protocolStages: jsonb("protocol_stages").$type<string[]>().notNull().default([]),
  /**
   * An e-course's competency lines on its certificate (phase 3d, spec §3): plain Estonian text, at most 16 of at most 120 characters (the
   * course editor's "Tunnistus" card). Empty: the certificate takes the course's outcomes, Estonian (domain/certificate.ts certificateSkills).
   */
  certificateSkills: jsonb("certificate_skills").$type<string[]>().notNull().default([]),
  /** An e-course's volume on its certificate, "10 akadeemilist tundi"; empty: the PDF leaves it out. */
  certificateVolume: text("certificate_volume").notNull().default(""),
  published: boolean("published").notNull().default(false),
  sort: integer("sort").notNull().default(0),
  isSample: boolean("is_sample").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("courses_slug").on(t.slug)]);

export const courseImages = pgTable("course_images", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  key: text("key").notNull(),                                  // R2 key or "/seed/…" static path
  alt: jsonb("alt").$type<I18n>(),
  sort: integer("sort").notNull().default(0),
}, (t) => [index("course_images_course").on(t.courseId)]);

export const courseSessions = pgTable("course_sessions", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  city: text("city").notNull(),
  venue: text("venue").notNull().default(""),
  language: text("language").notNull().default("ET"),
  capacity: integer("capacity").notNull().default(4),
  status: sessionStatus("status").notNull().default("scheduled"),
});

export const registrations = pgTable("registrations", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => courses.id),
  courseSessionId: integer("course_session_id").references(() => courseSessions.id),
  kind: regKind("kind").notNull(),
  name: text("name").notNull(), email: text("email").notNull(), phone: text("phone").notNull().default(""),
  paymentChoice: payChoice("payment_choice").notNull(),
  wantsModelHelp: boolean("wants_model_help").notNull().default(false),
  wantsAccount: boolean("wants_account").notNull().default(false),
  preferredPeriod: text("preferred_period").notNull().default(""),
  message: text("message").notNull().default(""),
  locale: text("locale").notNull().default("et"),
  status: regStatus("status").notNull().default("awaiting_prepayment"),
  paidCents: integer("paid_cents").notNull().default(0),
  note: text("note").notNull().default(""),
  clientId: integer("client_id").references((): AnyPgColumn => clients.id, { onDelete: "set null" }),
  /**
   * The seat hold of an unpaid registration (phase 2b, D2): until this moment an `awaiting_prepayment` registration takes a seat
   * (db/queries/seats.ts takesSeat). Set to now + 30 minutes when its prepayment starts (server/payments/start.ts); null without one.
   */
  seatHoldUntil: timestamp("seat_hold_until", { withTimezone: true }),
  /**
   * The "Maksa" link's token (phase 2b, /maksa/<payToken>): 32 random bytes in base64url (server/token.ts newToken). A row written
   * without one (the migration's existing rows, the e2e fixtures' SQL) gets one from the default: two gen_random_uuid()s, 244 random bits,
   * in the same 43-character shape. It reveals nothing and is never logged.
   */
  payToken: text("pay_token")
    .notNull()
    .default(sql`translate(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', '-_')`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("registrations_client").on(t.clientId),
  index("registrations_email_lower").on(sql`lower(${t.email})`),
  uniqueIndex("registrations_pay_token").on(t.payToken),
]);

export const requests = pgTable("requests", {
  id: serial("id").primaryKey(),
  kind: requestKind("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, string | boolean | number>>().notNull(),
  handled: boolean("handled").notNull().default(false),
  clientId: integer("client_id").references((): AnyPgColumn => clients.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("requests_client").on(t.clientId)]);

export const practicePackages = pgTable("practice_packages", {
  code: text("code").primaryKey(),                             // "MINI" | "MAXI"
  name: jsonb("name").$type<I18n>().notNull(),
  tagline: jsonb("tagline").$type<I18n>().notNull(),
  models: integer("models").notNull(),
  durationLabel: jsonb("duration_label").$type<I18n>().notNull(),
  price: integer("price").notNull(),
  items: jsonb("items").$type<I18n[]>().notNull().default([]),
  sort: integer("sort").notNull().default(0),
});

export const heroSlides = pgTable("hero_slides", {
  id: serial("id").primaryKey(),
  imageKey: text("image_key").notNull(), imagePos: text("image_pos").notNull().default("50% 50%"),
  imagePosMobile: text("image_pos_mobile").notNull().default("50% 50%"),
  tone: text("tone").$type<"light" | "dark">().notNull().default("light"),
  kicker: jsonb("kicker").$type<I18n>().notNull(), title: jsonb("title").$type<I18n>().notNull(),
  text: jsonb("text").$type<I18n>().notNull(),
  ctaLabel: jsonb("cta_label").$type<I18n>().notNull(), ctaHref: text("cta_href").notNull(),
  active: boolean("active").notNull().default(true), sort: integer("sort").notNull().default(0),
});

export const faq = pgTable("faq", { id: serial("id").primaryKey(), q: jsonb("q").$type<I18n>().notNull(), a: jsonb("a").$type<I18n>().notNull(), sort: integer("sort").notNull().default(0) });

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(), slug: text("slug").notNull(),
  title: jsonb("title").$type<I18n>().notNull(), excerpt: jsonb("excerpt").$type<I18n>().notNull(),
  body: jsonb("body").$type<I18n>().notNull(), category: jsonb("category").$type<I18n>().notNull(),
  coverKey: text("cover_key").notNull(), publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  published: boolean("published").notNull().default(false),
}, (t) => [uniqueIndex("posts_slug").on(t.slug)]);

export const pages = pgTable("pages", { key: text("key").primaryKey(), title: jsonb("title").$type<I18n>().notNull(), body: jsonb("body").$type<I18n>().notNull() });
// keys: "trainer_bio", "center_story", "trainer_journey", "privacy", "terms", "statement"

export const galleryItems = pgTable("gallery_items", { id: serial("id").primaryKey(), group: text("group").notNull(), key: text("key").notNull(), alt: jsonb("alt").$type<I18n>(), sort: integer("sort").notNull().default(0) });
// group: "trainer_works"

/** Which home-page popup a `campaign` row is (phase 2c): the campaign offer, or the newsletter sign-up. One row of each. */
export type PopupKind = "campaign" | "newsletter";

/** The fixed row of each popup kind (the seed and the admin write these ids). */
export const POPUP_ID: Record<PopupKind, number> = { campaign: 1, newsletter: 2 };

/**
 * The home page's popups (prototype D's campaign; phase 2c adds the newsletter sign-up): one row per kind (POPUP_ID), and at most
 * one of them shown (`active`). The partial unique index makes the second active row a duplicate: every active row has the same
 * `active` value. The newsletter row uses kicker, title, text and imageKey; its code, ctaLabel and ctaHref stay empty.
 */
export const campaign = pgTable("campaign", {
  id: integer("id").primaryKey().default(1), active: boolean("active").notNull().default(true),
  kind: text("kind").$type<PopupKind>().notNull().default("campaign"),
  kicker: jsonb("kicker").$type<I18n>().notNull(), title: jsonb("title").$type<I18n>().notNull(), text: jsonb("text").$type<I18n>().notNull(),
  code: text("code").notNull().default(""), ctaLabel: jsonb("cta_label").$type<I18n>().notNull(), ctaHref: text("cta_href").notNull(),
  imageKey: text("image_key").notNull(),
}, (t) => [
  uniqueIndex("campaign_kind").on(t.kind),
  uniqueIndex("campaign_one_active").on(t.active).where(sql`${t.active}`),
]);

export const subscribers = pgTable("subscribers", {
  id: serial("id").primaryKey(), email: text("email").notNull(), locale: text("locale").notNull().default("et"),
  token: text("token").notNull(), consentAt: timestamp("consent_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  clientId: integer("client_id").references((): AnyPgColumn => clients.id, { onDelete: "set null" }),
}, (t) => [uniqueIndex("subscribers_email").on(t.email)]);

export const clients = pgTable("clients", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),                 // lowercased (normalizeEmail)
  name: text("name").notNull().default(""),
  phone: text("phone").notNull().default(""),
  locale: text("locale").$type<"et" | "ru">().notNull().default("et"),
  /** The optional password (phase 2c): `scrypt$15$8$1$<salt>$<key>` (server/password.ts); null without one. The e-mail code always works. */
  passwordHash: text("password_hash"),
  /** When the password was last set or changed; null without a password. */
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("clients_email").on(t.email)]);

export const clientLoginTokens = pgTable("client_login_tokens", {
  hash: text("hash").primaryKey(),                // sha256(raw link token)
  codeHash: text("code_hash").notNull(),          // sha256(`${hash}:${code}`)
  email: text("email").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  usedAt: timestamp("used_at", { withTimezone: true }),
}, (t) => [index("client_login_tokens_email").on(t.email)]);

export const clientSessions = pgTable("client_sessions", {
  idHash: text("id_hash").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason").$type<"logout" | "replaced">(),
}, (t) => [index("client_sessions_client").on(t.clientId)]);

export const courseAccess = pgTable("course_access", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  courseId: integer("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  grantedBy: text("granted_by").notNull(),        // admin e-mail or "payment"
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /** "Ava test uuesti" (e-course completion, spec §3.2): each reopen adds the course's tries; the tries allowed are course_tests.tries + this. */
  extraTries: integer("extra_tries").notNull().default(0),
  /**
   * When the last required step passed (spec §4.4: the last lesson, a passed test, or Maria's approving assessment): set once by
   * server/completion.ts completeIfDone (`where completed_at is null`) and never cleared, also when the access later ends.
   */
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [uniqueIndex("course_access_client_course").on(t.clientId, t.courseId)]);

export const termsAcceptances = pgTable("terms_acceptances", {
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  courseId: integer("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  termsVersion: text("terms_version").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.clientId, t.courseId, t.termsVersion] })]);

export const clientFavourites = pgTable("client_favourites", {
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  courseId: integer("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.clientId, t.courseId] })]);

export const mailQuota = pgTable("mail_quota", { day: text("day").primaryKey(), sent: integer("sent").notNull().default(0) });

// ---------- phase 2b: online payments (Montonio) ----------

/**
 * One online payment attempt (phase 2b, spec 5.1). `reference` is Montonio's merchantReference, `MSLAB-M<id>` in production (domain/payments.ts
 * orderReference; MSLAB-L<id> on this machine, MSLAB-P<id> on a preview), written in the insert's own transaction (db/queries/payments.ts insertPayment): every attempt is a new order.
 * `email` and `name` are the payer's as entered, kept for the books when the account or the registration is deleted (the links are set
 * null). `held`: Montonio said paid, but the amount or the currency did not match (server/payments/settle.ts). `paidAt` stays set when
 * the bank voids a paid payment (status failed), which the admin shows as "Kontrolli Montonios".
 */
export const payments = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    reference: text("reference").notNull(),
    kind: payKind("kind").notNull(),
    registrationId: integer("registration_id").references(() => registrations.id, { onDelete: "set null" }),
    courseId: integer("course_id").references(() => courses.id, { onDelete: "set null" }),
    clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    locale: text("locale").$type<"et" | "ru">().notNull().default("et"),
    amountCents: integer("amount_cents").notNull(),
    status: payStatus("status").notNull().default("pending"),
    providerUuid: text("provider_uuid"),
    method: text("method").notNull().default(""),
    bank: text("bank").notNull().default(""),
    /** E-course: "Soovin MS LABi uudiseid ja pakkumisi" was ticked in the cart; acted on when paid. */
    newsletter: boolean("newsletter").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_reference").on(t.reference),
    uniqueIndex("payments_provider_uuid").on(t.providerUuid),
    index("payments_registration").on(t.registrationId),
    index("payments_client").on(t.clientId),
    index("payments_status_created").on(t.status, t.createdAt),
    check("payments_amount_positive", sql`${t.amountCents} > 0`),
  ],
);

// ---------- protocols and the course feedback form ----------

/** One stage of a protocol: Maria's heading (copied from the course) and her note under it. */
export type ProtocolStage = { title: string; note: string };
/**
 * What the student sees: the copy "Saada" froze (server/protocols.ts sendProtocol), or "Saada hinnang" of an e-course's practical work, which
 * also freezes Maria's verdicts, aligned with `stages` (server/assessment.ts). A registration's copy has no `verdicts`.
 */
export type SentProtocol = { stages: ProtocolStage[]; generalNote: string; verdicts?: (Verdict | null)[] };

/**
 * A registration's protocol (spec §3, D1): the practice part (`stages`) and the training part (`generalNote`), written by Maria on the course
 * day. `version` rises with every saved change (server/protocols.ts saveProtocol refuses a save made from an older one). "Saada" freezes the
 * draft into `sent` with `sentAt` and `sentVersion`; the student is only ever served `sent`. The status is computed (domain/protocols.ts
 * protocolStatus): none without a row, a draft until sent, sent while version = sentVersion, changed after. Deleted with the registration, and
 * with the account (server/client-data.ts deleteClient).
 */
export const protocols = pgTable(
  "protocols",
  {
    id: serial("id").primaryKey(),
    /** A contact registration's protocol; null for an e-course access's (`accessId`). Exactly one of the two (protocols_one_owner). */
    registrationId: integer("registration_id").references(() => registrations.id, { onDelete: "cascade" }),
    /** An e-course access's protocol: its practical work and Maria's assessment (e-course completion, spec §3.4, D6); one per access. */
    accessId: integer("access_id").references(() => courseAccess.id, { onDelete: "cascade" }),
    stages: jsonb("stages").$type<ProtocolStage[]>().notNull(),
    generalNote: text("general_note").notNull().default(""),
    version: integer("version").notNull().default(1),
    sent: jsonb("sent").$type<SentProtocol>(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentVersion: integer("sent_version"),
    /**
     * Maria's draft verdict per point, aligned with `stages` (ruling R2): saved at once per tap (POST /api/admin/hinnang), outside the notes'
     * version check; a resubmission resets the "fix" ones to null (R3). A registration's protocol keeps `[]`.
     */
    verdicts: jsonb("verdicts").$type<(Verdict | null)[]>().notNull().default([]),
    /**
     * The student's submissions so far (0: none); photos being prepared belong to round + 1. Always 0 for a registration's protocol.
     * A resubmission raises `round` (and sets `submittedAt`) and resets the "fix" verdicts, but never the notes' `version` (ruling R3).
     */
    round: integer("round").notNull().default(0),
    /** The last submission ("Saada hindamiseks" / "Saada uuesti"); null before the first. */
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** The round Maria's last "Saada hinnang" assessed; null before (domain/completion.ts practicalStatus). */
    sentRound: integer("sent_round"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("protocols_registration").on(t.registrationId),
    uniqueIndex("protocols_access").on(t.accessId),
    check("protocols_one_owner", sql`(${t.registrationId} is null) <> (${t.accessId} is null)`),
  ],
);

/**
 * The end-of-course feedback form of one registration (spec §7): Maria's paper form "Sinu kogemus MS LAB koolitusel", answered online.
 * `answers` holds keys (domain/protocols.ts FEEDBACK_ORDER), never texts, so a wording fix never breaks an old answer. A row is made by
 * the submit (`submittedAt`) or by "Ei soovi" (`dismissedAt`, `answers` null); one per registration. Deleted with the registration, and with
 * the account.
 */
export const courseFeedback = pgTable(
  "course_feedback",
  {
    id: serial("id").primaryKey(),
    registrationId: integer("registration_id").notNull().references(() => registrations.id, { onDelete: "cascade" }),
    answers: jsonb("answers").$type<FeedbackAnswers>(),
    locale: text("locale").$type<"et" | "ru">(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("course_feedback_registration").on(t.registrationId), index("course_feedback_submitted").on(t.submittedAt)],
);

// ---------- phase 3a: modules, lessons, files, progress ----------

/** A module of a course (an e-course's module, a contact course's programme item), in `position` order (1…n). */
export const courseModules = pgTable("course_modules", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  title: jsonb("title").$type<I18n>().notNull(),
}, (t) => [index("course_modules_course").on(t.courseId, t.position)]);

/** A lesson video's state: none (no video uploaded yet), uploading (tus to Bunny), processing (Bunny encodes), ready, failed. */
export type VideoStatus = "none" | "uploading" | "processing" | "ready" | "failed";

/**
 * A lesson's kind, chosen by the admin ("Õppetunni liik"): a video lesson is done at 90 % of its video, and cannot be completed
 * while it has no video to play; a text lesson has no video and is done with "Märgi tehtuks". Never inferred from a missing video.
 */
export type LessonKind = "video" | "text";

/**
 * A lesson of an e-course module, in `position` order within its module. `kind`: see LessonKind. `videoId` is the Bunny video
 * uploaded last; `replacedVideoId` is the ready video it replaces ("Asenda video"), which plays until the new one is ready and is
 * then deleted. `videoStartedAt`: when the current upload began (the daily sweep gives up uploads older than 24 h).
 * `videoWidth` / `videoHeight`: the picture size in pixels of the video that PLAYS, as Bunny reports it when that video is ready
 * (both set, or both null when unknown: older videos, a size Bunny did not give). A replacement in progress leaves them alone.
 */
export const lessons = pgTable("lessons", {
  id: serial("id").primaryKey(),
  moduleId: integer("module_id").notNull().references(() => courseModules.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  title: jsonb("title").$type<I18n>().notNull(),
  body: jsonb("body").$type<I18n>(),
  kind: text("kind").$type<LessonKind>().notNull().default("video"),
  hidden: boolean("hidden").notNull().default(false),
  videoId: text("video_id"),
  videoStatus: text("video_status").$type<VideoStatus>().notNull().default("none"),
  durationSec: integer("duration_sec"),
  videoWidth: integer("video_width"),
  videoHeight: integer("video_height"),
  replacedVideoId: text("replaced_video_id"),
  videoStartedAt: timestamp("video_started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("lessons_module").on(t.moduleId, t.position), uniqueIndex("lessons_video").on(t.videoId)]);

/** A downloadable file of a lesson: the private R2 object `r2Key` (lessons/<uuid>.<ext>), shown as `name`. */
export const lessonFiles = pgTable("lesson_files", {
  id: serial("id").primaryKey(),
  lessonId: integer("lesson_id").notNull().references(() => lessons.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  name: text("name").notNull(),
  r2Key: text("r2_key").notNull(),
  size: integer("size").notNull(),
  contentType: text("content_type").notNull(),
}, (t) => [index("lesson_files_lesson").on(t.lessonId, t.position)]);

/**
 * One student's progress on one lesson: `watchedSec` only grows; `doneAt` is set once (≥ 90 % watched, or "Märgi tehtuks");
 * `unlockedBy` is the admin's e-mail when an admin opened this lesson for her ("Ava järgmine õppetund").
 */
export const lessonProgress = pgTable("lesson_progress", {
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  lessonId: integer("lesson_id").notNull().references(() => lessons.id, { onDelete: "cascade" }),
  watchedSec: integer("watched_sec").notNull().default(0),
  doneAt: timestamp("done_at", { withTimezone: true }),
  unlockedBy: text("unlocked_by"),
  /**
   * The progress clock (phase 2c, domain/lessons.ts acceptProgress): the moment up to which her watching time has been used. Set when
   * a video lesson is opened and moved on by every report; null for rows written before phase 2c.
   */
  clockAt: timestamp("clock_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.clientId, t.lessonId] }), index("lesson_progress_lesson").on(t.lessonId)]);

// ---------- e-course completion: the knowledge test, the practical work ----------

/** Maria's verdict on one practical point ("Kinnitatud" / "Paranda") or on one open answer. */
export type Verdict = "ok" | "fix";
/** One option of a choice question; `correct` is the answer key, which never leaves the server for the student (domain/completion.ts publicQuestions). */
export type ChoiceOption = { id: string; text: string; correct: boolean };
/**
 * One question of a course's knowledge test (spec §3.1): plain text in the course's language, not translated. `id`s are 1–32 characters
 * [0-9a-z] (newItemId makes 8 random ones when the question or option is added), never reused: attempts refer to questions and options by them.
 */
export type TestQuestion =
  | { id: string; kind: "choice"; text: string; options: ChoiceOption[] }
  | { id: string; kind: "open"; text: string };
/** A student's answers by question id: the picked option ids of a choice question, the text of an open one. */
export type TestAnswers = Record<string, string[] | string>;
/** Maria's review of the open answers, by question id. */
export type OpenReview = Record<string, { verdict: Verdict; comment: string }>;
/** failed: the choice part under the mark; review: open answers wait for Maria; fix: she asked to rewrite some; passed. */
export type AttemptStatus = "failed" | "review" | "fix" | "passed";

/**
 * An e-course's knowledge test (spec §3.1, ruling R1): a table of its own, not columns on `courses`, because whole `courses` rows ride on
 * the public pages' course objects (db/queries/public.ts) and the answer key must not. No row: the course has no questions (the pass mark
 * and the tries then default to 80 and 3). Saved with the course editor (db/queries/admin.ts saveCourseWithImages).
 */
export const courseTests = pgTable("course_tests", {
  courseId: integer("course_id").primaryKey().references(() => courses.id, { onDelete: "cascade" }),
  questions: jsonb("questions").$type<TestQuestion[]>().notNull().default([]),
  passPercent: integer("pass_percent").notNull().default(80),
  tries: integer("tries").notNull().default(3),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("course_tests_pass_percent", sql`${t.passPercent} between 1 and 100`),
  check("course_tests_tries", sql`${t.tries} between 1 and 10`),
]);

/**
 * One submitted try of the knowledge test (spec §3.3): `number` 1, 2, … per student and course; `questions` the frozen copy of the
 * course's questions it answered (Maria's later edits never change it); `correct` of `total` the choice questions answered exactly right.
 * Rewriting "Paranda" answers updates the same row (no new try). Deleted with the account and with the course.
 */
export const testAttempts = pgTable("test_attempts", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  courseId: integer("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  questions: jsonb("questions").$type<TestQuestion[]>().notNull(),
  answers: jsonb("answers").$type<TestAnswers>().notNull(),
  correct: integer("correct").notNull(),
  total: integer("total").notNull(),
  status: text("status").$type<AttemptStatus>().notNull(),
  review: jsonb("review").$type<OpenReview>(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  /** The admin's address of the last review. */
  reviewedBy: text("reviewed_by"),
}, (t) => [
  uniqueIndex("test_attempts_number").on(t.clientId, t.courseId, t.number),
  index("test_attempts_status").on(t.status, t.submittedAt),
]);

/**
 * One photo of the practical work (spec §3.5): point `stage` (0-based) of an access's protocol, in submission `round` (protocols.round + 1
 * while being prepared). `key` and `thumbKey` are private R2 objects `practical/<uuid>.jpg` and `practical/<uuid>-t.jpg`. Earlier rounds stay,
 * so Maria can compare after a "Paranda". Deleted with the protocol (and so with the access and the account); the R2 objects are removed
 * after the account's deletion commits (server/practical.ts practicalKeys).
 */
export const practicalPhotos = pgTable("practical_photos", {
  id: serial("id").primaryKey(),
  protocolId: integer("protocol_id").notNull().references(() => protocols.id, { onDelete: "cascade" }),
  stage: integer("stage").notNull(),
  round: integer("round").notNull(),
  key: text("key").notNull(),
  thumbKey: text("thumb_key").notNull(),
  size: integer("size").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("practical_photos_protocol").on(t.protocolId, t.stage, t.round)]);

// ---------- the certificate (phase 3d) ----------

/**
 * One e-course certificate (phase 3d, spec §3): one per completed access, made when the student confirms her name
 * (server/certificates.ts issueCertificate). It holds a frozen copy of everything the PDF prints but Maria's signature (her name, typed in
 * the script font: the trainer's name in Seaded), so a later change of the course or of Seaded → Tunnistus never alters it; Maria's
 * "Paranda nimi" changes only `name` and `reissuedAt`, under the same number. The PDF is drawn from this row on every download
 * (server/certificate-pdf.ts). Deleted with the access, and so with the account; its number is never given again (the series then has a gap).
 */
export const certificates = pgTable("certificates", {
  id: serial("id").primaryKey(),
  accessId: integer("access_id").notNull().references(() => courseAccess.id, { onDelete: "cascade" }),
  /** "MS LAB 2026-03" (domain/certificate.ts formatCertificateNumber): one series with Maria's paper certificates. */
  number: text("number").notNull(),
  /** The Tallinn year of the issue and the number within it: unique together, the backstop behind the issue's number lock. */
  year: integer("year").notNull(),
  seq: integer("seq").notNull(),
  /** As the student confirmed it (domain/certificate.ts checkCertificateName), or as Maria corrected it. */
  name: text("name").notNull(),
  /** The course's Estonian title at the issue. */
  courseTitle: text("course_title").notNull(),
  /** The competency lines at the issue (domain/certificate.ts certificateSkills). */
  skills: jsonb("skills").$type<string[]>().notNull(),
  /** "10 akadeemilist tundi"; empty: not printed. */
  volume: text("volume").notNull().default(""),
  practicalLine: text("practical_line").notNull(),
  place: text("place").notNull(),
  registryCode: text("registry_code").notNull(),
  /** The issue; its Tallinn date is printed after the place. A re-issue keeps it. */
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  /** Maria's last "Paranda nimi"; null before one. */
  reissuedAt: timestamp("reissued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("certificates_access").on(t.accessId),
  uniqueIndex("certificates_number").on(t.number),
  uniqueIndex("certificates_year_seq").on(t.year, t.seq),
  check("certificates_seq_positive", sql`${t.seq} >= 1`),
]);

/** text compared byte by byte (collation "C"): the KV keys sort as in Cloudflare KV, and a LIKE 'prefix%' can use the primary key index. */
const byteText = customType<{ data: string }>({ dataType: () => 'text COLLATE "C"' });

/**
 * The text key-value store of the forms' rate limits, the review comments and the Telegram chat id (server/kv.ts).
 * `expiresAt` null = never. The partial index serves the delete of expired rows that every TTL write runs (rate limit rows
 * hold visitors' IP addresses, which must not outlive their window).
 */
export const kvEntries = pgTable(
  "kv_entries",
  { key: byteText("key").primaryKey(), value: text("value").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }) },
  (t) => [index("kv_entries_expires_at").on(t.expiresAt).where(sql`${t.expiresAt} is not null`)],
);
export const settings = pgTable("settings", { key: text("key").primaryKey(), value: jsonb("value").notNull() });
// keys: "contact" {email, phone, address, instagram, facebook}, "newsletter" {discountLabel, welcomeCode}, "trainer" {portraitKey, name, role: I18n, stats: [{value,label:I18n}]}, "prepayment" {receiver, iban, bank, referencePrefix},
// "certificate" {place, registryCode, practicalLine, trainerName, nextYear, nextSeq} (phase 3d: domain/certificate.ts readCertificateSettings)

export const authTokens = pgTable("auth_tokens", { hash: text("hash").primaryKey(), email: text("email").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), usedAt: timestamp("used_at", { withTimezone: true }) });
export const adminSessions = pgTable("admin_sessions", { idHash: text("id_hash").primaryKey(), email: text("email").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull() });

// Relations (used by db.query.*.findMany({ with }))
export const coursesRelations = relations(courses, ({ many }) => ({
  images: many(courseImages),
  sessions: many(courseSessions),
}));
export const courseImagesRelations = relations(courseImages, ({ one }) => ({
  course: one(courses, { fields: [courseImages.courseId], references: [courses.id] }),
}));
export const courseSessionsRelations = relations(courseSessions, ({ one }) => ({
  course: one(courses, { fields: [courseSessions.courseId], references: [courses.id] }),
}));
export const registrationsRelations = relations(registrations, ({ one }) => ({
  course: one(courses, { fields: [registrations.courseId], references: [courses.id] }),
  courseSession: one(courseSessions, { fields: [registrations.courseSessionId], references: [courseSessions.id] }),
}));

export type Course = typeof courses.$inferSelect;
export type CourseImage = typeof courseImages.$inferSelect;
export type CourseSession = typeof courseSessions.$inferSelect;
export type Registration = typeof registrations.$inferSelect;
export type Request = typeof requests.$inferSelect;
export type PracticePackage = typeof practicePackages.$inferSelect;
export type HeroSlide = typeof heroSlides.$inferSelect;
export type FaqItem = typeof faq.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type Page = typeof pages.$inferSelect;
export type GalleryItem = typeof galleryItems.$inferSelect;
export type Campaign = typeof campaign.$inferSelect;
export type Subscriber = typeof subscribers.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type AuthToken = typeof authTokens.$inferSelect;
export type AdminSession = typeof adminSessions.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type ClientSession = typeof clientSessions.$inferSelect;
export type CourseModule = typeof courseModules.$inferSelect;
export type Lesson = typeof lessons.$inferSelect;
export type LessonFile = typeof lessonFiles.$inferSelect;
export type LessonProgressRow = typeof lessonProgress.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type PaymentKind = Payment["kind"];
export type PaymentStatus = Payment["status"];
export type Protocol = typeof protocols.$inferSelect;
export type CourseFeedback = typeof courseFeedback.$inferSelect;
export type CourseTest = typeof courseTests.$inferSelect;
export type TestAttempt = typeof testAttempts.$inferSelect;
export type PracticalPhoto = typeof practicalPhotos.$inferSelect;
export type Certificate = typeof certificates.$inferSelect;
