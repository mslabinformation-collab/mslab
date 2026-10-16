CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"prefix" text NOT NULL,
	"year" integer NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"registration_id" integer,
	"payment_id" integer,
	"course_id" integer,
	"client_id" integer,
	"status" text DEFAULT 'unpaid' NOT NULL,
	"amount_cents" integer NOT NULL,
	"vat_rate" integer,
	"line" jsonb NOT NULL,
	"seller" jsonb NOT NULL,
	"buyer" jsonb NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"paid_method" text,
	"paid_adds" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_note" text DEFAULT '' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_amount_positive" CHECK ("invoices"."amount_cents" > 0),
	CONSTRAINT "invoices_seq_positive" CHECK ("invoices"."seq" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "invoice_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_series" ON "invoices" USING btree ("prefix","year","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_payment" ON "invoices" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "invoices_registration" ON "invoices" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "invoices_client" ON "invoices" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "invoices_issued" ON "invoices" USING btree ("issued_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;