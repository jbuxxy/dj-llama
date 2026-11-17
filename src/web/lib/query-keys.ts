// Hierarchical React Query keys. Related queries share a prefix, so one
// invalidation covers the whole group -- a new dashboard widget or request
// view keyed under its group refreshes with it, instead of needing to be
// added to every hand-written invalidation list.
//
//   invalidateQueries({ queryKey: queryKeys.requests.all })        -> every request view
//   invalidateQueries({ queryKey: queryKeys.recommendations.all }) -> Discover + Dashboard picks

export const queryKeys = {
  recommendations: {
    /** Every recommendation list: Discover's pages and counts, and the Dashboard widgets. */
    all: ['recommendations'] as const,
    /** One Discover page; `params` is the filter/page/decade selection. */
    list: (params: Record<string, unknown>) => ['recommendations', 'list', params],
    count: (status: 'all' | 'pending' | 'approved' | 'rejected') =>
      ['recommendations', 'count', status] as const,
  },
  dashboard: {
    /** Recommendation-backed widgets: today's pick and the approved list. */
    recs: ['recommendations', 'dashboard'] as const,
    pick: ['recommendations', 'dashboard', 'pick'] as const,
    approved: ['recommendations', 'dashboard', 'approved'] as const,
    activity: ['dashboard', 'activity'] as const,
    taste: ['dashboard', 'taste'] as const,
    genreCoverage: ['dashboard', 'genre-coverage'] as const,
    /** Listening-history widgets (Plex scrobbles). */
    listening: ['dashboard', 'listening'] as const,
    topArtists: (...params: unknown[]) => ['dashboard', 'listening', 'top-artists', ...params],
    recentTracks: (...params: unknown[]) => ['dashboard', 'listening', 'recent-tracks', ...params],
  },
  requests: {
    all: ['requests'] as const,
    /** The caller's own requests, in every view (Requests page tabs, Dashboard). */
    mine: (...params: unknown[]) => ['requests', 'mine', ...params],
    /** The Dashboard's recently-approved requests strip. */
    mineRecent: ['requests', 'mine', 'recent'] as const,
    pending: ['requests', 'pending'] as const,
  },
}
