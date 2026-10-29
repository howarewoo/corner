CREATE TABLE "workspace_import_sources" (
	"user_id" text NOT NULL,
	"source_namespace" text NOT NULL,
	"record_type" text NOT NULL,
	"source_record_id" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"destination_id" text NOT NULL,
	"position" bigint NOT NULL,
	CONSTRAINT "workspace_import_sources_identity" PRIMARY KEY("user_id","source_namespace","record_type","source_record_id"),
	CONSTRAINT "workspace_import_sources_destination" UNIQUE("user_id","record_type","destination_id")
);
--> statement-breakpoint
ALTER TABLE "mutation_receipts" ADD COLUMN "import_outcomes" jsonb;--> statement-breakpoint
ALTER TABLE "workspace_import_sources" ADD CONSTRAINT "workspace_import_sources_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_import_sources_export" ON "workspace_import_sources" USING btree ("user_id","position");