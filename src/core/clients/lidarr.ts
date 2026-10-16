import type { ServiceTestResult } from '@/core/types'
import { errMsg } from '@/core/validation'
import { createHttpClient, HttpError } from './http'

export type LidarrArtist = {
  id: number
  artistName: string
  foreignArtistId: string // This is the MBID
  qualityProfileId: number
  rootFolderPath: string
  monitored: boolean
  status: string
  genres?: string[]
  // Only ever populated on lookupArtist()'s raw pass-through response
  // (getArtists() strips it to save memory on large libraries).
  images?: { coverType: string; url: string }[]
  // Also lookupArtist()-only: MusicBrainz's community vote count/average,
  // the only popularity signal this endpoint exposes. Used to rank search
  // results (see rankSearchResults in requests.ts).
  ratings?: { votes: number; value: number }
}

export type QualityProfile = {
  id: number
  name: string
}

export type MetadataProfile = {
  id: number
  name: string
}

export type RootFolder = {
  id: number
  path: string
  freeSpace: number
}

export type LidarrAlbum = {
  id: number
  title: string
  artistId: number
  foreignAlbumId: string // MBID
  monitored: boolean
  albumType: string
  // e.g. ["Compilation"], ["Live"] -- mirrors MusicBrainz's release-group
  // secondary types (Lidarr's metadata is MB-sourced), used to apply the
  // same Album > Compilation > EP > Single > Live preference (see
  // pickBestReleaseGroup) directly against an artist's real Lidarr albums.
  secondaryTypes?: string[]
  statistics?: {
    trackCount: number
    trackFileCount: number
    percentOfTracks: number
  }
}

export type LidarrAlbumLookupResult = {
  title: string
  disambiguation?: string
  foreignAlbumId: string // release-group MBID
  releaseDate?: string
  albumType?: string
  images: { coverType: string; url: string }[]
  // MusicBrainz community vote count/average -- see LidarrArtist.ratings.
  ratings?: { votes: number; value: number }
  artist?: {
    artistName: string
    foreignArtistId: string // artist MBID
  }
}

export type LidarrTrack = {
  id: number
  title: string
  albumId: number
  hasFile: boolean
}

export type LidarrWantedMissing = {
  id: number
  title: string
  artistId?: number
  foreignAlbumId?: string
  artist?: {
    id?: number
    artistName?: string
    foreignArtistId?: string
  }
  artistName?: string
  foreignArtistId?: string
}

export type LidarrCommand = {
  id: number
  name: string
  status: string
}

export type AddArtistOptions = {
  monitorOption?: 'all' | 'new' | 'none'
}

// Strip to only the fields we need - Lidarr album responses include full
// track lists, images, and other metadata we don't use.
function toLidarrAlbum(a: Record<string, unknown>): LidarrAlbum {
  return {
    id: a.id as number,
    title: a.title as string,
    artistId: a.artistId as number,
    foreignAlbumId: a.foreignAlbumId as string,
    monitored: a.monitored as boolean,
    albumType: a.albumType as string,
    secondaryTypes: a.secondaryTypes as string[] | undefined,
    statistics:
      a.statistics != null
        ? (a.statistics as {
            trackCount: number
            trackFileCount: number
            percentOfTracks: number
          })
        : undefined,
  }
}

// Lidarr's add validators (ArtistExistsValidator, AlbumExistsValidator) all
// answer a duplicate add with a 400 carrying this message.
function isAlreadyAdded(err: unknown): boolean {
  return err instanceof HttpError && err.status === 400 && err.body.includes('already been added')
}

export function createLidarrClient(url: string, apiKey: string, skipTlsVerify = false) {
  const http = createHttpClient({
    baseUrl: url,
    headers: { 'X-Api-Key': apiKey },
    skipTlsVerify,
  })

  // Caches to avoid repeated API calls within a client instance.
  let rootFolderCache: RootFolder[] | null = null
  let qualityProfileCache: QualityProfile[] | null = null
  let metadataProfileCache: MetadataProfile[] | null = null

  async function getArtists(): Promise<LidarrArtist[]> {
    // Full-library fetch (images, statistics, albums, links, ratings, etc.
    // per artist before the strip below) -- on a large library this is slow
    // enough, especially with Lidarr already busy handling other adds/
    // searches, to blow the client's normal 10s timeout the same way the
    // metadata lookups above did (see METADATA_LOOKUP_TIMEOUT_MS). addAlbum
    // calls this on every single album add to check for an existing artist,
    // so a burst of approvals hits this repeatedly back-to-back.
    const raw = await http.get<Record<string, unknown>[]>('/api/v1/artist', {
      timeout: METADATA_LOOKUP_TIMEOUT_MS,
    })
    // Strip to only the fields we need - the full Lidarr response includes
    // images, statistics, albums, links, ratings etc. that we don't use,
    // which wastes significant memory for large libraries.
    return raw.map((a) => ({
      id: a.id as number,
      artistName: a.artistName as string,
      foreignArtistId: a.foreignArtistId as string,
      qualityProfileId: a.qualityProfileId as number,
      rootFolderPath: a.rootFolderPath as string,
      monitored: a.monitored as boolean,
      status: a.status as string,
      genres: a.genres as string[] | undefined,
    }))
  }

  // Lidarr proxies these lookups through its own metadata server, which has
  // to do a live MusicBrainz round-trip for anything not already cached --
  // slow enough on a cold cache that the client's normal 10s timeout aborts
  // it constantly (see the wall of "operation was aborted" request failures
  // this produced in practice). Give lookups more room before giving up.
  const METADATA_LOOKUP_TIMEOUT_MS = 30_000

  function lookupArtist(term: string): Promise<LidarrArtist[]> {
    const encoded = new URLSearchParams({ term }).toString()
    return http.get<LidarrArtist[]>(`/api/v1/artist/lookup?${encoded}`, {
      timeout: METADATA_LOOKUP_TIMEOUT_MS,
    })
  }

  // Proxies Lidarr's own metadata-server search (MusicBrainz release groups
  // under the hood) -- reused rather than a separate MusicBrainz client so
  // request search always resolves to exactly the release-group MBIDs Lidarr
  // itself will later accept via addAlbum, with no separate rate limit to
  // manage.
  async function lookupAlbum(term: string): Promise<LidarrAlbumLookupResult[]> {
    const encoded = new URLSearchParams({ term }).toString()
    const raw = await http.get<Record<string, unknown>[]>(`/api/v1/album/lookup?${encoded}`, {
      timeout: METADATA_LOOKUP_TIMEOUT_MS,
    })
    return raw.map((a) => {
      const artist = a.artist as Record<string, unknown> | undefined
      return {
        title: a.title as string,
        disambiguation: (a.disambiguation as string) || undefined,
        foreignAlbumId: a.foreignAlbumId as string,
        releaseDate: a.releaseDate as string | undefined,
        albumType: a.albumType as string | undefined,
        images: (a.images as { coverType: string; url: string }[] | undefined) ?? [],
        ratings: a.ratings as { votes: number; value: number } | undefined,
        artist: artist
          ? {
              artistName: artist.artistName as string,
              foreignArtistId: artist.foreignArtistId as string,
            }
          : undefined,
      }
    })
  }

  async function getQualityProfiles(): Promise<QualityProfile[]> {
    if (qualityProfileCache !== null) return qualityProfileCache
    // Normally instant (no MusicBrainz round trip), but addArtist() calls this
    // via Promise.all alongside itself while Lidarr may be mid-refresh-cascade
    // on a prior large-discography add (see AddArtistService in Lidarr's own
    // logs downloading a cover per album, synchronously, before it responds to
    // anything else) -- same "operation was aborted" failure mode as the
    // metadata lookups above, just triggered by Lidarr being busy rather than
    // a cold MusicBrainz cache. Give it the same room.
    const profiles = await http.get<QualityProfile[]>('/api/v1/qualityprofile', {
      timeout: METADATA_LOOKUP_TIMEOUT_MS,
    })
    qualityProfileCache = profiles
    return profiles
  }

  async function getMetadataProfiles(): Promise<MetadataProfile[]> {
    if (metadataProfileCache !== null) return metadataProfileCache
    const profiles = await http.get<MetadataProfile[]>('/api/v1/metadataprofile', {
      timeout: METADATA_LOOKUP_TIMEOUT_MS,
    })
    metadataProfileCache = profiles
    return profiles
  }

  // Preferences default profile ids to 1, but Lidarr never reuses id 1 once
  // the stock profile is deleted -- non-interactive adds (auto-approve,
  // subscriptions, bulk) would then fail with "Quality Profile does not
  // exist". Mirror the approve dialog: snap unknown ids to the first
  // available profile.
  function snapProfileId(
    requested: number,
    profiles: { id: number; name: string }[],
    kind: string,
  ): number {
    const first = profiles[0]
    if (!first) throw new Error(`No ${kind} profiles configured in Lidarr`)
    if (profiles.some((p) => p.id === requested)) return requested
    console.warn(
      `[lidarr] ${kind} profile id ${requested} not found, falling back to "${first.name}" (id ${first.id})`,
    )
    return first.id
  }

  async function getRootFolders(): Promise<RootFolder[]> {
    if (rootFolderCache !== null) return rootFolderCache
    const folders = await http.get<RootFolder[]>('/api/v1/rootfolder', {
      timeout: METADATA_LOOKUP_TIMEOUT_MS,
    })
    rootFolderCache = folders
    return folders
  }

  async function addArtist(
    foreignArtistId: string,
    artistName: string,
    qualityProfileId: number,
    metadataProfileId: number,
    rootFolderId?: number | null,
    options?: AddArtistOptions,
  ): Promise<LidarrArtist> {
    const [folders, qualityProfiles, metadataProfiles] = await Promise.all([
      getRootFolders(),
      getQualityProfiles(),
      getMetadataProfiles(),
    ])
    if (folders.length === 0) {
      throw new Error('No root folders configured in Lidarr')
    }
    const folder = rootFolderId == null ? folders[0] : folders.find((f) => f.id === rootFolderId)
    if (!folder) {
      throw new Error(`Root folder with id ${rootFolderId} not found`)
    }

    const monitor = options?.monitorOption ?? 'none'

    const created = http.post<LidarrArtist>(
      '/api/v1/artist',
      {
        foreignArtistId,
        artistName,
        qualityProfileId: snapProfileId(qualityProfileId, qualityProfiles, 'quality'),
        metadataProfileId: snapProfileId(metadataProfileId, metadataProfiles, 'metadata'),
        rootFolderPath: folder.path,
        monitored: true,
        // Lidarr defaults this to 'all' when omitted, which makes its own
        // periodic artist-refresh/RSS sync backfill-monitor the ENTIRE back
        // catalog for any artist this app creates -- regardless of
        // addOptions.monitor below, which only governs the one-time add
        // decision, not ongoing monitoring. Confirmed live: a plain
        // single-album request created a new artist, and Lidarr grabbed
        // dozens of unrelated albums over the following days purely because
        // monitorNewItems was left to default to 'all'. Only an explicit
        // 'all' monitorOption (not currently used by any caller) should
        // opt into that.
        monitorNewItems: monitor === 'all' ? 'all' : 'none',
        addOptions: {
          monitor,
          searchForMissingAlbums: monitor === 'all',
        },
      },
      { timeout: METADATA_LOOKUP_TIMEOUT_MS },
    )
    // A POST that times out is retried, but Lidarr often finished the first
    // one anyway, so the retry 400s with "already been added" -- as does a
    // concurrent add of the same artist. Either way the artist exists, which
    // is what the caller wanted: hand back that row instead of failing.
    return created.catch(async (err: unknown) => {
      if (!isAlreadyAdded(err)) throw err
      const existing = (await getArtists()).find((a) => a.foreignArtistId === foreignArtistId)
      if (!existing) throw err
      return existing
    })
  }

  async function getAlbums(artistId: number): Promise<LidarrAlbum[]> {
    // findSelectedAlbums polls this up to 6 times per add -- same
    // busy-Lidarr timeout risk as getArtists above.
    const raw = await http.get<Record<string, unknown>[]>(`/api/v1/album?artistId=${artistId}`, {
      timeout: METADATA_LOOKUP_TIMEOUT_MS,
    })
    return raw.map(toLidarrAlbum)
  }

  // /album/lookup reflects Lidarr's metadata backend's full knowledge of an
  // artist's catalog, but -- like /artist/lookup before addArtist -- it's
  // read-only preview data, not a real Album row. A release-group only
  // becomes requestable once explicitly added, same as a brand-new artist.
  // Confirmed live (2026-08): Brooks & Dunn "The Greatest Hits Collection"
  // resolved cleanly via an exact "lidarr:<mbid>" lookup for an artist
  // already in this same Lidarr's library, yet never appeared in that
  // artist's getAlbums() list, even after a RefreshArtist command -- Lidarr
  // simply doesn't backfill every known release-group into an existing
  // artist's synced albums on its own. POSTing the lookup response straight
  // back to /api/v1/album (with monitored:true) is what actually creates
  // it. Only ever called for an artist already known to Lidarr (see
  // addAlbum's caller in targets/lidarr.ts), so the lookup's own resolved
  // artistId is trustworthy -- this can't create a row under the wrong
  // artist. Posts the raw, unmapped lookup payload rather than a
  // hand-built body -- Lidarr's add endpoint expects the same full shape
  // its own lookup just handed back (secondaryTypes, releases, genres,
  // ...), and a stripped-down body risks silent rejection.
  async function addAlbumByMbid(releaseGroupMbid: string): Promise<LidarrAlbum | null> {
    const params = new URLSearchParams({ term: `lidarr:${releaseGroupMbid}` })
    const found = await http.get<Record<string, unknown>[]>(`/api/v1/album/lookup?${params}`, {
      timeout: METADATA_LOOKUP_TIMEOUT_MS,
    })
    const payload = found[0]
    if (!payload) return null

    // The lookup can resolve to a *different* release-group id than the one
    // asked for (MusicBrainz merges/redirects -- confirmed live 2026-10:
    // Cranberries b8095f39... looked up as ef32ef70..., which was already in
    // Lidarr). POSTing that would 400 with "This album has already been
    // added", so reuse the existing row instead.
    const resolvedForeignId = payload.foreignAlbumId as string | undefined
    if (resolvedForeignId) {
      const existing = await http.get<Record<string, unknown>[]>(
        `/api/v1/album?${new URLSearchParams({ foreignAlbumId: resolvedForeignId })}`,
        { timeout: METADATA_LOOKUP_TIMEOUT_MS },
      )
      if (existing[0]) return toLidarrAlbum(existing[0])
    }

    const created = await http
      .post<Record<string, unknown>>(
        '/api/v1/album',
        { ...payload, monitored: true, addOptions: { searchForNewAlbum: false } },
        { timeout: METADATA_LOOKUP_TIMEOUT_MS },
      )
      .catch(async (err: unknown) => {
        // Same timed-out-then-retried POST case as addArtist.
        if (!isAlreadyAdded(err) || !resolvedForeignId) throw err
        const existing = await http.get<Record<string, unknown>[]>(
          `/api/v1/album?${new URLSearchParams({ foreignAlbumId: resolvedForeignId })}`,
          { timeout: METADATA_LOOKUP_TIMEOUT_MS },
        )
        if (!existing[0]) throw err
        return existing[0]
      })
    return toLidarrAlbum(created)
  }

  // Used to verify a resolved album actually contains the song being
  // searched for, not just that Lidarr has *an* album by that name for the
  // artist -- see normalizeTrackTitle's doc comment for the real-world case
  // this catches (Rufus "Numbers" containing a different, similarly-titled
  // song instead of the real "Ain't Nobody").
  async function getTracks(albumId: number): Promise<LidarrTrack[]> {
    const raw = await http.get<Record<string, unknown>[]>(`/api/v1/track?albumId=${albumId}`, {
      timeout: METADATA_LOOKUP_TIMEOUT_MS,
    })
    return raw.map((t) => ({
      id: t.id as number,
      title: t.title as string,
      albumId: t.albumId as number,
      hasFile: Boolean(t.hasFile),
    }))
  }

  async function getWantedMissing(): Promise<LidarrWantedMissing[]> {
    const raw = await http.get<unknown>('/api/v1/wanted/missing')
    const items = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { records?: unknown }).records)
        ? ((raw as { records: unknown[] }).records as Record<string, unknown>[])
        : []

    return items.map((album) => ({
      id: album.id as number,
      title: album.title as string,
      artistId: album.artistId as number | undefined,
      foreignAlbumId: album.foreignAlbumId as string | undefined,
      artist:
        album.artist && typeof album.artist === 'object'
          ? {
              id: (album.artist as Record<string, unknown>).id as number | undefined,
              artistName: (album.artist as Record<string, unknown>).artistName as
                | string
                | undefined,
              foreignArtistId: (album.artist as Record<string, unknown>).foreignArtistId as
                | string
                | undefined,
            }
          : undefined,
      artistName: album.artistName as string | undefined,
      foreignArtistId: album.foreignArtistId as string | undefined,
    }))
  }

  // Lidarr's per-item PUT endpoints replace the full resource: a partial body
  // deserializes missing fields as null and trips NOT NULL constraints
  // (e.g. Albums.ForeignAlbumId -> HTTP 409). The bulk monitor/editor
  // endpoints only apply the fields provided, so use them for flag flips.
  function setAlbumsMonitored(albumIds: number[], monitored: boolean): Promise<LidarrAlbum[]> {
    // Same busy-Lidarr timeout risk as getArtists: these were the last
    // add-path calls on the 10s default, and timed out mid-burst.
    return http.put<LidarrAlbum[]>(
      '/api/v1/album/monitor',
      { albumIds, monitored },
      { timeout: METADATA_LOOKUP_TIMEOUT_MS },
    )
  }

  function setArtistsMonitored(artistIds: number[], monitored: boolean): Promise<LidarrArtist[]> {
    return http.put<LidarrArtist[]>(
      '/api/v1/artist/editor',
      { artistIds, monitored },
      { timeout: METADATA_LOOKUP_TIMEOUT_MS },
    )
  }

  // deleteFiles defaults false -- removing an artist from Lidarr should stop
  // it from being managed/searched, not destroy music already downloaded.
  // addImportListExclusion defaults false since DJ Llama's own requests
  // aren't fed by an import list that would otherwise silently re-add it.
  function deleteArtist(
    id: number,
    options?: { deleteFiles?: boolean; addImportListExclusion?: boolean },
  ): Promise<void> {
    const params = new URLSearchParams({
      deleteFiles: String(options?.deleteFiles ?? false),
      addImportListExclusion: String(options?.addImportListExclusion ?? false),
    }).toString()
    return http.delete(`/api/v1/artist/${id}?${params}`)
  }

  function triggerCommand(name: string, body?: Record<string, unknown>): Promise<LidarrCommand> {
    return http.post<LidarrCommand>(
      '/api/v1/command',
      { name, ...body },
      { timeout: METADATA_LOOKUP_TIMEOUT_MS },
    )
  }

  // Lidarr's command queue (recent + in-flight), used to wait out a backlog
  // of artist refreshes before the next add -- see targets/lidarr-throttle.ts.
  // Short timeout on purpose: a slow answer here already means "busy".
  function getCommands(): Promise<LidarrCommand[]> {
    return http.get<LidarrCommand[]>('/api/v1/command', { timeout: 10_000 })
  }

  async function testConnection(): Promise<ServiceTestResult> {
    try {
      const profiles = await http.get<QualityProfile[]>('/api/v1/qualityprofile')
      return {
        success: true,
        message: `Connected to Lidarr - ${profiles.length} quality profile(s) found`,
        details: { profileCount: profiles.length },
      }
    } catch (err: unknown) {
      return { success: false, message: errMsg(err) }
    }
  }

  return {
    getCommands,
    getArtists,
    lookupArtist,
    lookupAlbum,
    addArtist,
    getAlbums,
    addAlbumByMbid,
    getTracks,
    getWantedMissing,
    setAlbumsMonitored,
    setArtistsMonitored,
    deleteArtist,
    triggerCommand,
    getQualityProfiles,
    getMetadataProfiles,
    getRootFolders,
    testConnection,
  }
}
