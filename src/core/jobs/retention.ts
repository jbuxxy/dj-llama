import { Cron } from 'croner'
import { envConfig } from '@/config/env'
import { isMaintenance } from '@/core/ops/maintenance'
import type { Database } from '@/db'
import { pruneJobRuns } from '@/db/queries/jobs'
import { pruneListeningEvents } from '@/db/queries/listening-events'

const DAY_MS = 24 * 60 * 60 * 1000

// Nothing else ever deletes job_runs or listening_events, and job history /
// health / taste queries scan them, so they grow (and slow) forever without
// this. Each window is env-configurable; 0 disables that prune.
export function startJobRetention(db: Database): Cron | null {
  const jobDays = envConfig.jobRetentionDays
  const listenDays = envConfig.listeningRetentionDays
  if (!(jobDays > 0) && !(listenDays > 0)) return null
  return new Cron('17 4 * * *', async () => {
    if (isMaintenance()) return
    await prune('job run', jobDays, (before) => pruneJobRuns(db, before))
    await prune('listening event', listenDays, (before) => pruneListeningEvents(db, before))
  })
}

async function prune(label: string, days: number, run: (before: Date) => Promise<number>) {
  if (!(days > 0)) return
  try {
    const removed = await run(new Date(Date.now() - days * DAY_MS))
    if (removed > 0) console.log(`[retention] pruned ${removed} ${label}(s) older than ${days}d`)
  } catch (err) {
    console.error(`[retention] ${label} prune failed:`, err)
  }
}
