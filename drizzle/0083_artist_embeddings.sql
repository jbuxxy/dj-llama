CREATE TABLE "artist_embeddings" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"mbid" uuid,
	"model" text NOT NULL,
	"vector" real[] NOT NULL,
	"text_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
