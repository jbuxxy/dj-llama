ALTER TABLE "recommendations" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "outcome_plays" integer;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "outcome_skip_rate" real;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "learned_weights" jsonb;