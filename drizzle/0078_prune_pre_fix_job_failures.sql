-- One-off cleanup. Before the Lidarr write throttle and the one-at-a-time
-- playlist queue shipped (2026-10-15 08:30 MT), bursts of concurrent adds
-- and playlist runs produced ~1,850 failed/interrupted jobs whose causes are
-- since fixed. They buried current problems in Job History, so drop them.
-- Successful runs, and everything after the fix, are kept.
DELETE FROM "job_runs"
WHERE "status" IN ('failed', 'interrupted', 'stuck')
  AND "started_at" < '2026-10-15 14:30:00+00';
