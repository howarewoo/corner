CREATE TABLE "delegation_issuer" (
	"origin" text PRIMARY KEY NOT NULL,
	"cookie_key" text NOT NULL,
	"signing_jwk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegation_objects" (
	"model" text NOT NULL,
	"id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"grant_id" text,
	"owner_id" text,
	"client_id" text,
	"managed_session_id" text,
	"managed_session_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "delegation_objects_model_id_pk" PRIMARY KEY("model","id")
);
--> statement-breakpoint
CREATE INDEX "delegation_objects_grant_idx" ON "delegation_objects" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "delegation_objects_owner_model_idx" ON "delegation_objects" USING btree ("owner_id","model");--> statement-breakpoint
CREATE INDEX "delegation_objects_client_idx" ON "delegation_objects" USING btree ("client_id");