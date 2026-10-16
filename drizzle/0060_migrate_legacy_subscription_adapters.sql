-- Custom SQL migration file, put your code below! --

-- Consolidate legacy standalone subscription adapters that duplicated a
-- Discovery Mode (or, for lastfm-tag, duplicated the still-live 'genre'
-- adapter) onto their richer/shared equivalents. See
-- core/discovery-modes/modes/*.ts and core/subscriptions/adapters/*.ts.
-- Field names below were chosen to match 1:1 with each destination's
-- expected settings keys, so no further reshaping happens at read time.

-- lastfm-tag -> genre (still a direct adapter type). genre's lastfm path
-- already calls the same Last.fm tag.gettopartists endpoint, through the
-- shared client instead of lastfm-tag's hand-rolled fetch.
UPDATE subscriptions
SET
  source_type = 'genre',
  source_config = jsonb_build_object(
    'genre', source_config->>'tag',
    'providers', 'lastfm'
  )
WHERE source_type = 'lastfm-tag';
--> statement-breakpoint

-- lastfm-charts -> discovery-mode(charts)
UPDATE subscriptions
SET
  source_type = 'discovery-mode',
  source_config = jsonb_build_object(
    'modeId', 'charts',
    'settingsMode', 'advanced',
    'settings', jsonb_build_object('region', 'global'),
    'providerContext', '{}'::jsonb,
    'fallbackPolicy', 'allow-fallback'
  )
WHERE source_type = 'lastfm-charts';
--> statement-breakpoint

-- similar -> discovery-mode(similar-artist-web)
UPDATE subscriptions
SET
  source_type = 'discovery-mode',
  source_config = jsonb_build_object(
    'modeId', 'similar-artist-web',
    'settingsMode', 'advanced',
    'settings', jsonb_build_object('seedArtists', source_config->'seedArtists'),
    'providerContext', '{}'::jsonb,
    'fallbackPolicy', 'allow-fallback'
  )
WHERE source_type = 'similar';
--> statement-breakpoint

-- listenbrainz (feedType-specific) -> matching discovery mode
UPDATE subscriptions
SET
  source_type = 'discovery-mode',
  source_config = jsonb_build_object(
    'modeId', 'listenbrainz',
    'settingsMode', 'advanced',
    'settings', jsonb_build_object('feedType', 'weekly-jams'),
    'providerContext', '{}'::jsonb,
    'fallbackPolicy', 'allow-fallback'
  )
WHERE source_type = 'listenbrainz' AND source_config->>'feedType' = 'weekly-jams';
--> statement-breakpoint

UPDATE subscriptions
SET
  source_type = 'discovery-mode',
  source_config = jsonb_build_object(
    'modeId', 'lb-artist-radio',
    'settingsMode', 'advanced',
    'settings', jsonb_build_object(
      'seedArtistMbid', source_config->'seedArtistMbid',
      'adventurousness', COALESCE(source_config->'adventurousness', '"medium"'::jsonb)
    ),
    'providerContext', '{}'::jsonb,
    'fallbackPolicy', 'allow-fallback'
  )
WHERE source_type = 'listenbrainz' AND source_config->>'feedType' = 'artist-radio';
--> statement-breakpoint

UPDATE subscriptions
SET
  source_type = 'discovery-mode',
  source_config = jsonb_build_object(
    'modeId', 'similar-users-deep',
    'settingsMode', 'advanced',
    'settings', jsonb_build_object('maxUsers', COALESCE(source_config->'maxUsers', '3'::jsonb)),
    'providerContext', '{}'::jsonb,
    'fallbackPolicy', 'allow-fallback'
  )
WHERE source_type = 'listenbrainz' AND source_config->>'feedType' = 'similar-users';
--> statement-breakpoint

UPDATE subscriptions
SET
  source_type = 'discovery-mode',
  source_config = jsonb_build_object(
    'modeId', 'lb-tag-radio',
    'settingsMode', 'advanced',
    'settings', jsonb_build_object(
      'tags', COALESCE(source_config->'tags', '[]'::jsonb),
      'rawTagExpression', COALESCE(source_config->'rawTagExpression', '""'::jsonb),
      'count', COALESCE(source_config->'count', '25'::jsonb)
    ),
    'providerContext', '{}'::jsonb,
    'fallbackPolicy', 'allow-fallback'
  )
WHERE source_type = 'listenbrainz' AND source_config->>'feedType' = 'tag-radio';
--> statement-breakpoint

-- fresh-releases (also the adapter's own default when feedType was unset)
UPDATE subscriptions
SET
  source_type = 'discovery-mode',
  source_config = jsonb_build_object(
    'modeId', 'lb-fresh-releases',
    'settingsMode', 'advanced',
    'settings', '{}'::jsonb,
    'providerContext', '{}'::jsonb,
    'fallbackPolicy', 'allow-fallback'
  )
WHERE source_type = 'listenbrainz'
  AND (source_config->>'feedType' = 'fresh-releases' OR source_config->>'feedType' IS NULL);
--> statement-breakpoint

-- Safety net: any remaining listenbrainz row with an unrecognized feedType
-- (shouldn't happen -- the UI only ever wrote one of the five values above)
-- falls back to fresh-releases rather than being left pointing at a
-- source_type with no registered adapter.
UPDATE subscriptions
SET
  source_type = 'discovery-mode',
  source_config = jsonb_build_object(
    'modeId', 'lb-fresh-releases',
    'settingsMode', 'advanced',
    'settings', '{}'::jsonb,
    'providerContext', '{}'::jsonb,
    'fallbackPolicy', 'allow-fallback'
  )
WHERE source_type = 'listenbrainz';
