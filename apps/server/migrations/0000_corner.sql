CREATE TABLE "corner_ai_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"prompt" text NOT NULL,
	"reference_date" text NOT NULL,
	"base_revision" bigint NOT NULL,
	"result" text,
	"error" text,
	"error_code" text,
	"error_status" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "corner_ai_runs_user_id_kind_request_id_key" UNIQUE("user_id","kind","request_id")
);
--> statement-breakpoint
CREATE TABLE "mutation_receipts" (
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"revision" bigint NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "mutation_receipts_pkey" PRIMARY KEY("user_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "corner_subscription_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"encrypted" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"refresh_owner" text,
	"refresh_until" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corner_subscription_attempts" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_hash" text NOT NULL,
	"encrypted" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corner_subscription_generations" (
	"user_id" text PRIMARY KEY NOT NULL,
	"generation" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corner_subscription_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"data" text NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "corner_ai_runs_owner" ON "corner_ai_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "mutation_receipts_user_revision" ON "mutation_receipts" USING btree ("user_id","revision");--> statement-breakpoint
CREATE INDEX "corner_subscription_attempt_owner" ON "corner_subscription_attempts" USING btree ("user_id");