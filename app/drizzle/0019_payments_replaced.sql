ALTER TYPE "public"."payment_status" ADD VALUE 'replaced';--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "check_reason" text;