ALTER TABLE "settings" ADD COLUMN "plex_admin_url" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "plex_admin_token" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "plex_machine_identifier" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "plex_music_section_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plex_account_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "users_plex_account_id_unique_idx" ON "users" USING btree ("plex_account_id") WHERE "users"."plex_account_id" IS NOT NULL;