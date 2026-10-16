import PQueue from 'p-queue'
import type { LidarrAlbum, LidarrArtist } from '@/core/clients/lidarr'
import type {
  HealthCheckId,
  HealthCheckItem,
  HealthCheckResult,
  HealthFixProgress,
  LibraryHealthState,
  LibraryStats,
} from '@/core/library/types'
import { errMsg } from '@/core/validation'

// Only the fields the genre-gap check reads; callers pass full artist rows.
type ArtistCacheEntry = {
  mbid: string
  genres: string[] | null
}

type HealthServiceDeps = {
  lidarrClient: {
    getArtists: () => Promise<LidarrArtist[]>
    getAlbums: (artistId: number) => Promise<LidarrAlbum[]>
    triggerCommand: (name: string, body?: Record<string, unknown>) => Promise<unknown>
    getRootFolders: () => Promise<Array<{ id: number; path: string; freeSpace: number }>>
  }
  artistCache: {
    getAll: () => Promise<ArtistCacheEntry[]>
  }
  stateStore?: {
    get: () => Promise<LibraryHealthState | null>
    markScanStarted: () => Promise<void>
    save: (input: {
      checks: HealthCheckResult[]
      lastCompletedAt: Date
      lastError: string | null
    }) => Promise<void>
  }
}

// Only problems worth acting on. Dropped (2026-10): duplicate artists (nearly
// always real, distinct same-name artists, and unfixable here), unmonitored
// artists (usually deliberate, and its fix monitored every one at once),
// image and Wikidata gaps (already filled by the image backfill and on-demand
// artist enrichment), and missing metadata (a subset of genre gaps with the
// same fix).
const CHECK_META: Record<
  HealthCheckId,
  { name: string; description: string; severity: 'info' | 'warning' | 'error'; fixable: boolean }
> = {
  'missing-albums': {
    name: 'Missing Album Files',
    description: 'Monitored albums that have no downloaded files yet.',
    severity: 'warning',
    fixable: true,
  },
  'genre-gaps': {
    name: 'Missing Genres',
    description: 'Artists with no genres, so recommendations and genre playlists skip them.',
    severity: 'warning',
    fixable: true,
  },
}

export class LibraryHealthService {
  private deps: HealthServiceDeps
  private cachedResults: HealthCheckResult[] | null = null
  private _scanning = false

  constructor(deps: HealthServiceDeps) {
    this.deps = deps
  }

  get scanning(): boolean {
    return this._scanning
  }

  // startScan - fire-and-forget, returns immediately

  startScan(): void {
    if (this._scanning) return
    this._scanning = true
    void this.deps.stateStore?.markScanStarted().catch((err) => {
      console.error('[library-health] failed to mark scan started:', err)
    })
    this.runChecks()
      .catch((err) => console.error('[library-health] scan failed:', err))
      .finally(() => {
        this._scanning = false
      })
  }

  async runChecks(): Promise<HealthCheckResult[]> {
    const [lidarrArtists, cachedArtists] = await Promise.all([
      this.deps.lidarrClient.getArtists(),
      this.deps.artistCache.getAll(),
    ])

    const cachedByMbid = new Map(cachedArtists.map((a) => [a.mbid, a]))

    const monitoredArtists = lidarrArtists.filter((a) => a.monitored)

    const results: HealthCheckResult[] = [
      await this.checkMissingAlbums(monitoredArtists),
      this.checkGenreGaps(lidarrArtists, cachedByMbid),
    ]

    this.cachedResults = results
    const lastCompletedAt = new Date()
    await this.deps.stateStore?.save({
      checks: results,
      lastCompletedAt,
      lastError: null,
    })
    return results
  }

  getLastResults(): HealthCheckResult[] | null {
    return this.cachedResults
  }

  async getState(): Promise<LibraryHealthState | null> {
    return (await this.deps.stateStore?.get()) ?? null
  }

  async fixCheck(checkId: HealthCheckId): Promise<HealthFixProgress> {
    const results = this.cachedResults
    const check = results?.find((r) => r.id === checkId)
    const items: HealthCheckItem[] = check?.items ?? []

    const progress: HealthFixProgress = {
      checkId,
      total: items.length,
      completed: 0,
      failed: 0,
      status: 'running',
      errors: [],
    }

    const queue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 })

    for (const item of items) {
      await queue.add(async () => {
        try {
          await this.applyFix(checkId, item)
          progress.completed++
        } catch (err: unknown) {
          progress.failed++
          progress.errors.push(`${item.artistName}: ${errMsg(err)}`)
        }
      })
    }

    await queue.onIdle()

    progress.status = progress.failed === 0 ? 'completed' : 'failed'
    return progress
  }

  async getStats(): Promise<LibraryStats> {
    const [lidarrArtists, rootFolders] = await Promise.all([
      this.deps.lidarrClient.getArtists(),
      this.deps.lidarrClient.getRootFolders(),
    ])

    const monitoredCount = lidarrArtists.filter((a) => a.monitored).length

    const genreCounts = new Map<string, number>()
    for (const artist of lidarrArtists) {
      for (const genre of artist.genres ?? []) {
        genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1)
      }
    }

    const genreDistribution = [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([genre, count]) => ({ genre, count }))

    return {
      totalArtists: lidarrArtists.length,
      totalAlbums: 0,
      monitoredArtists: monitoredCount,
      genreDistribution,
      rootFolders: rootFolders.map(({ path, freeSpace }) => ({ path, freeSpace })),
    }
  }

  // Private: individual checks

  private async checkMissingAlbums(monitoredArtists: LidarrArtist[]): Promise<HealthCheckResult> {
    const meta = CHECK_META['missing-albums']
    const items: HealthCheckItem[] = []

    // Rate-limit album fetches so we don't saturate the event loop or hammer Lidarr
    const queue = new PQueue({ concurrency: 2, interval: 200, intervalCap: 2 })

    for (const artist of monitoredArtists) {
      queue.add(async () => {
        try {
          const albums = await this.deps.lidarrClient.getAlbums(artist.id)
          const missingCount = albums.filter(
            (album) =>
              album.monitored &&
              (album.statistics?.trackFileCount ?? 0) === 0 &&
              (album.statistics?.trackCount ?? 0) > 0,
          ).length

          if (missingCount > 0) {
            items.push({
              artistId: artist.id,
              artistName: artist.artistName,
              mbid: artist.foreignArtistId,
              detail: `${missingCount} monitored album${missingCount === 1 ? '' : 's'} with no files`,
            })
          }
        } catch {
          // skip individual artist failures
        }
      })
    }

    await queue.onIdle()
    return { ...meta, id: 'missing-albums', count: items.length, items }
  }

  private checkGenreGaps(
    artists: LidarrArtist[],
    cachedByMbid: Map<string, ArtistCacheEntry>,
  ): HealthCheckResult {
    const meta = CHECK_META['genre-gaps']
    const items: HealthCheckItem[] = []

    for (const artist of artists) {
      const lidarrHasGenres = (artist.genres?.length ?? 0) > 0
      const cached = cachedByMbid.get(artist.foreignArtistId)
      const cacheHasGenres = (cached?.genres?.length ?? 0) > 0

      if (!lidarrHasGenres && !cacheHasGenres) {
        items.push({
          artistId: artist.id,
          artistName: artist.artistName,
          mbid: artist.foreignArtistId,
          detail: 'No genre tags',
        })
      }
    }

    return { ...meta, id: 'genre-gaps', count: items.length, items }
  }

  // Private: fix dispatch

  private async applyFix(checkId: HealthCheckId, item: HealthCheckItem): Promise<void> {
    switch (checkId) {
      case 'genre-gaps':
        await this.deps.lidarrClient.triggerCommand('RefreshArtist', { artistId: item.artistId })
        break

      case 'missing-albums':
        await this.deps.lidarrClient.triggerCommand('ArtistSearch', { artistId: item.artistId })
        break
    }
  }
}
