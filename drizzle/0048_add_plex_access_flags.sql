ALTER TABLE "users" ADD COLUMN "has_music_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plex_access_revoked_at" timestamp with time zone;