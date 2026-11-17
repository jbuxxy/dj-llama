import { Cron } from 'croner'
import { envConfig } from '@/config/env'
import { isMaintenance } from '@/core/ops/maintenance'
import type { Database } from '@/db'
import { pruneJobRuns } from '@/db/queries/jobs'

const DAY_MS = 24 * 60 * 60 * 1000

// Nothing else ever deletes job_runs, and job history / health queries scan
// it, so it grows (and slows) forever without this.
export function startJobRetention(db: Database): Cron | null {
  const days = envConfig.jobRetentionDays
  if (!days || days <= 0) return null
  return new Cron('17 4 * * *', async () => {
    if (isMaintenance()) return
    try {
      const removed = await pruneJobRuns(db, new Date(Date.now() - days * DAY_MS))
      if (removed > 0)
        console.log(`[job-retention] pruned ${removed} job run(s) older than ${days}d`)
    } catch (err) {
      console.error('[job-retention] prune failed:', err)
    }
  })
}
