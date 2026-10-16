-- Migration 0026 enforced at-most-one admin via a unique partial index on
-- is_admin. That was overly strict: application code (isOwner model,
-- admin-guard, the promote/demote guards in users.ts) is designed to
-- support multiple non-owner admins, so that index makes promoting a
-- second admin throw an unhandled unique-violation in production.
--
-- The real invariant that needs a DB-level guarantee is "at most one
-- owner" (isOwner is permanent and set exactly once, at first-login
-- bootstrap, to resolve a race between two concurrent bootstrap attempts
-- both claiming to own the connected Plex server) -- not "at most one
-- admin". Retarget the index at is_owner instead of dropping it outright.
DROP INDEX IF EXISTS users_single_admin;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS users_single_owner
  ON users (is_owner) WHERE is_owner = true;
