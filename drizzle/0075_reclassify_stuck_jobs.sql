-- Until now nothing closed out jobs that were running when DJ Llama restarted:
-- they sat as 'running' until the stuck detector relabelled them 'stuck',
-- which System Health then reported as a problem. Startup now marks those
-- 'interrupted' (core/jobs/recorder.ts markInterrupted). Every existing
-- 'stuck' row never finished, i.e. it was cut off the same way, so relabel the
-- backlog to match.
UPDATE "job_runs"
SET "status" = 'interrupted',
    "completed_at" = COALESCE("completed_at", "started_at"),
    "error" = COALESCE("error", 'DJ Llama restarted while this was running.')
WHERE "status" = 'stuck';
