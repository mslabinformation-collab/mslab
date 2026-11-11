CREATE TYPE "public"."discount_audience" AS ENUM('all', 'first', 'returning');--> statement-breakpoint
CREATE TYPE "public"."discount_scope" AS ENUM('all', 'ecourse', 'contact', 'courses');--> statement-breakpoint
CREATE TYPE "public"."redemption_via" AS ENUM('form', 'cart', 'admin');--> statement-breakpoint
CREATE TABLE "discount_code_courses" (
	"code_id" integer NOT NULL,
	"course_id" integer NOT NULL,
	CONSTRAINT "discount_code_courses_code_id_course_id_pk" PRIMARY KEY("code_id","course_id")
);
--> statement-breakpoint
CREATE TABLE "discount_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"welcome" boolean DEFAULT false NOT NULL,
	"percent" smallint,
	"amount_cents" integer,
	"scope" "discount_scope" DEFAULT 'all' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"max_uses" integer,
	"audience" "discount_audience" DEFAULT 'all' NOT NULL,
	"once_per_person" boolean DEFAULT true NOT NULL,
	"days_after_signup" smallint,
	"note" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_codes_code_shape" CHECK ("discount_codes"."code" ~ '^[A-Z0-9-]{1,30}$' AND "discount_codes"."code" ~ '[A-Z0-9]'),
	CONSTRAINT "discount_codes_one_value" CHECK (("discount_codes"."percent" is null) <> ("discount_codes"."amount_cents" is null)),
	CONSTRAINT "discount_codes_percent_range" CHECK ("discount_codes"."percent" between 1 and 99),
	CONSTRAINT "discount_codes_amount_positive" CHECK ("discount_codes"."amount_cents" > 0),
	CONSTRAINT "discount_codes_dates_order" CHECK ("discount_codes"."ends_on" >= "discount_codes"."starts_on"),
	CONSTRAINT "discount_codes_max_uses_positive" CHECK ("discount_codes"."max_uses" > 0),
	CONSTRAINT "discount_codes_days" CHECK ("discount_codes"."days_after_signup" is null or ("discount_codes"."welcome" and "discount_codes"."days_after_signup" between 1 and 365)),
	CONSTRAINT "discount_codes_welcome_rules" CHECK (not "discount_codes"."welcome" or ("discount_codes"."audience" = 'first' and "discount_codes"."once_per_person"))
);
--> statement-breakpoint
CREATE TABLE "discount_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"code_id" integer NOT NULL,
	"email" text NOT NULL,
	"client_id" integer,
	"course_id" integer,
	"registration_id" integer,
	"payment_id" integer,
	"list_cents" integer NOT NULL,
	"discount_cents" integer NOT NULL,
	"via" "redemption_via" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_redemptions_cents_positive" CHECK ("discount_redemptions"."list_cents" > 0 and "discount_redemptions"."discount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "discount_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "discount_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "discount_code_courses" ADD CONSTRAINT "discount_code_courses_code_id_discount_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."discount_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_code_courses" ADD CONSTRAINT "discount_code_courses_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_code_id_discount_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."discount_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discount_codes_code" ON "discount_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_codes_one_welcome" ON "discount_codes" USING btree ("welcome") WHERE "discount_codes"."welcome";--> statement-breakpoint
CREATE INDEX "discount_redemptions_code" ON "discount_redemptions" USING btree ("code_id");--> statement-breakpoint
CREATE INDEX "discount_redemptions_code_email" ON "discount_redemptions" USING btree ("code_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_redemptions_registration" ON "discount_redemptions" USING btree ("registration_id") WHERE "discount_redemptions"."registration_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "discount_redemptions_payment" ON "discount_redemptions" USING btree ("payment_id") WHERE "discount_redemptions"."payment_id" is not null;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_discount_not_negative" CHECK ("payments"."discount_cents" >= 0);--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_discount_not_negative" CHECK ("registrations"."discount_cents" >= 0);--> statement-breakpoint
-- The welcome code of the newsletter setting becomes the welcome row (the setting itself stays, unchanged, for a rollback). The percent is read as
-- domain/welcome-code.ts discountPercentOf does (the number, else the digits of the old discountLabel, else 10) and the days as codeDaysOf. Every
-- cast sits inside a CASE whose condition is the regex that guards it, in its own nested CASE: Postgres does not promise to evaluate the parts of
-- one AND left to right, so a text that is not a number must never be in the same condition as its cast. COALESCE tries its parts in order.
INSERT INTO "discount_codes" ("code", "welcome", "percent", "scope", "audience", "once_per_person", "days_after_signup", "active")
SELECT v->>'welcomeCode', true,
  COALESCE(
    CASE WHEN jsonb_typeof(v->'discountPercent') = 'number' THEN
      CASE WHEN (v->>'discountPercent') ~ '^[0-9]{1,2}$' THEN
        CASE WHEN (v->>'discountPercent')::int BETWEEN 1 AND 99 THEN (v->>'discountPercent')::int END
      END
    END,
    CASE WHEN substring(v->>'discountLabel' from '[0-9]+') ~ '^[0-9]{1,2}$' THEN
      CASE WHEN substring(v->>'discountLabel' from '[0-9]+')::int BETWEEN 1 AND 99 THEN substring(v->>'discountLabel' from '[0-9]+')::int END
    END,
    10),
  'all', 'first', true,
  CASE WHEN jsonb_typeof(v->'codeDays') = 'number' THEN
    CASE WHEN (v->>'codeDays') ~ '^[0-9]{1,3}$' THEN
      CASE WHEN (v->>'codeDays')::int BETWEEN 1 AND 365 THEN (v->>'codeDays')::int END
    END
  END,
  true
FROM (SELECT "value" AS v FROM "settings" WHERE "key" = 'newsletter') s
WHERE (v->>'welcomeCode') ~ '^[A-Z0-9-]{1,30}$' AND (v->>'welcomeCode') ~ '[A-Z0-9]';
