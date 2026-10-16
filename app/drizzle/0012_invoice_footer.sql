ALTER TABLE "invoices" ADD COLUMN "footer" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_invoice" ON "payments" USING btree ("invoice_id");