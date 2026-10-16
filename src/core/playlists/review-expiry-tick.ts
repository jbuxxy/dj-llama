export type ExpiredReviewPlaylistState = {
  id: number
  name: string
}

export type ReviewExpiryTickDeps<T extends ExpiredReviewPlaylistState> = {
  getExpiredReviewPlaylists: () => Promise<T[]>
  removePlaylist: (playlist: T) => Promise<void>
  onRemoved?: (playlist: T) => void
  onRemoveFailed?: (playlist: T, error: unknown) => void
}

/**
 * Non-auto-added, auto-generated playlists (weekly_digest, mood_mix,
 * genre_focus, rediscover -- never ai_prompt or seasonal, which don't use
 * this mechanism at all) sit as `pending_review` for `reviewWindowDays`
 * before the user acts. This tick tears down whatever's left unreviewed
 * once that window lapses -- one shared daily tick rather than a per-row
 * timer, mirroring seasonal-tick.ts's shape.
 */
export async function tickReviewExpiry<T extends ExpiredReviewPlaylistState>(
  deps: ReviewExpiryTickDeps<T>,
): Promise<void> {
  const expired = await deps.getExpiredReviewPlaylists()

  for (const playlist of expired) {
    try {
      await deps.removePlaylist(playlist)
      deps.onRemoved?.(playlist)
    } catch (error) {
      deps.onRemoveFailed?.(playlist, error)
    }
  }
}
