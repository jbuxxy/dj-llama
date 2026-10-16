CREATE TABLE "playlist_missing_tracks" (
	"id" serial PRIMARY KEY NOT NULL,
	"playlist_id" integer NOT NULL,
	"artist_name" text NOT NULL,
	"track_name" text NOT NULL,
	"album_title" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlists" ADD COLUMN "auto_push_to_plex" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "playlists" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "playlist_missing_tracks" ADD CONSTRAINT "playlist_missing_tracks_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_missing_tracks_natural_key_idx" ON "playlist_missing_tracks" USING btree ("playlist_id","artist_name","track_name");--> statement-breakpoint
CREATE INDEX "playlist_missing_tracks_playlist_idx" ON "playlist_missing_tracks" USING btree ("playlist_id");