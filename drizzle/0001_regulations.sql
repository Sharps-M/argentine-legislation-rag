CREATE TABLE "regulations" (
	"id" integer PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"number" text,
	"class" text,
	"issuing_body" text,
	"enacted_on" date,
	"gazette_number" integer,
	"gazette_date" date,
	"gazette_page" integer,
	"title" text,
	"topic" text,
	"summary" text,
	"notes" text,
	"original_text_url" text,
	"updated_text_url" text,
	"amended_by_count" integer DEFAULT 0 NOT NULL,
	"amends_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "regulations_type_idx" ON "regulations" USING btree ("type");--> statement-breakpoint
CREATE INDEX "regulations_enacted_on_idx" ON "regulations" USING btree ("enacted_on");