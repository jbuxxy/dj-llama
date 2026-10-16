DROP INDEX "users_oidc_subject_unique_idx";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "oidc_issuer_url";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "oidc_client_id";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "oidc_client_secret";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "oidc_scopes";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "tidal_client_id";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "tidal_client_secret";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "oidc_subject";