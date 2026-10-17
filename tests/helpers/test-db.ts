import { randomBytes } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import * as schema from '@/db/schema'

// Real Postgres, not PGlite: every test file that provisions its own DB used
// to spin up an in-memory PGlite (WASM Postgres) instance from scratch, and
// running dozens of those in parallel across the full suite exhausted host
// memory. This connects to a shared instance instead (the same Postgres
// server the *arr stack uses) and isolates each call in its own throwaway
// database, dropped on close() -- parallel-safe without a new process per
// test. (A per-schema approach doesn't work here: some FK constraints in the
// migrations hardcode "public".<table>, so each test needs its own real
// database rather than just its own schema within a shared one.)
const DATABASE_URL = process.env.DATABASE_URL

function urlForDatabase(dbName: string): string {
  const url = new URL(DATABASE_URL as string)
  url.pathname = `/${dbName}`
  return url.toString()
}

export async function makeTestDb() {
  if (!DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Point it at a real Postgres instance (see .env.example) -- ' +
        'the test suite no longer spins up per-file PGlite instances.',
    )
  }

  const dbName = `test_${randomBytes(6).toString('hex')}`

  const admin = new pg.Pool({ connectionString: DATABASE_URL })
  await admin.query(`CREATE DATABASE "${dbName}"`)
  await admin.end()

  const pool = new pg.Pool({ connectionString: urlForDatabase(dbName) })
  // close()'s DROP DATABASE ... WITH (FORCE) terminates any connection still
  // shutting down: the client emits 57P01, then "Connection terminated
  // unexpectedly". With no 'error' listener that becomes an uncaught
  // exception, which fails the whole vitest run even though every test passed
  // -- it hit about half of CI runs, depending on timing. Swallow connection
  // errors once close() has begun; before that they still surface.
  let closing = false
  const ignoreWhileClosing = (err: Error) => {
    if (!closing) throw err
  }
  pool.on('error', ignoreWhileClosing)
  pool.on('connect', (client) => client.on('error', ignoreWhileClosing))
  const db = drizzle(pool, { schema })
  await migrate(db, { migrationsFolder: './drizzle' })

  return {
    db,
    close: async () => {
      closing = true
      await pool.end()
      const cleanup = new pg.Pool({ connectionString: DATABASE_URL })
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
      await cleanup.end()
    },
  }
}
