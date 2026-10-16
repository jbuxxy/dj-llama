ALTER TABLE "playlists" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "playlists" ADD COLUMN "pushed_to_plex" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "playlists" ADD COLUMN "review_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "playlists_status_review_expires_idx" ON "playlists" USING btree ("status","review_expires_at");