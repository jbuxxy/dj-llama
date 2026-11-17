import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { createBackup, restoreBackup } from '@/core/ops/backup'
import { clearImageFailures } from '@/core/ops/hygiene'
import { MigrateBackendError, migrateBackend } from '@/core/ops/migrate-backend'
import type { BackupFile, OpsDb } from '@/core/ops/types'
import { getPendingMigrations } from '@/core/ops/upgrade'
import { waitForGenreWarmers } from '@/core/pipeline/genre-backfill'
import { logAndSanitize } from '@/core/validation'
import { resolveDbBackend } from '@/db/backend'
import { assertSafePglitePath, classifyTargetError, connectTarget } from '@/db/connect'
import type { Preferences } from '@/db/schema'
import { apiError, problem } from '@/server/helpers/problem'
import { setMaintenance } from '@/server/maintenance'
import { backupFileSchema } from '@/server/schemas/admin'
import { migrateRequestSchema, migrateTargetSchema } from '@/server/schemas/migrate'
import type { HonoEnv } from '@/server/types'
import { CHANNEL, GIT_SHA, VERSION } from '@/version'

export interface AdminDeps {
  db: OpsDb
  isPipelineRunning: () => boolean
  getUserById: (
    id: number,
  ) => Promise<{ isAdmin: boolean; preferences?: Partial<Preferences> | null } | null>
  getSettings: () => Promise<{ preferences?: Partial<Preferences> | null } | null>
}

// Single in-flight migration at a time. The route is exempt from the maintenance
// lock (so the operator can drive it), so this flag is what blocks a second
// concurrent migration POST. Single-process, same rationale as the rate limiters.
let migrationInProgress = false

export function adminRoutes(deps: AdminDeps) {
  const router = new Hono<HonoEnv>()

  router.post('/api/v1/admin/backup', async (c) => {
    const includeCaches = c.req.query('includeCaches') === 'true'
    const backup = includeCaches
      ? await deps.db.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level repeatable read read only`)
          return createBackup(tx, { includeCaches })
        })
      : await createBackup(deps.db, { includeCaches })
    const json = JSON.stringify(backup, null, 2)
    const timestamp = new Date().toISOString().slice(0, 10)
    const suffix = includeCaches ? '-full' : ''

    return new Response(json, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="djllama-backup-${timestamp}${suffix}.json"`,
      },
    })
  })

  // Dual-format (multipart + raw JSON) rules out zJson middleware; we parse
  // then validate with the same schema in-handler. Zod catches prototype
  // pollution, missing top-level keys, and non-array table payloads before
  // restoreBackup touches the DB.
  router.post('/api/v1/admin/restore', async (c) => {
    const force = c.req.query('force') === 'true'
    const confirm = c.req.query('confirm') === 'true'
    if (!confirm) {
      return apiError(
        c,
        400,
        'Restore overwrites existing data. Re-submit with ?confirm=true to acknowledge.',
        { code: 'confirmation_required' as const },
      )
    }
    const contentType = c.req.header('content-type') ?? ''

    let raw: unknown
    try {
      if (contentType.includes('multipart/form-data')) {
        const form = await c.req.formData()
        const file = form.get('file')
        if (!file || !(file instanceof File)) {
          return apiError(c, 400, 'No file provided')
        }
        const text = await file.text()
        raw = JSON.parse(text)
      } else {
        raw = await c.req.json()
      }
    } catch {
      return apiError(c, 400, 'Invalid backup file format')
    }

    const parsed = backupFileSchema.safeParse(raw)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      const where = first?.path.length ? first.path.join('.') : 'root'
      return apiError(
        c,
        400,
        `Invalid backup file structure at ${where}: ${first?.message ?? 'unknown'}`,
        {
          code: 'validation_failed' as const,
          details: parsed.error.issues.map((i) => ({
            path: i.path,
            code: i.code,
            message: i.message,
          })),
        },
      )
    }
    const backup: BackupFile = parsed.data as BackupFile

    let result: Awaited<ReturnType<typeof restoreBackup>>
    try {
      result = await restoreBackup(deps.db, backup, { force })
    } catch (err) {
      const message = logAndSanitize(err, 'admin-restore')
      return apiError(c, 500, `Restore failed (rolled back): ${message}`)
    }

    if (result.encryptionMismatch && !force) {
      return apiError(c, 409, 'Encryption key mismatch', {
        affectedFields: result.affectedEncryptedFields,
        hint: 'Add ?force=true to restore anyway. Encrypted fields will need re-entry.',
      })
    }

    return c.json(result)
  })

  // Everything the Administration > System card shows, in one call.
  router.get('/api/v1/admin/system', async (c) => {
    const status = await getPendingMigrations(deps.db)
    return c.json({
      version: VERSION,
      gitSha: GIT_SHA,
      channel: CHANNEL,
      dbBackend: resolveDbBackend(),
      schemaVersion: status.currentVersion,
      pendingMigrations: status.pendingCount,
      lastAutoBackup: status.lastAutoBackup,
    })
  })

  // ── Hygiene endpoints ─────────────────────────

  router.post('/api/v1/admin/hygiene/clear-image-failures', async (c) => {
    const olderThan = c.req.query('olderThan')
    let days: number | undefined
    if (olderThan) {
      const match = olderThan.match(/^(\d+)d$/)
      if (match?.[1]) days = Number.parseInt(match[1], 10)
    }
    const result = await clearImageFailures(deps.db, days)
    return c.json(result)
  })

  // For PGlite this is NON-DESTRUCTIVE: assertSafePglitePath validates containment
  // without creating the database file.
  router.post('/api/v1/admin/migrate-backend/test', async (c) => {
    const parsed = migrateTargetSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return apiError(c, 400, 'Invalid target', { details: parsed.error.issues })
    try {
      if (parsed.data.backend === 'pglite') {
        const abs = assertSafePglitePath(parsed.data.path)
        return c.json({ ok: true, backend: 'pglite', description: `PGlite file at ${abs}` })
      }
      const conn = await connectTarget(parsed.data)
      try {
        await conn.ping()
        return c.json({ ok: true, backend: 'postgres', description: conn.describe() })
      } finally {
        await conn.close()
      }
    } catch (err) {
      return apiError(c, 502, logAndSanitize(err, 'migrate-test'), {
        ok: false,
        code: classifyTargetError(err),
      })
    }
  })

  router.post('/api/v1/admin/migrate-backend', async (c) => {
    const parsed = migrateRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return problem(c, 'invalid-request', 'Invalid request', 400, undefined, {
        issues: parsed.error.issues,
      })
    if (deps.isPipelineRunning()) {
      return problem(
        c,
        'migration-pipeline-running',
        'A pipeline is running. Disable schedules and retry once idle.',
        409,
        undefined,
        undefined,
        'pipeline_running',
      )
    }
    if (migrationInProgress) {
      return problem(
        c,
        'migration-in-progress',
        'A migration is already in progress.',
        409,
        undefined,
        undefined,
        'migration_in_progress',
      )
    }
    migrationInProgress = true
    setMaintenance(true)
    try {
      await waitForGenreWarmers()
      const report = await migrateBackend({
        sourceDb: deps.db,
        target: parsed.data.target,
        overwrite: parsed.data.overwrite,
        isPipelineRunning: deps.isPipelineRunning,
      })
      // The MigrationReport body is returned ONLY on success. A verification
      // failure becomes a problem+json 422 carrying the report as an extension,
      // so a 422 never holds two incompatible shapes.
      if (!report.ok) {
        return problem(
          c,
          'migration-verify-failed',
          'Migration completed but verification failed.',
          422,
          'Row counts or content differ between source and target.',
          { report },
          'migration_verify_failed',
        )
      }
      return c.json(report)
    } catch (err) {
      if (err instanceof MigrateBackendError) {
        // Known precondition failure: tell the operator what to fix. These messages
        // carry no credentials, so they are safe to return verbatim.
        const status = err.code === 'encryption_mismatch' ? 422 : 409
        return problem(c, 'migration-failed', err.message, status, undefined, undefined, err.code)
      }
      return problem(c, 'migration-internal', logAndSanitize(err, 'migrate-backend'), 500)
    } finally {
      setMaintenance(false)
      migrationInProgress = false
    }
  })

  return router
}
