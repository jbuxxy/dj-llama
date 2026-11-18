CREATE TABLE "plex_track_sonic" (
	"rating_key" text PRIMARY KEY NOT NULL,
	"loudness" real,
	"lra" real,
	"intro_sec" real,
	"outro_sec" real,
	"moods" text[] DEFAULT '{}'::text[] NOT NULL,
	"sonic_analyzed" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
