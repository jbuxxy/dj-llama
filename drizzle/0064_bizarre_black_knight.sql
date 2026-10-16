ALTER TABLE "users" ADD COLUMN "taste_profile_cache" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "taste_profile_cached_at" timestamp with time zone;