CREATE TABLE "track_features" (
	"rating_key" text PRIMARY KEY NOT NULL,
	"part_key" text NOT NULL,
	"bpm" real,
	"bpm_confidence" real,
	"camelot" text,
	"key_name" text,
	"key_confidence" real,
	"energy" real,
	"duration_ms" integer,
	"error" text,
	"analyzed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD COLUMN "rating_key" text;