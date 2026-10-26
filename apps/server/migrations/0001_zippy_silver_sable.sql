-- Empty-only cutover. The exclusive lock also fences an old writer that began
-- before migration: it either commits first and causes refusal, or fails after
-- the table is retired. This guard and all DDL run in Drizzle's transaction.
LOCK TABLE "workspace_state" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "workspace_state") THEN
    RAISE EXCEPTION 'Relational cutover refused: workspace_state contains persisted records. Stop old writers and preserve the database; no reset or backfill is authorized.';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "workspace_check_ins" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"position" bigint NOT NULL,
	"date" date NOT NULL,
	"body_weight" double precision,
	"waist" double precision,
	"sleep_hours" double precision,
	"energy" integer,
	"soreness" integer,
	"boxing_quality" integer,
	"notes" text NOT NULL,
	CONSTRAINT "workspace_check_ins_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "workspace_food_entries" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"position" bigint NOT NULL,
	"date" date NOT NULL,
	"slot" text NOT NULL,
	"name" text NOT NULL,
	"calories" double precision NOT NULL,
	"protein" double precision NOT NULL,
	"carbs" double precision NOT NULL,
	"fat" double precision NOT NULL,
	"servings" double precision NOT NULL,
	"recipe_id" text,
	"plan_entry_id" text,
	"created_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "workspace_food_entries_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "workspace_food_entries_one_plan" UNIQUE("user_id","plan_entry_id"),
	CONSTRAINT "workspace_food_entries_servings" CHECK ("workspace_food_entries"."servings" between 0.05 and 100),
	CONSTRAINT "workspace_food_entries_slot" CHECK ("workspace_food_entries"."slot" in ('breakfast', 'lunch', 'dinner', 'snack', 'fuel')),
	CONSTRAINT "workspace_food_entries_nutrition" CHECK ("workspace_food_entries"."calories" between 0 and 10000 and "workspace_food_entries"."protein" between 0 and 1500 and "workspace_food_entries"."carbs" between 0 and 2500 and "workspace_food_entries"."fat" between 0 and 1500)
);
--> statement-breakpoint
CREATE TABLE "workspace_grocery_checks" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"position" bigint NOT NULL,
	"checked" boolean DEFAULT true NOT NULL,
	CONSTRAINT "workspace_grocery_checks_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "workspace_planned_meals" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"position" bigint NOT NULL,
	"date" date NOT NULL,
	"slot" text NOT NULL,
	"recipe_id" text NOT NULL,
	"servings" double precision NOT NULL,
	CONSTRAINT "workspace_planned_meals_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "workspace_planned_meals_servings" CHECK ("workspace_planned_meals"."servings" between 0.05 and 100),
	CONSTRAINT "workspace_planned_meals_slot" CHECK ("workspace_planned_meals"."slot" in ('breakfast', 'lunch', 'dinner', 'snack', 'fuel'))
);
--> statement-breakpoint
CREATE TABLE "workspace_recipe_requests" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"position" bigint NOT NULL,
	"prompt" text NOT NULL,
	"calories" double precision NOT NULL,
	"protein" double precision NOT NULL,
	"max_minutes" double precision NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"recipe_id" text,
	CONSTRAINT "workspace_recipe_requests_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "workspace_recipes" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"position" bigint NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"favorite" boolean NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"calories" double precision NOT NULL,
	"protein" double precision NOT NULL,
	"carbs" double precision NOT NULL,
	"fat" double precision NOT NULL,
	"content" jsonb NOT NULL,
	CONSTRAINT "workspace_recipes_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "workspace_recipes_category" CHECK ("workspace_recipes"."category" in ('breakfast', 'main', 'snack')),
	CONSTRAINT "workspace_recipes_nutrition" CHECK ("workspace_recipes"."calories" between 0 and 10000 and "workspace_recipes"."protein" between 0 and 1500 and "workspace_recipes"."carbs" between 0 and 2500 and "workspace_recipes"."fat" between 0 and 1500)
);
--> statement-breakpoint
CREATE TABLE "workspace_scheduled_dates" (
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"position" bigint NOT NULL,
	CONSTRAINT "workspace_scheduled_dates_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "workspace_training_requests" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"position" bigint NOT NULL,
	"prompt" text NOT NULL,
	"date" date NOT NULL,
	"session_id" text,
	"status" text NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "workspace_training_requests_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "workspace_training_reviews" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"position" bigint NOT NULL,
	"request_id" text,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"status" text NOT NULL,
	"changes" jsonb NOT NULL,
	CONSTRAINT "workspace_training_reviews_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "workspace_workout_exercises" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"session_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"load_type" text NOT NULL,
	"target_sets" integer NOT NULL,
	"rep_min" integer NOT NULL,
	"rep_max" integer NOT NULL,
	"target_rir" double precision,
	"rest_seconds" integer NOT NULL,
	"notes" text NOT NULL,
	"catalog_id" text,
	"target_weight" double precision,
	"target_unit" text,
	CONSTRAINT "workspace_workout_exercises_user_id_session_id_id_pk" PRIMARY KEY("user_id","session_id","id"),
	CONSTRAINT "workspace_workout_exercises_target" CHECK ("workspace_workout_exercises"."target_sets" between 1 and 20 and "workspace_workout_exercises"."rep_min" between 1 and 200 and "workspace_workout_exercises"."rep_max" between "workspace_workout_exercises"."rep_min" and 200 and "workspace_workout_exercises"."rest_seconds" between 0 and 900),
	CONSTRAINT "workspace_workout_exercises_load" CHECK ("workspace_workout_exercises"."load_type" in ('total', 'per_hand', 'bodyweight', 'assistance') and ("workspace_workout_exercises"."target_weight" is null) = ("workspace_workout_exercises"."target_unit" is null) and ("workspace_workout_exercises"."target_unit" is null or "workspace_workout_exercises"."target_unit" in ('lb', 'kg')))
);
--> statement-breakpoint
CREATE TABLE "workspace_workout_sessions" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"position" bigint NOT NULL,
	"template_id" text,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"unit" text NOT NULL,
	"planned_minutes" integer NOT NULL,
	"duration_minutes" double precision,
	"rounds" integer,
	"session_rpe" double precision,
	"readiness" integer,
	"notes" text NOT NULL,
	"change_reason" text NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "workspace_workout_sessions_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "workspace_workout_sessions_status" CHECK ("workspace_workout_sessions"."status" in ('planned', 'in_progress', 'completed', 'skipped')),
	CONSTRAINT "workspace_workout_sessions_unit" CHECK ("workspace_workout_sessions"."unit" in ('lb', 'kg')),
	CONSTRAINT "workspace_workout_sessions_kind" CHECK ("workspace_workout_sessions"."kind" in ('strength', 'boxing', 'conditioning', 'recovery'))
);
--> statement-breakpoint
CREATE TABLE "workspace_workout_sets" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"session_id" text NOT NULL,
	"exercise_id" text NOT NULL,
	"position" integer NOT NULL,
	"weight" double precision,
	"reps" integer,
	"rir" double precision,
	"completed" boolean NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "workspace_workout_sets_user_id_session_id_exercise_id_id_pk" PRIMARY KEY("user_id","session_id","exercise_id","id"),
	CONSTRAINT "workspace_workout_sets_values" CHECK (("workspace_workout_sets"."weight" is null or "workspace_workout_sets"."weight" between 0 and 2000) and ("workspace_workout_sets"."reps" is null or "workspace_workout_sets"."reps" between 0 and 500) and ("workspace_workout_sets"."rir" is null or "workspace_workout_sets"."rir" between 0 and 10)),
	CONSTRAINT "workspace_workout_sets_completed" CHECK (not "workspace_workout_sets"."completed" or ("workspace_workout_sets"."reps" is not null and "workspace_workout_sets"."reps" >= 1)),
	CONSTRAINT "workspace_workout_sets_kind" CHECK ("workspace_workout_sets"."kind" in ('working', 'warmup'))
);
--> statement-breakpoint
CREATE TABLE "workspace_workout_templates" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"position" bigint NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"exercises" jsonb NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "workspace_workout_templates_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "workspace_metadata" (
	"user_id" text PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"next_position" bigint DEFAULT 0 NOT NULL,
	"timezone" text NOT NULL,
	"settings" jsonb NOT NULL
);
--> statement-breakpoint
DROP TABLE "workspace_state";--> statement-breakpoint
ALTER TABLE "workspace_check_ins" ADD CONSTRAINT "workspace_check_ins_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_food_entries" ADD CONSTRAINT "workspace_food_entries_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_grocery_checks" ADD CONSTRAINT "workspace_grocery_checks_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_planned_meals" ADD CONSTRAINT "workspace_planned_meals_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_planned_meals" ADD CONSTRAINT "workspace_planned_meals_user_id_recipe_id_workspace_recipes_user_id_id_fk" FOREIGN KEY ("user_id","recipe_id") REFERENCES "workspace_recipes"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_recipe_requests" ADD CONSTRAINT "workspace_recipe_requests_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_recipes" ADD CONSTRAINT "workspace_recipes_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_scheduled_dates" ADD CONSTRAINT "workspace_scheduled_dates_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_training_requests" ADD CONSTRAINT "workspace_training_requests_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_training_reviews" ADD CONSTRAINT "workspace_training_reviews_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_workout_exercises" ADD CONSTRAINT "workspace_workout_exercises_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_workout_exercises" ADD CONSTRAINT "workspace_workout_exercises_user_id_session_id_workspace_workout_sessions_user_id_id_fk" FOREIGN KEY ("user_id","session_id") REFERENCES "workspace_workout_sessions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_workout_sessions" ADD CONSTRAINT "workspace_workout_sessions_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_workout_sets" ADD CONSTRAINT "workspace_workout_sets_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_workout_sets" ADD CONSTRAINT "workspace_workout_sets_user_id_session_id_exercise_id_workspace_workout_exercises_user_id_session_id_id_fk" FOREIGN KEY ("user_id","session_id","exercise_id") REFERENCES "workspace_workout_exercises"("user_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_workout_templates" ADD CONSTRAINT "workspace_workout_templates_user_id_workspace_metadata_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_metadata"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_check_ins_date" ON "workspace_check_ins" USING btree ("user_id","date","position","id");--> statement-breakpoint
CREATE INDEX "workspace_food_entries_date" ON "workspace_food_entries" USING btree ("user_id","date","position","id");--> statement-breakpoint
CREATE INDEX "workspace_planned_meals_date" ON "workspace_planned_meals" USING btree ("user_id","date","position","id");--> statement-breakpoint
CREATE INDEX "workspace_recipes_library" ON "workspace_recipes" USING btree ("user_id","position","id");--> statement-breakpoint
CREATE INDEX "workspace_workout_exercises_history" ON "workspace_workout_exercises" USING btree ("user_id","name","session_id");--> statement-breakpoint
CREATE INDEX "workspace_workout_sessions_date" ON "workspace_workout_sessions" USING btree ("user_id","date","position","id");