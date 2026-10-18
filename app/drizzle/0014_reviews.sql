CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"feedback_id" integer,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"name" text NOT NULL,
	"locale" text NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"decided_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "course_feedback" ALTER COLUMN "registration_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "course_feedback" ADD COLUMN "access_id" integer;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_feedback_id_course_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."course_feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_feedback" ON "reviews" USING btree ("feedback_id");--> statement-breakpoint
CREATE INDEX "reviews_course_status" ON "reviews" USING btree ("course_id","status","written_at" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "course_feedback" ADD CONSTRAINT "course_feedback_access_id_course_access_id_fk" FOREIGN KEY ("access_id") REFERENCES "public"."course_access"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_feedback_access" ON "course_feedback" USING btree ("access_id");--> statement-breakpoint
ALTER TABLE "course_feedback" ADD CONSTRAINT "course_feedback_one_target" CHECK (("course_feedback"."registration_id" is null) <> ("course_feedback"."access_id" is null));