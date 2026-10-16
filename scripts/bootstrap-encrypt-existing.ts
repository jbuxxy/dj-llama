#!/usr/bin/env bun

/**
 * One-time pass to encrypt secrets that were written before
 * DJLLAMA_ENCRYPTION_KEY was ever set. `rotate-encryption-key.ts` only
 * touches rows already prefixed `enc:v1:`, so it can't help here -- there is
 * no existing ciphertext to rotate, only plaintext that has never been
 * encrypted. Safe to re-run: encryptField no-ops on values already prefixed.
 *
 * Usage: bun scripts/bootstrap-encrypt-existing.ts
 */

import { sql } from 'drizzle-orm'
import { envConfig } from '../src/config/env'
import { encryptField, initEncryption } from '../src/core/crypto'
import { closeDb, db, dbBackend } from '../src/db'
import { COLUMN_SITES, NESTED_SITES } from './rotation-sites'

initEncryption(envConfig.encryptionKey, envConfig.encryptionKeyNext)

if (!envConfig.encryptionKey) {
  console.error('DJLLAMA_ENCRYPTION_KEY must be set to bootstrap-encrypt existing data')
  process.exit(1)
}
console.log(`using ${dbBackend} backend`)

type Result = { scanned: number; encrypted: number }

async function encryptColumn(table: string, column: string): Promise<Result> {
  const rows = (
    await db.execute(
      sql.raw(
        `SELECT id, "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" NOT LIKE 'enc:v1:%'`,
      ),
    )
  ).rows as Array<{ id: number; v: string }>
  let encrypted = 0
  for (const row of rows) {
    const enc = encryptField(row.v)
    if (enc !== row.v) {
      await db.execute(
        sql`UPDATE ${sql.identifier(table)}
            SET ${sql.identifier(column)} = ${enc}
            WHERE id = ${row.id}`,
      )
      encrypted++
    }
  }
  return { scanned: rows.length, encrypted }
}

async function encryptNested(site: { table: string; column: string; path: string[] }) {
  const rows = (
    await db.execute(
      sql.raw(
        `SELECT id, "${site.column}" AS blob FROM "${site.table}" WHERE "${site.column}" IS NOT NULL`,
      ),
    )
  ).rows as Array<{ id: number; blob: Record<string, unknown> | null }>
  let encrypted = 0
  for (const row of rows) {
    if (!row.blob || typeof row.blob !== 'object') continue
    const leaf = site.path[site.path.length - 1]
    if (!leaf) continue
    const v = row.blob[leaf]
    if (typeof v !== 'string' || v.startsWith('enc:v1:')) continue
    row.blob[leaf] = encryptField(v)
    await db.execute(
      sql`UPDATE ${sql.identifier(site.table)}
          SET ${sql.identifier(site.column)} = ${row.blob}
          WHERE id = ${row.id}`,
    )
    encrypted++
  }
  return { scanned: rows.length, encrypted }
}

// targets.config is an untyped jsonb blob (no fixed shape). Heuristically
// encrypt string values under keys that look like secrets -- matches the
// same key names the app itself writes when creating/updating a target.
const SECRET_KEY_PATTERN = /apikey|password|token|secret/i

async function encryptTargetsConfig(): Promise<Result> {
  const rows = (await db.execute(sql`SELECT id, config FROM targets`)).rows as Array<{
    id: number
    config: Record<string, unknown> | null
  }>
  let encrypted = 0
  for (const row of rows) {
    if (!row.config || typeof row.config !== 'object') continue
    let changed = false
    const next: Record<string, unknown> = { ...row.config }
    for (const [k, v] of Object.entries(row.config)) {
      if (typeof v === 'string' && !v.startsWith('enc:v1:') && SECRET_KEY_PATTERN.test(k)) {
        next[k] = encryptField(v)
        changed = true
      }
    }
    if (changed) {
      await db.execute(sql`UPDATE targets SET config = ${next} WHERE id = ${row.id}`)
      encrypted++
    }
  }
  return { scanned: rows.length, encrypted }
}

async function main(): Promise<void> {
  let totalScanned = 0
  let totalEncrypted = 0
  for (const site of COLUMN_SITES) {
    process.stdout.write(`${site.table}.${site.column} ... `)
    const { scanned, encrypted } = await encryptColumn(site.table, site.column)
    console.log(`${scanned} plaintext, ${encrypted} encrypted`)
    totalScanned += scanned
    totalEncrypted += encrypted
  }
  for (const site of NESTED_SITES) {
    const label = `${site.table}.${site.column}.${site.path.join('.')}`
    process.stdout.write(`${label} ... `)
    const { scanned, encrypted } = await encryptNested(site)
    console.log(`${scanned} rows checked, ${encrypted} encrypted`)
    totalScanned += scanned
    totalEncrypted += encrypted
  }
  process.stdout.write('targets.config ... ')
  const { scanned, encrypted } = await encryptTargetsConfig()
  console.log(`${scanned} rows checked, ${encrypted} encrypted`)
  totalScanned += scanned
  totalEncrypted += encrypted

  console.log(`\nDone. ${totalEncrypted} value(s) encrypted across ${totalScanned} row(s) checked.`)
  await closeDb()
}

main().catch(async (err) => {
  console.error(err)
  await closeDb()
  process.exit(1)
})
