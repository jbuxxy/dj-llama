-- The subscriptions feature was removed, so nothing records 'subscription'
-- jobs any more. Its leftover runs (all failed) only cluttered Job History.
DELETE FROM "job_runs" WHERE "type" = 'subscription';
