CREATE TABLE "course_areas" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "area_id" integer;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_area_id_course_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."course_areas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Data step (by hand): Maria's two areas from her message of 10.11 (spec 2026-11-11-course-areas-filter-design.md §3), in her order; no course gets one.
INSERT INTO "course_areas" ("name", "sort") VALUES
  ('{"et":"Kulmukoolitused","ru":"Курсы по бровям"}', 1),
  ('{"et":"Ripsmekoolitused","ru":"Курсы по ресницам"}', 2);
