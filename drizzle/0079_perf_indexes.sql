-- Performance indexes: lookups on shared (user_id null) Lidarr library rows,
-- the admin activity feed, job history ordering, and lower(artists.name).
-- The two GIN indexes already exist from 0029; IF NOT EXISTS makes them no-ops.
CREATE INDEX IF NOT EXISTS "artists_name_lower_idx" ON "artists" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artists_genres_gin_idx" ON "artists" USING gin ("genres");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artists_tags_gin_idx" ON "artists" USING gin ("tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_runs_started_at_idx" ON "job_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_runs_completed_at_idx" ON "job_runs" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_albums_album_mbid_idx" ON "library_albums" USING btree ("album_mbid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_albums_artist_mbid_idx" ON "library_albums" USING btree ("artist_mbid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_albums_source_artist_idx" ON "library_albums" USING btree ("source","source_artist_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_artists_source_mbid_idx" ON "library_artists" USING btree ("source","mbid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_artists_source_artist_idx" ON "library_artists" USING btree ("source","source_artist_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recommendations_acted_on_idx" ON "recommendations" USING btree ("acted_on_at");--> statement-breakpoint
-- Duplicate of job_runs_type_started_at_idx (0034); doubles write cost on every job update.
DROP INDEX IF EXISTS "idx_job_runs_type_started";
