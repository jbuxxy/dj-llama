CREATE TABLE "listening_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"rating_key" text,
	"artist_name" text NOT NULL,
	"track_name" text NOT NULL,
	"album_name" text,
	"duration_ms" integer,
	"listened_ms" integer,
	"completed" boolean DEFAULT true NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'webhook' NOT NULL,
	"played_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
INSERT INTO "listening_events" ("user_id", "artist_name", "track_name", "completed", "skipped", "source", "played_at")
SELECT "user_id", "artist_name", "track_name", true, false, 'webhook', "played_at" FROM "plex_scrobbles";--> statement-breakpoint
DROP TABLE "plex_scrobbles" CASCADE;--> statement-breakpoint
ALTER TABLE "listening_events" ADD CONSTRAINT "listening_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listening_events_user_played_at_idx" ON "listening_events" USING btree ("user_id","played_at");--> statement-breakpoint
CREATE INDEX "listening_events_user_rating_key_idx" ON "listening_events" USING btree ("user_id","rating_key");--> statement-breakpoint
CREATE UNIQUE INDEX "listening_events_user_key_played_uniq" ON "listening_events" USING btree ("user_id","rating_key","played_at");