CREATE TABLE "requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"requested_by_user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"artist_mbid" text NOT NULL,
	"artist_name" text NOT NULL,
	"release_group_mbid" text,
	"album_title" text,
	"cover_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"target_actions" jsonb,
	"rejection_reason" text,
	"decided_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auto_approve_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requests_requested_by_created_idx" ON "requests" USING btree ("requested_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "requests_status_created_idx" ON "requests" USING btree ("status","created_at");