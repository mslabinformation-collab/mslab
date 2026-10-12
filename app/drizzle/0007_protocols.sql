CREATE TABLE "course_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"registration_id" integer NOT NULL,
	"answers" jsonb,
	"locale" text,
	"submitted_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocols" (
	"id" serial PRIMARY KEY NOT NULL,
	"registration_id" integer NOT NULL,
	"stages" jsonb NOT NULL,
	"general_note" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"sent" jsonb,
	"sent_at" timestamp with time zone,
	"sent_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "protocol_stages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "course_feedback" ADD CONSTRAINT "course_feedback_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_feedback_registration" ON "course_feedback" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "course_feedback_submitted" ON "course_feedback" USING btree ("submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "protocols_registration" ON "protocols" USING btree ("registration_id");