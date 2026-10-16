/**
 * Postgres error helpers used by the application layer.
 *
 * Keep this file tiny. It exists so the Plex bootstrap flow in
 * auth-plex.ts can detect the unique-partial-index collision that the
 * 0054_single_owner_partial_index migration installs (two concurrent
 * first-login attempts both racing to become the server owner) without
 * duplicating the predicate at each call site.
 */

/**
 * Detect a unique-violation on the `users_single_owner` partial index.
 *
 * The Postgres driver surfaces these with `code === '23505'` and
 * `constraint === 'users_single_owner'`. We check both so that unrelated
 * unique-violations (for example the `users_username_unique` constraint)
 * propagate as real errors.
 */
export function isSingleOwnerCollision(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const e = err as { code?: unknown; constraint?: unknown }
  return e.code === '23505' && e.constraint === 'users_single_owner'
}

/**
 * Detect a Postgres unique-violation (`23505`), optionally scoped to a specific
 * constraint/index name. Used as a race backstop when an app-level pre-check
 * (e.g. duplicate email) loses to a concurrent insert/update.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (err === null || typeof err !== 'object') return false
  const e = err as { code?: unknown; constraint?: unknown }
  if (e.code !== '23505') return false
  return constraint ? e.constraint === constraint : true
}
