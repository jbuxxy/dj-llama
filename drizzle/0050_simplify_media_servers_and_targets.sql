ALTER TABLE "settings" ADD COLUMN "slskd_url" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "slskd_api_key" text;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "jellyfin_url";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "jellyfin_api_key";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "jellyfin_user_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "jellyfin_library_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "emby_url";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "emby_api_key";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "emby_user_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "emby_library_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "subsonic_url";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "subsonic_username";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "subsonic_password";