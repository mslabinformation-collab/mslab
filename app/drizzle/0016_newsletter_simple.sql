CREATE TABLE "newsletter_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"email" text NOT NULL,
	"locale" text NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "newsletter_deliveries" ADD CONSTRAINT "newsletter_deliveries_campaign_id_newsletter_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."newsletter_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_deliveries_campaign_email" ON "newsletter_deliveries" USING btree ("campaign_id","email");--> statement-breakpoint
CREATE INDEX "newsletter_deliveries_campaign_status" ON "newsletter_deliveries" USING btree ("campaign_id","status");--> statement-breakpoint
DROP TABLE "mail_suppressions" CASCADE;--> statement-breakpoint
ALTER TABLE "newsletter_campaigns" DROP COLUMN "broadcasts";--> statement-breakpoint
ALTER TABLE "subscribers" DROP COLUMN "resend_contact_id";--> statement-breakpoint
ALTER TABLE "subscribers" DROP COLUMN "synced_at";--> statement-breakpoint
DELETE FROM "settings" WHERE "key" IN ('resend_segments', 'resend_test_segment', 'newsletter_sync_lease');
