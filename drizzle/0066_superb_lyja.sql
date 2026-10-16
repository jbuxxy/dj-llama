CREATE TABLE "track_album_resolution_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"artist_name" text NOT NULL,
	"track_name" text NOT NULL,
	"release_group_mbid" uuid,
	"album_title" text,
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "track_album_resolution_cache_key_idx" ON "track_album_resolution_cache" USING btree ("artist_name","track_name");