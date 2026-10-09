CREATE TYPE "public"."payment_kind" AS ENUM('prepayment', 'balance', 'ecourse');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'failed', 'refunded', 'held');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"registration_id" integer,
	"course_id" integer,
	"client_id" integer,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"locale" text DEFAULT 'et' NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"provider_uuid" text,
	"method" text DEFAULT '' NOT NULL,
	"bank" text DEFAULT '' NOT NULL,
	"newsletter" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "seat_hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "pay_token" text DEFAULT translate(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', '-_') NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reference" ON "payments" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_uuid" ON "payments" USING btree ("provider_uuid");--> statement-breakpoint
CREATE INDEX "payments_registration" ON "payments" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "payments_client" ON "payments" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "payments_status_created" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_pay_token" ON "registrations" USING btree ("pay_token");