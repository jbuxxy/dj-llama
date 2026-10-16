ALTER TABLE "recommendations" ADD COLUMN "library_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "library_confirmed_at" timestamp with time zone;