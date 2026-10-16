CREATE TABLE "plex_scrobbles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"artist_name" text NOT NULL,
	"track_name" text NOT NULL,
	"played_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plex_scrobbles" ADD CONSTRAINT "plex_scrobbles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plex_scrobbles_user_played_at_idx" ON "plex_scrobbles" USING btree ("user_id","played_at");