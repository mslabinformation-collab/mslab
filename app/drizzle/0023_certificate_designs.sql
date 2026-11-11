CREATE TABLE "certificate_designs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tone" text NOT NULL,
	"background_key" text DEFAULT '' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "certificate_designs_tone" CHECK ("certificate_designs"."tone" in ('light', 'dark'))
);
--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "design" jsonb;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "certificate_design_id" integer;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_certificate_design_id_certificate_designs_id_fk" FOREIGN KEY ("certificate_design_id") REFERENCES "public"."certificate_designs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "certificate_designs" ("name", "tone", "background_key", "sort") VALUES ('Hele', 'light', '', 1), ('Tume', 'dark', '', 2);