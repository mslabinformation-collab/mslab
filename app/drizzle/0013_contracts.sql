CREATE TABLE "contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"registration_id" integer,
	"access_id" integer,
	"course_id" integer,
	"client_id" integer,
	"payment_id" integer,
	"version" text NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"fields" jsonb NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"accepted_via" text NOT NULL,
	"sent_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "contract_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "contract_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_access_id_course_access_id_fk" FOREIGN KEY ("access_id") REFERENCES "public"."course_access"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contracts_registration" ON "contracts" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "contracts_access" ON "contracts" USING btree ("access_id");--> statement-breakpoint
CREATE INDEX "contracts_client" ON "contracts" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_current_registration" ON "contracts" USING btree ("registration_id") WHERE "contracts"."superseded_at" is null and "contracts"."registration_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_current_access" ON "contracts" USING btree ("access_id") WHERE "contracts"."superseded_at" is null and "contracts"."access_id" is not null;