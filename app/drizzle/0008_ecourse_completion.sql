CREATE TABLE "course_tests" (
	"course_id" integer PRIMARY KEY NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pass_percent" integer DEFAULT 80 NOT NULL,
	"tries" integer DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_tests_pass_percent" CHECK ("course_tests"."pass_percent" between 1 and 100),
	CONSTRAINT "course_tests_tries" CHECK ("course_tests"."tries" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "practical_photos" (
	"id" serial PRIMARY KEY NOT NULL,
	"protocol_id" integer NOT NULL,
	"stage" integer NOT NULL,
	"round" integer NOT NULL,
	"key" text NOT NULL,
	"thumb_key" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"course_id" integer NOT NULL,
	"number" integer NOT NULL,
	"questions" jsonb NOT NULL,
	"answers" jsonb NOT NULL,
	"correct" integer NOT NULL,
	"total" integer NOT NULL,
	"status" text NOT NULL,
	"review" jsonb,
	"submitted_at" timestamp with time zone NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text
);
--> statement-breakpoint
ALTER TABLE "protocols" ALTER COLUMN "registration_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "course_access" ADD COLUMN "extra_tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "course_access" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protocols" ADD COLUMN "access_id" integer;--> statement-breakpoint
ALTER TABLE "protocols" ADD COLUMN "verdicts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "protocols" ADD COLUMN "round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "protocols" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protocols" ADD COLUMN "sent_round" integer;--> statement-breakpoint
ALTER TABLE "course_tests" ADD CONSTRAINT "course_tests_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practical_photos" ADD CONSTRAINT "practical_photos_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "practical_photos_protocol" ON "practical_photos" USING btree ("protocol_id","stage","round");--> statement-breakpoint
CREATE UNIQUE INDEX "test_attempts_number" ON "test_attempts" USING btree ("client_id","course_id","number");--> statement-breakpoint
CREATE INDEX "test_attempts_status" ON "test_attempts" USING btree ("status","submitted_at");--> statement-breakpoint
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_access_id_course_access_id_fk" FOREIGN KEY ("access_id") REFERENCES "public"."course_access"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "protocols_access" ON "protocols" USING btree ("access_id");--> statement-breakpoint
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_one_owner" CHECK (("protocols"."registration_id" is null) <> ("protocols"."access_id" is null));