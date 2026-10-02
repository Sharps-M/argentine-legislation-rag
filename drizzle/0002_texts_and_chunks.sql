CREATE TABLE "chunks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chunks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"regulation_id" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"section" text NOT NULL,
	"label" text,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulation_texts" (
	"regulation_id" integer PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_regulation_id_regulations_id_fk" FOREIGN KEY ("regulation_id") REFERENCES "public"."regulations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulation_texts" ADD CONSTRAINT "regulation_texts_regulation_id_regulations_id_fk" FOREIGN KEY ("regulation_id") REFERENCES "public"."regulations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_regulation_ordinal_idx" ON "chunks" USING btree ("regulation_id","ordinal");