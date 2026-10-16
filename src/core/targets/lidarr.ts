import { createLidarrClient } from '@/core/clients/lidarr'
import { errMsg } from '@/core/validation'
import { throttledLidarrWrite } from './lidarr-throttle'
import type { DestinationTarget, TargetAddOptions, TargetResult } from './types'

// Lidarr populates an artist's album list asynchronously after the add, so an
// immediate getAlbums often returns an empty/partial list and the selected
// album silently never gets monitored. Poll briefly until the albums appear.
const ALBUM_POLL_ATTEMPTS = 6
const ALBUM_POLL_DELAY_MS = 1500
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type LidarrTargetConfig = {
  url: string
  apiKey: string
  skipTlsVerify?: boolean
  qualityProfileId?: number
  metadataProfileId?: number
  rootFolderId?: number
  // Optional fast path: DJ Llama's own already-synced copy of this Lidarr's
  // library (see db/queries/lidarr-cache.ts), checked before falling back
  // to Lidarr's live, full-payload getArtists()/getAlbums() polling.
  // Skipped entirely (not just returning nulls) when omitted, so callers
  // that don't have a DB handle (tests, other target instantiations) keep
  // the original always-live behavior.
  lookupCachedIds?: (
    artistMbid: string,
    albumMbid: string,
  ) => Promise<{ artistId: number | null; albumId: number | null }>
}

export function createLidarrTarget(
  targetId: number,
  config: LidarrTargetConfig,
): DestinationTarget {
  const client = createLidarrClient(config.url, config.apiKey, config.skipTlsVerify)
  const qualityProfileId = config.qualityProfileId ?? 1
  const metadataProfileId = config.metadataProfileId ?? 1
  const rootFolderId = config.rootFolderId

  // Poll Lidarr until the requested albums appear (or attempts run out),
  // returning whichever of the selected albums are now present.
  async function findSelectedAlbums(artistId: number, albumMbids: string[]) {
    const wanted = new Set(albumMbids)
    for (let attempt = 0; attempt < ALBUM_POLL_ATTEMPTS; attempt++) {
      const albums = await client.getAlbums(artistId)
      const matched = albums.filter((a) => wanted.has(a.foreignAlbumId))
      if (matched.length === wanted.size || attempt === ALBUM_POLL_ATTEMPTS - 1) {
        return matched
      }
      await sleep(ALBUM_POLL_DELAY_MS)
    }
    return []
  }

  const target: DestinationTarget = {
    id: `lidarr-${targetId}`,
    name: 'Lidarr',
    type: 'lidarr',
    capabilities: ['addArtist', 'addAlbum'],

    async addArtist(
      artist: { mbid: string; name: string },
      options?: TargetAddOptions,
    ): Promise<TargetResult> {
      const effectiveMonitor =
        options?.monitorOption === 'selected' ? 'none' : (options?.monitorOption ?? 'none')

      try {
        const added = await client.addArtist(
          artist.mbid,
          artist.name,
          options?.qualityProfileId ?? qualityProfileId,
          options?.metadataProfileId ?? metadataProfileId,
          options?.rootFolderId ?? rootFolderId,
          { monitorOption: effectiveMonitor },
        )

        // Monitor (and search) the selected albums after the add. The artist
        // was added unmonitored, so without this the selected album is never
        // grabbed. This step is best-effort: the artist add already succeeded,
        // so a monitoring failure must NOT fail the result (that would drop the
        // Lidarr artist id and orphan the artist -> a retry re-adds a duplicate).
        // Partial/failed monitoring surfaces as a warning instead.
        let warning: string | undefined
        if (options?.monitorOption === 'selected' && options.selectedAlbumIds?.length && added.id) {
          const wanted = options.selectedAlbumIds
          const matched = await findSelectedAlbums(added.id, wanted)
          if (matched.length === 0) {
            warning =
              'artist added, but the selected album was not found in Lidarr (it may still be populating; retry to finish monitoring)'
          } else {
            try {
              const albumIds = matched.map((a) => a.id)
              await client.setAlbumsMonitored(albumIds, true)
              await client.triggerCommand('AlbumSearch', { albumIds })
              if (matched.length < wanted.length) {
                warning = `artist added; ${matched.length} of ${wanted.length} selected albums monitored, the rest were not found in Lidarr`
              }
            } catch (monErr: unknown) {
              warning = `artist added, but monitoring the selected album failed: ${errMsg(monErr)}`
            }
          }
        }

        return {
          success: true,
          targetType: 'lidarr',
          targetId,
          externalId: added.id,
          ...(warning ? { warning } : {}),
        }
      } catch (err: unknown) {
        return {
          success: false,
          targetType: 'lidarr',
          targetId,
          error: errMsg(err),
        }
      }
    },

    async addAlbum(
      album: { artistMbid: string; artistName: string; releaseGroupMbid: string },
      options?: TargetAddOptions,
    ): Promise<TargetResult> {
      try {
        const cached = await config
          .lookupCachedIds?.(album.artistMbid, album.releaseGroupMbid)
          .catch(() => null)

        // Gap-fill safe: reuse the artist if already tracked, otherwise add it
        // unmonitored so Lidarr does not grab the whole discography. Cache hit
        // skips Lidarr's full-library getArtists() fetch entirely -- on a
        // large library that's a ~30s live call for something a DB lookup
        // already knows.
        let artistId = cached?.artistId ?? undefined
        if (!artistId) {
          const existing = (await client.getArtists()).find(
            (a) => a.foreignArtistId === album.artistMbid,
          )
          artistId = existing?.id
        }

        if (!artistId) {
          const added = await client.addArtist(
            album.artistMbid,
            album.artistName,
            options?.qualityProfileId ?? qualityProfileId,
            options?.metadataProfileId ?? metadataProfileId,
            options?.rootFolderId ?? rootFolderId,
            { monitorOption: 'none' },
          )
          artistId = added.id
        } else {
          // Reusing an artist Lidarr already knows about -- unlike a fresh
          // add (whose POST body above always sets Artist.monitored=true),
          // a pre-existing artist can be sitting unmonitored (e.g. picked up
          // by a library scan, or manually unmonitored) with no bearing on
          // whether this specific album should download. Confirmed live:
          // monitoring only the album left it correctly flagged but
          // invisible to Lidarr's Wanted/Missing search and RSS sync, which
          // both skip albums under an unmonitored artist regardless of the
          // album's own monitored flag -- so it was never actually grabbed.
          await client.setArtistsMonitored([artistId], true).catch((err) => {
            console.warn(
              `[lidarr] Failed to monitor artist ${artistId} (${album.artistName}):`,
              errMsg(err),
            )
          })
        }

        // Cache hit: one lean per-artist getAlbums call to pick up current
        // statistics (needed for the alreadyComplete check below) instead of
        // findSelectedAlbums' up-to-6x polling loop -- we already know the
        // album is there, just not its live track-file counts.
        let match = cached?.albumId
          ? (await client.getAlbums(artistId)).find((a) => a.id === cached.albumId)
          : undefined

        // Cache miss, or the cached id no longer resolves (stale sync) --
        // fall back to the original live poll, which also covers an artist
        // that's mid-refresh after just being added above.
        if (!match) {
          const albums = await findSelectedAlbums(artistId, [album.releaseGroupMbid])
          match = albums.find((a) => a.foreignAlbumId === album.releaseGroupMbid)
        }
        if (!match) {
          // findSelectedAlbums only ever polls the artist's already-synced
          // album list -- see addAlbumByMbid's doc comment for why that can
          // stay permanently missing an album Lidarr's own metadata backend
          // already knows about for this exact artist. artistId is already
          // confirmed above (existing or freshly added), so this can't
          // create a row under the wrong artist.
          match =
            (await client.addAlbumByMbid(album.releaseGroupMbid).catch((err) => {
              console.warn(
                `[lidarr] addAlbumByMbid failed for '${album.artistName}' (${album.releaseGroupMbid}):`,
                errMsg(err),
              )
              return null
            })) ?? undefined
        }
        if (!match) {
          return {
            success: false,
            targetType: 'lidarr',
            targetId,
            error: 'album not found in Lidarr',
          }
        }

        await client.setAlbumsMonitored([match.id], true)

        // Skip the search if Lidarr already has every track on disk -- searching
        // anyway grabs a duplicate release and can knock out the existing import
        // (Lidarr matches a specific release per album; a second grab of a
        // different release fails to import and leaves tracks "not requested").
        const alreadyComplete =
          match.statistics != null &&
          match.statistics.trackCount > 0 &&
          match.statistics.trackFileCount >= match.statistics.trackCount
        if (!alreadyComplete) {
          await client.triggerCommand('AlbumSearch', { albumIds: [match.id] })
        }

        return {
          success: true,
          targetType: 'lidarr',
          targetId,
          externalId: match.id,
        }
      } catch (err: unknown) {
        return {
          success: false,
          targetType: 'lidarr',
          targetId,
          error: errMsg(err),
        }
      }
    },

    async removeArtist(
      externalId: number | string,
      options?: { deleteFiles?: boolean },
    ): Promise<TargetResult> {
      try {
        await client.deleteArtist(Number(externalId), {
          deleteFiles: options?.deleteFiles ?? false,
        })
        return { success: true, targetType: 'lidarr', targetId }
      } catch (err: unknown) {
        return { success: false, targetType: 'lidarr', targetId, error: errMsg(err) }
      }
    },

    async unmonitorAlbum(externalId: number | string): Promise<TargetResult> {
      try {
        await client.setAlbumsMonitored([Number(externalId)], false)
        return { success: true, targetType: 'lidarr', targetId }
      } catch (err: unknown) {
        return { success: false, targetType: 'lidarr', targetId, error: errMsg(err) }
      }
    },

    async testConnection() {
      return client.testConnection()
    },
  }

  // Every add goes through the shared per-Lidarr throttle -- see
  // lidarr-throttle.ts for why a burst of adds otherwise times out en masse.
  const getCommands = () => client.getCommands()
  const { addArtist, addAlbum } = target
  if (addArtist) {
    target.addArtist = (...args) =>
      throttledLidarrWrite(config.url, getCommands, () => addArtist(...args))
  }
  if (addAlbum) {
    target.addAlbum = (...args) =>
      throttledLidarrWrite(config.url, getCommands, () => addAlbum(...args))
  }
  return target
}
