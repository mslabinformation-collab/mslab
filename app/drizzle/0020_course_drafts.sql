ALTER TABLE "course_modules" ADD COLUMN "unpublished" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_files" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "unpublished" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "video_progress" smallint;