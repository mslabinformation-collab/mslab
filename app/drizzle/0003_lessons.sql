CREATE TABLE "course_modules" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"position" integer NOT NULL,
	"title" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"lesson_id" integer NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"r2_key" text NOT NULL,
	"size" integer NOT NULL,
	"content_type" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_progress" (
	"client_id" integer NOT NULL,
	"lesson_id" integer NOT NULL,
	"watched_sec" integer DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"unlocked_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_progress_client_id_lesson_id_pk" PRIMARY KEY("client_id","lesson_id")
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" serial PRIMARY KEY NOT NULL,
	"module_id" integer NOT NULL,
	"position" integer NOT NULL,
	"title" jsonb NOT NULL,
	"body" jsonb,
	"kind" text DEFAULT 'video' NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"video_id" text,
	"video_status" text DEFAULT 'none' NOT NULL,
	"duration_sec" integer,
	"replaced_video_id" text,
	"video_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_files" ADD CONSTRAINT "lesson_files_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_module_id_course_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."course_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_modules_course" ON "course_modules" USING btree ("course_id","position");--> statement-breakpoint
CREATE INDEX "lesson_files_lesson" ON "lesson_files" USING btree ("lesson_id","position");--> statement-breakpoint
CREATE INDEX "lesson_progress_lesson" ON "lesson_progress" USING btree ("lesson_id");--> statement-breakpoint
CREATE INDEX "lessons_module" ON "lessons" USING btree ("module_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "lessons_video" ON "lessons" USING btree ("video_id");
--> statement-breakpoint
-- Data step (drizzle-kit does not generate it): copy every course's module titles into course_modules, in order. courses.modules stays (migration 0007 drops it after the 3a deploy).
INSERT INTO "course_modules" ("course_id", "position", "title")
SELECT c."id", m.ord::int, m.value
FROM "courses" c
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c."modules") = 'array' THEN c."modules" ELSE '[]'::jsonb END) WITH ORDINALITY AS m(value, ord);
