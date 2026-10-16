-- Playlist import's missing-track -> album resolutions were made by sampling
-- the top few MusicBrainz recording hits, which for a popular song are mostly
-- compilation copies, so many cached answers are a compilation or bootleg
-- instead of the original album. Clearing the cache makes every still-missing
-- track re-resolve once with searchTrackAlbums (core/search/track-albums.ts).
DELETE FROM "track_album_resolution_cache";
