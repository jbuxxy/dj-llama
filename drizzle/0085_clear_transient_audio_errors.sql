-- The first audio-analysis crawl hit Plex connection resets (ffmpeg I/O
-- errors, truncated excerpts) and stored them as permanent failures. Clear
-- them so the retrying analyzer picks those tracks up again.
DELETE FROM "track_features"
WHERE "error" LIKE 'ffmpeg exited%' OR "error" = 'Audio excerpt is too short to analyze';
