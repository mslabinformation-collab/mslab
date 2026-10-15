CREATE TABLE "certificates" (
	"id" serial PRIMARY KEY NOT NULL,
	"access_id" integer NOT NULL,
	"number" text NOT NULL,
	"year" integer NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"course_title" text NOT NULL,
	"skills" jsonb NOT NULL,
	"volume" text DEFAULT '' NOT NULL,
	"practical_line" text NOT NULL,
	"place" text NOT NULL,
	"registry_code" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"reissued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "certificates_seq_positive" CHECK ("certificates"."seq" >= 1)
);
--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "certificate_skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "certificate_volume" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_access_id_course_access_id_fk" FOREIGN KEY ("access_id") REFERENCES "public"."course_access"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "certificates_access" ON "certificates" USING btree ("access_id");--> statement-breakpoint
CREATE UNIQUE INDEX "certificates_number" ON "certificates" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "certificates_year_seq" ON "certificates" USING btree ("year","seq");