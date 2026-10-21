CREATE TABLE "content_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"entity_id" integer NOT NULL,
	"part" text NOT NULL,
	"value" jsonb NOT NULL,
	"base_version" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "content_drafts_entity_entity_id_part" ON "content_drafts" USING btree ("entity","entity_id","part");