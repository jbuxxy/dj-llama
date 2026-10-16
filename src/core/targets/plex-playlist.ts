import { createHttpClient, HttpError } from '@/core/clients/http'
import type { ServiceTestResult } from '@/core/types'
import { errMsg } from '@/core/validation'
import {
  artistNamesMatch,
  isAlternateVersionCandidate,
  pickBestTrackMatch,
  pickUnambiguousTitleOnlyMatch,
  stripSearchQualifier,
  stripTrailingParenthetical,
} from './playlist-match'
import type {
  DestinationTarget,
  PlaylistItem,
  PlaylistResult,
  UnmatchedPlaylistItem,
} from './types'

export type PlexPlaylistConfig = {
  url: string
  token: string
}

type PlexHubSearchResponse = {
  MediaContainer: {
    Hub?: Array<{
      type: string
      Metadata?: Array<{
        ratingKey: string
        title: string
        grandparentTitle?: string
        parentTitle?: string
        type: string
      }>
    }>
  }
}

type PlexPlaylistCreateResponse = {
  MediaContainer: {
    Metadata?: Array<{ ratingKey: string; title: string }>
  }
}

type PlexPlaylistItem = {
  ratingKey: string
  title: string
  grandparentTitle?: string
  parentTitle?: string
  // Distinct from ratingKey (which identifies the underlying track) -- this
  // identifies the track's specific slot *in this playlist*, and is what
  // Plex's remove-item endpoint actually keys on.
  playlistItemID: number
}

type SearchOutcome =
  | { ratingKey: string; reason?: undefined }
  | { ratingKey: null; reason: 'not_found' | 'search_error' }

// Shared by createPlexPlaylistTarget (full playlist create/replace) and
// sweepPlaylistLiveTracks (targeted single-item replacement) so both talk to
// Plex the same way -- same auth header handling, same redaction of the
// token from thrown errors, same search-and-pick logic.
function createPlexHelpers(config: PlexPlaylistConfig) {
  const { url, token } = config
  const client = createHttpClient({
    baseUrl: url.replace(/\/+$/, ''),
    headers: { 'X-Plex-Token': token, Accept: 'application/json' },
    timeout: 10_000,
  })

  function rethrowPlexError(error: unknown): never {
    if (error instanceof HttpError) {
      throw new Error(`Plex API ${error.status}: ${error.body.replaceAll(token, '[REDACTED]')}`)
    }
    throw error
  }

  async function get<T>(path: string): Promise<T> {
    try {
      return await client.get<T>(path)
    } catch (error) {
      rethrowPlexError(error)
    }
  }

  async function postOnce<T>(path: string): Promise<T> {
    try {
      return await client.post<T>(path, undefined, { retries: 0 })
    } catch (error) {
      rethrowPlexError(error)
    }
  }

  async function putOnce<T>(path: string): Promise<T> {
    try {
      return await client.put<T>(path, undefined, { retries: 0 })
    } catch (error) {
      rethrowPlexError(error)
    }
  }

  async function deleteOnce(path: string): Promise<void> {
    try {
      await client.delete(path, { retries: 0 })
    } catch (error) {
      rethrowPlexError(error)
    }
  }

  async function getMusicMachineId(): Promise<string> {
    const res = await get<{
      MediaContainer: { machineIdentifier: string }
    }>('/')
    return res.MediaContainer.machineIdentifier
  }

  type PlexHub = NonNullable<PlexHubSearchResponse['MediaContainer']['Hub']>

  // Plex's `limit` param on /hubs/search caps results per hub type, so this
  // bounds the track hub specifically. pickBestTrackMatch's studio-over-live
  // preference (playlist-match.ts) only sees whatever comes back here -- at
  // limit 10, a heavily-covered title (deep back catalog, live reissues,
  // best-of compilations) could push the real studio track past the cutoff
  // for Plex's own relevance ranking, leaving only a live version in the
  // candidate set for it to "prefer" against. A larger candidate window
  // makes it far more likely the studio version is actually present to win.
  async function searchHubTracks(query: string): Promise<PlexHub> {
    const params = new URLSearchParams({ query, limit: '25' })
    const res = await get<PlexHubSearchResponse>(`/hubs/search?${params.toString()}`)
    return res.MediaContainer.Hub ?? []
  }

  function toCandidates(
    hubs: PlexHub,
  ): Array<{ id: string; title: string; artists: string[]; album?: string }> {
    const trackHub = hubs.find((h) => h.type === 'track')
    const results = trackHub?.Metadata ?? []
    return results.map((result) => ({
      id: result.ratingKey,
      title: result.title,
      artists: result.grandparentTitle ? [result.grandparentTitle] : [],
      album: result.parentTitle,
    }))
  }

  // Distinguishes a genuine "not in the library" miss from a Plex API
  // error/timeout -- both used to collapse into the same `null`, so a flaky
  // Plex request looked identical to a track that truly isn't there, and
  // callers had no way to tell "needs a Lidarr request" apart from "just
  // retry the sync." See playlist_missing_tracks.reason.
  function describeCandidates(
    candidates: Array<{ title: string; artists: string[]; album?: string }>,
  ): string {
    if (candidates.length === 0) return 'none'
    return candidates
      .map((c) => `"${c.title}" by ${c.artists.join('/') || '?'} [${c.album ?? 'no album'}]`)
      .join('; ')
  }

  // Plex's own search -- unlike pickBestTrackMatch's post-fetch comparison,
  // which already unifies apostrophe styles via artistNamesMatch/normalize
  // -- treats a straight apostrophe (a source playlist's typical spelling,
  // e.g. Spotify's "Ain't Nobody") and Plex's own typographic apostrophe
  // ("Ain’t Nobody") as genuinely different query text: the straight-quote
  // query returns completely unrelated fuzzy noise, not the real candidate
  // at a lower rank. Confirmed live (2026-08): re-querying with the curly
  // form surfaced the exact match immediately, on an otherwise fully
  // scanned/matched track that a fresh Plex library scan alone didn't fix.
  // Only worth retrying when the title actually contains a straight
  // apostrophe/backtick -- otherwise this is identical to the byTitle query.
  function toCurlyApostrophes(value: string): string {
    return value.replace(/['`]/g, '’')
  }

  // Temporary diagnostic logging (2026-08) for tracking down why import
  // playlists still show tracks missing after the studio-preference fixes --
  // logs the actual query, every Plex candidate considered, and why a match
  // was or wasn't picked, so a live sync's console output is enough to
  // diagnose a specific miss without re-querying Plex by hand.
  // Each tier below runs its own fetch independently (not one shared
  // try/catch around the whole function) -- confirmed live, 2026-08: Plex's
  // own search backend 500s on the exact query text "Stay (I Missed You)"
  // (a genuine Plex-side bug, reproduced directly against the API,
  // independent of artist/prefix), which used to abort the entire search
  // immediately on the very first (combined) query, before ever reaching
  // the generic-parenthetical-stripped tier below whose query text
  // ("Stay", without the crashing parenthetical) would likely have dodged
  // the crash entirely. A tier that throws is treated the same as a tier
  // that found nothing -- only every tier failing outright (not just
  // finding no match) reports 'search_error' over 'not_found', preserving
  // the original distinction those two reasons exist for.
  async function tryHubSearch(
    query: string,
  ): Promise<{ candidates: ReturnType<typeof toCandidates>; error?: string }> {
    try {
      return { candidates: toCandidates(await searchHubTracks(query)) }
    } catch (err) {
      return { candidates: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function searchTrack(artistName: string, trackName: string): Promise<SearchOutcome> {
    const label = `${artistName} - ${trackName}`
    const errors: string[] = []
    let tiersAttempted = 0

    tiersAttempted++
    const combinedRes = await tryHubSearch(`${artistName} ${trackName}`)
    if (combinedRes.error) errors.push(`combined: ${combinedRes.error}`)
    const combined = combinedRes.candidates
    const combinedMatch = pickBestTrackMatch(combined, artistName, trackName)
    if (combinedMatch) {
      console.log(`[plex-search] MATCH "${label}" via combined query`)
      return { ratingKey: combinedMatch }
    }

    // Combining artist+track into one free-text query can fail to surface
    // the right candidate even when the track is in the library -- e.g.
    // punctuation/typographic quote mismatches between the source
    // playlist's metadata and Plex's, or Plex's relevance ranking
    // deprioritizing a multi-token blob query in favor of an unrelated
    // same-titled track by a different artist (confirmed live, 2026-08:
    // "Huey Lewis & The News The Power Of Love" surfaced only a "Various
    // Artists" compilation cut, so combined wasn't empty -- it just had no
    // usable match). Retrying on the track title alone whenever the
    // combined query didn't produce a match (not only when it came back
    // completely empty) catches those without loosening the match itself.
    tiersAttempted++
    const byTitleRes = await tryHubSearch(trackName)
    if (byTitleRes.error) errors.push(`title-only: ${byTitleRes.error}`)
    const byTitleRaw = byTitleRes.candidates
    const byTitle = byTitleRaw.filter((c) => c.artists.some((a) => artistNamesMatch(a, artistName)))
    const byTitleMatch = pickBestTrackMatch(byTitle, artistName, trackName)
    if (byTitleMatch) {
      console.log(`[plex-search] MATCH "${label}" via title-only retry`)
      return { ratingKey: byTitleMatch }
    }

    const curlyTrackName = toCurlyApostrophes(trackName)
    if (curlyTrackName !== trackName) {
      tiersAttempted++
      const byCurlyRes = await tryHubSearch(curlyTrackName)
      if (byCurlyRes.error) errors.push(`curly-apostrophe: ${byCurlyRes.error}`)
      const byCurly = byCurlyRes.candidates.filter((c) =>
        c.artists.some((a) => artistNamesMatch(a, artistName)),
      )
      const byCurlyMatch = pickBestTrackMatch(byCurly, artistName, curlyTrackName)
      if (byCurlyMatch) {
        console.log(`[plex-search] MATCH "${label}" via curly-apostrophe retry`)
        return { ratingKey: byCurlyMatch }
      }
    }

    // Last resort: a trailing parenthetical can be a legitimate part of
    // the source's title that Plex's own tag simply doesn't carry -- e.g.
    // "You Make My Dreams (Come True)" vs Plex's plain "You Make My
    // Dreams" (confirmed live, 2026-08: zero results either query above,
    // while the track sat right there under an album already owned).
    // stripSearchQualifier (applied upstream, before searchTrack is ever
    // called) only strips known live/remaster/edition/soundtrack
    // qualifiers, so a plain subtitle like this slips through untouched.
    // Only tried when trimming actually changes the title -- otherwise
    // it's a pointless repeat of the byTitle attempt above.
    const genericStripped = stripTrailingParenthetical(trackName)
    if (genericStripped !== trackName) {
      tiersAttempted++
      const byStrippedRes = await tryHubSearch(genericStripped)
      if (byStrippedRes.error) errors.push(`generic-stripped: ${byStrippedRes.error}`)
      const byStripped = byStrippedRes.candidates.filter((c) =>
        c.artists.some((a) => artistNamesMatch(a, artistName)),
      )
      const byStrippedMatch = pickBestTrackMatch(byStripped, artistName, genericStripped)
      if (byStrippedMatch) {
        console.log(`[plex-search] MATCH "${label}" via generic-parenthetical-stripped retry`)
        return { ratingKey: byStrippedMatch }
      }
    }

    // Last resort -- see pickUnambiguousTitleOnlyMatch's doc comment: the
    // source's own artist tag can be a stock "cover" alias standing in for a
    // real artist whose original recording is already in the library under
    // its real name. Reuses byTitleRaw (already fetched above) rather than
    // issuing another query.
    const soundalikeMatch = pickUnambiguousTitleOnlyMatch(byTitleRaw, trackName)
    if (soundalikeMatch) {
      console.log(`[plex-search] MATCH "${label}" via unambiguous-title cover-artist fallback`)
      return { ratingKey: soundalikeMatch }
    }

    // Only reported as a hard error when every single tier above threw --
    // if even one tier completed (found a match or not), the outcome is a
    // genuine miss, not a transient failure worth retrying differently.
    if (errors.length > 0 && errors.length === tiersAttempted) {
      console.log(`[plex-search] ERROR "${label}": ${errors.join('; ')}`)
      return { ratingKey: null, reason: 'search_error' }
    }

    console.log(
      `[plex-search] MISS "${label}": combined query "${artistName} ${trackName}" returned [${describeCandidates(combined)}]; title-only query "${trackName}" returned [${describeCandidates(byTitleRaw)}], of which artist-matched: [${describeCandidates(byTitle)}]${errors.length > 0 ? `; tier errors: [${errors.join('; ')}]` : ''}`,
    )

    return { ratingKey: null, reason: 'not_found' }
  }

  async function findPlaylistRatingKey(name: string): Promise<string | null> {
    const res = await get<{
      MediaContainer: { Metadata?: Array<{ ratingKey: string; title: string }> }
    }>('/playlists?playlistType=audio')
    return res.MediaContainer.Metadata?.find((p) => p.title === name)?.ratingKey ?? null
  }

  // Returns all ratingKeys for playlists that match the given name. Plex can
  // contain multiple playlists with the same title (historical or orphaned
  // duplicates); when regenerating we want to remove all of them to avoid
  // leaving behind any duplicates.
  async function findPlaylistRatingKeys(name: string): Promise<string[]> {
    const res = await get<{
      MediaContainer: { Metadata?: Array<{ ratingKey: string; title: string }> }
    }>('/playlists?playlistType=audio')
    return (res.MediaContainer.Metadata ?? [])
      .filter((p) => p.title === name)
      .map((p) => p.ratingKey)
  }

  async function getPlaylistItems(ratingKey: string): Promise<PlexPlaylistItem[]> {
    const res = await get<{ MediaContainer: { Metadata?: PlexPlaylistItem[] } }>(
      `/playlists/${ratingKey}/items`,
    )
    return res.MediaContainer.Metadata ?? []
  }

  return {
    client,
    get,
    postOnce,
    putOnce,
    deleteOnce,
    getMusicMachineId,
    searchTrack,
    findPlaylistRatingKey,
    findPlaylistRatingKeys,
    getPlaylistItems,
  }
}

export function createPlexPlaylistTarget(
  targetId: number,
  config: PlexPlaylistConfig,
): DestinationTarget {
  const { client, get, postOnce, getMusicMachineId, searchTrack, findPlaylistRatingKeys } =
    createPlexHelpers(config)

  return {
    id: `plex-playlist-${targetId}`,
    name: 'Plex Playlist',
    type: 'plex-playlist',
    capabilities: ['createPlaylist', 'deletePlaylist'],

    async createPlaylist(
      name: string,
      items: PlaylistItem[],
      options?: { description?: string; public?: boolean; replace?: boolean; dryRun?: boolean },
    ): Promise<PlaylistResult> {
      try {
        // Resolve Plex rating keys for items that have a trackName
        const ratingKeys: string[] = []
        const unmatchedItems: UnmatchedPlaylistItem[] = []
        for (const item of items) {
          if (!item.trackName) continue
          const outcome = await searchTrack(item.artistName, item.trackName)
          if (outcome.ratingKey) ratingKeys.push(outcome.ratingKey)
          else unmatchedItems.push({ ...item, reason: outcome.reason })
        }

        // Caller only wants to know what's matched/missing (e.g. an import
        // whose "Push to Plexamp" toggle is off) -- skip touching the actual
        // Plex playlist entirely.
        if (options?.dryRun) {
          return {
            success: true,
            targetType: 'plex-playlist',
            targetId,
            itemsAdded: ratingKeys.length,
            unmatchedItems,
          }
        }

        const machineId = await getMusicMachineId()

        // Plex's playlist-create endpoint always makes a brand new playlist
        // object -- without removing a same-named playlist first, every
        // regeneration left the previous run's playlist behind as an
        // orphaned duplicate instead of replacing it in place.
        try {
          const existingRatingKeys = await findPlaylistRatingKeys(name)
          for (const key of existingRatingKeys) {
            await client.delete(`/playlists/${key}`, { retries: 0 })
          }
        } catch (err) {
          console.warn(
            `[plex-playlist] Failed to remove previous '${name}' before regenerating:`,
            err,
          )
        }

        // Plex's playlist-create endpoint takes exactly one `uri` param -- to
        // add multiple items in one call, the ratingKeys are comma-joined
        // into a single URI, not repeated as separate `uri=` params (a
        // repeated query key is silently collapsed to one occurrence, which
        // was the root cause of only ever adding a single track).
        const baseParams = new URLSearchParams({ type: 'audio', title: name, smart: '0' })
        if (ratingKeys.length > 0) {
          baseParams.set(
            'uri',
            `server://${machineId}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`,
          )
        }

        const created = await postOnce<PlexPlaylistCreateResponse>(
          `/playlists?${baseParams.toString()}`,
        )

        const playlist = created.MediaContainer.Metadata?.[0]
        if (!playlist) {
          throw new Error('Plex did not return a playlist after creation')
        }

        return {
          success: true,
          targetType: 'plex-playlist',
          targetId,
          playlistId: playlist.ratingKey,
          playlistName: playlist.title,
          itemsAdded: ratingKeys.length,
          unmatchedItems,
        }
      } catch (err: unknown) {
        return {
          success: false,
          targetType: 'plex-playlist',
          targetId,
          error: errMsg(err),
        }
      }
    },

    async deletePlaylist(name: string): Promise<PlaylistResult> {
      try {
        const ratingKeys = await findPlaylistRatingKeys(name)
        if (ratingKeys.length === 0) {
          // Nothing to delete -- already gone (or never made it to Plex).
          return { success: true, targetType: 'plex-playlist', targetId }
        }
        for (const key of ratingKeys) {
          await client.delete(`/playlists/${key}`, { retries: 0 })
        }
        return { success: true, targetType: 'plex-playlist', targetId }
      } catch (err: unknown) {
        return {
          success: false,
          targetType: 'plex-playlist',
          targetId,
          error: errMsg(err),
        }
      }
    },

    async testConnection(): Promise<ServiceTestResult> {
      try {
        const res = await get<{
          MediaContainer: { friendlyName?: string; version?: string; machineIdentifier: string }
        }>('/')
        const info = res.MediaContainer
        const label = info.friendlyName ?? info.machineIdentifier
        return {
          success: true,
          message: `Connected to Plex "${label}"${info.version ? ` v${info.version}` : ''}`,
          details: { machineIdentifier: info.machineIdentifier, version: info.version },
        }
      } catch (err: unknown) {
        return {
          success: false,
          message: errMsg(err),
        }
      }
    },
  }
}

export type LiveTrackReplacement = {
  artistName: string
  trackName: string
  previousAlbum?: string
}

export type LiveTrackStillMissing = {
  artistName: string
  trackName: string
  album?: string
}

export type SweepLiveTracksResult =
  | {
      success: true
      playlistFound: true
      checked: number
      replaced: LiveTrackReplacement[]
      stillLive: LiveTrackStillMissing[]
    }
  | { success: true; playlistFound: false }
  | { success: false; error: string }

// Manually-triggered maintenance action (no automatic schedule -- see
// PlaylistDeps.sweepLiveTracks) for playlists that were populated before the
// studio-preference matching fixes landed, or that picked up a live/acoustic
// version some other way (e.g. isAlternateVersionCandidate's own detection
// gaps). Import playlists don't persist which Plex track they matched to
// anywhere in DJ Llama's own DB (see executePlaylistImport), so this reads
// the playlist's *actual current Plex items* rather than any local record,
// and only touches the ones flagged live -- no full re-search of every track,
// unlike a regenerate.
export async function sweepPlaylistLiveTracks(
  config: PlexPlaylistConfig,
  playlistName: string,
): Promise<SweepLiveTracksResult> {
  const helpers = createPlexHelpers(config)
  try {
    const ratingKey = await helpers.findPlaylistRatingKey(playlistName)
    if (!ratingKey) return { success: true, playlistFound: false }

    const items = await helpers.getPlaylistItems(ratingKey)
    const flagged = items.filter((item) =>
      isAlternateVersionCandidate({ title: item.title, album: item.parentTitle }),
    )

    const replaced: LiveTrackReplacement[] = []
    const stillLive: LiveTrackStillMissing[] = []
    if (flagged.length === 0) {
      return { success: true, playlistFound: true, checked: items.length, replaced, stillLive }
    }

    const machineId = await helpers.getMusicMachineId()

    for (const item of flagged) {
      const artistName = item.grandparentTitle ?? ''
      const trackName = item.title
      const outcome = await helpers.searchTrack(artistName, stripSearchQualifier(trackName))

      if (!outcome.ratingKey || outcome.ratingKey === item.ratingKey) {
        // Either nothing else matched, or the only thing Plex has for this
        // song is the same live recording already in the playlist -- a
        // genuine "studio version isn't in the library" gap, not a bug.
        stillLive.push({ artistName, trackName, album: item.parentTitle })
        continue
      }

      await helpers.putOnce(
        `/playlists/${ratingKey}/items?uri=${encodeURIComponent(
          `server://${machineId}/com.plexapp.plugins.library/library/metadata/${outcome.ratingKey}`,
        )}`,
      )
      await helpers.deleteOnce(`/playlists/${ratingKey}/items/${item.playlistItemID}`)

      replaced.push({ artistName, trackName, previousAlbum: item.parentTitle })
    }

    return { success: true, playlistFound: true, checked: items.length, replaced, stillLive }
  } catch (err: unknown) {
    return { success: false, error: errMsg(err) }
  }
}
