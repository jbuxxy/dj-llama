// Everything about a playlist strategy beyond "which artists": how it's
// generated, titled, pushed to Plex and reviewed, and where the Playlists
// page lists it. One record per strategy, so adding a strategy is one entry
// here (the Record type makes a missing one a compile error) instead of a
// branch in every file that cares. Pure data -- safe to import from the web
// bundle.

import type { PlaylistStrategy } from '@/db/schema'

export type StrategyPolicy = {
  /** 'import' mirrors an external playlist track by track; everything else generates. */
  generation: 'strategy' | 'import'
  /**
   * 'user' keeps the name the user gave it; 'evocative' gets a generated
   * phrase (Mediasage); 'daily-mix' gets "Daily Mix N" plus a genre subtitle.
   */
  titling: 'user' | 'evocative' | 'daily-mix'
  /** Gets a one-sentence generated description alongside the title. */
  describes: boolean
  /** Only tracks the user already owns, whatever the row's source settings say. */
  ownedTracksOnly: boolean
  /** Leaves Christmas/holiday titles out of an everyday mix. */
  excludesHolidayTracks: boolean
  /** Can't run without an AI provider configured. */
  requiresAi: boolean
  /**
   * After generating:
   * - 'always': push to Plex, replacing the previous version in place.
   * - 'never': wait for an explicit Push or Reject (no expiry).
   * - 'seasonal-window': push only while the seasonal toggle is on and the
   *   preset's window is open; the seasonal tick owns teardown.
   */
  autoPush: 'always' | 'never' | 'seasonal-window'
  /** An unpushed generation expires after the review window. */
  reviewExpires: boolean
  /**
   * Status for a newly created row. Seasonal starts as 'pending_review' so
   * the seasonal tick, which reads 'active' as "already generated this year",
   * doesn't skip it forever.
   */
  createdStatus?: 'pending_review'
  /** Which section of the Playlists page lists it. */
  section: 'daily-mix' | 'curated' | 'seasonal' | 'custom' | 'imported'
  /** Activity Center line while it runs. */
  runningMessage: string
}

const curated: StrategyPolicy = {
  generation: 'strategy',
  titling: 'user',
  describes: false,
  ownedTracksOnly: false,
  excludesHolidayTracks: false,
  requiresAi: false,
  autoPush: 'always',
  reviewExpires: true,
  section: 'curated',
  runningMessage: 'Picking tracks...',
}

export const STRATEGY_POLICIES: Record<PlaylistStrategy, StrategyPolicy> = {
  weekly_digest: curated,
  genre_focus: curated,
  mood_mix: curated,
  rediscover: curated,
  daily_mix: {
    ...curated,
    titling: 'daily-mix',
    ownedTracksOnly: true,
    excludesHolidayTracks: true,
    reviewExpires: false,
    section: 'daily-mix',
  },
  seasonal: {
    ...curated,
    autoPush: 'seasonal-window',
    reviewExpires: false,
    createdStatus: 'pending_review',
    section: 'seasonal',
  },
  ai_prompt: {
    ...curated,
    titling: 'evocative',
    describes: true,
    requiresAi: true,
    autoPush: 'never',
    reviewExpires: false,
    section: 'custom',
  },
  import: {
    ...curated,
    generation: 'import',
    section: 'imported',
    runningMessage: 'Importing tracks...',
  },
}

/** Policy for a stored strategy string; unknown values fall back to a custom playlist. */
export function strategyPolicy(strategy: string): StrategyPolicy {
  return (
    STRATEGY_POLICIES[strategy as PlaylistStrategy] ?? { ...curated, section: 'custom' as const }
  )
}
