CREATE TABLE "mail_suppressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "newsletter_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subject" jsonb NOT NULL,
	"preheader" jsonb NOT NULL,
	"image_key" text,
	"body" jsonb NOT NULL,
	"code" text,
	"button_label" jsonb,
	"button_href" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"recipients" jsonb,
	"broadcasts" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "resend_contact_id" text;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_suppressions_email" ON "mail_suppressions" USING btree ("email");