import { type PopularAlbumCandidate, selectPopularReleaseGroups } from '@/core/albums/popular'
import { createMusicBrainzClient } from '@/core/clients/musicbrainz'
import { findExactArtistByName, getPopularAlbumsForArtist } from '@/core/clients/spotify'
import type { TargetAddOptions } from '@/core/targets/types'
import { mergePreferences } from '@/db/schema'
import type { AppDependencies } from '@/server'

export type MonitorOption = 'all' | 'new' | 'none' | 'selected' | 'popular'

export type ApprovalArtist = {
  mbid: string
  name: string
  streamingUrls?: Record<string, string> | null
}

const POPULAR_ALBUM_LIMIT = 3

function extractSpotifyArtistId(url?: string): string | null {
  if (!url) return null
  const match = url.match(/open\.spotify\.com\/artist\/([^/?#]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/** Distinguishes "no popularity source available" from "source had no usable albums". */
export type PopularAlbumsErrorCode = 'no_source' | 'no_match'

export class PopularAlbumsError extends Error {
  constructor(
    readonly code: PopularAlbumsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PopularAlbumsError'
  }
}

/** Top albums for an artist via Spotify's catalog; empty when the artist can't be found there. */
async function spotifyPopularCandidates(
  _deps: AppDependencies,
  _userId: number,
  artist: ApprovalArtist,
): Promise<PopularAlbumCandidate[]> {
  try {
    const spotifyId =
      extractSpotifyArtistId(artist.streamingUrls?.spotify) ??
      (await findExactArtistByName(artist.name))?.id
    if (!spotifyId) return []
    return await getPopularAlbumsForArtist(spotifyId, POPULAR_ALBUM_LIMIT)
  } catch {
    // Lookup failed: let the next source try.
    return []
  }
}

async function resolvePopularAlbumIds(
  deps: AppDependencies,
  userId: number | undefined,
  artist: ApprovalArtist | undefined,
): Promise<string[]> {
  if (!userId) {
    throw new Error('Popular album approval requires a signed-in user')
  }
  if (!artist) {
    throw new Error('Popular album approval requires artist metadata')
  }

  // MB release groups are the matching target for whichever popularity source wins.
  const releaseGroups = await createMusicBrainzClient().getReleaseGroups(artist.mbid)

  const candidates = await spotifyPopularCandidates(deps, userId, artist)
  if (candidates.length === 0) {
    throw new PopularAlbumsError(
      'no_source',
      `No popularity source returned albums for ${artist.name}. Connect Spotify.`,
    )
  }

  const selected = selectPopularReleaseGroups(candidates, releaseGroups, POPULAR_ALBUM_LIMIT)
  if (selected.length === 0) {
    throw new PopularAlbumsError(
      'no_match',
      `Could not map popular albums to library albums for ${artist.name}.`,
    )
  }

  return selected.map((album) => album.id)
}

/**
 * Build Lidarr add options from per-user preferences (with global fallback).
 * Also used by the requests workflow (server/routes/requests.ts).
 */
export async function buildAddOptions(
  deps: AppDependencies,
  userId: number | undefined,
  artist: ApprovalArtist | undefined,
  overrides: {
    monitorOption?: MonitorOption
    selectedAlbumIds?: string[]
    qualityProfileId?: number
    metadataProfileId?: number
    rootFolderId?: number
  },
): Promise<TargetAddOptions> {
  const settings = await deps.getSettings()
  const globalPrefs = settings?.preferences ?? null
  // Lidarr's quality/metadata profile and root folder are admin-only global
  // defaults -- always read from global settings, never a per-user override
  // (unlike the ad-hoc per-approval overrides below, which are a deliberate,
  // separate feature: an explicit choice made at the moment of approving one
  // specific item, not a standing preference).
  const prefs = mergePreferences(globalPrefs)
  const popularAlbumIds =
    overrides.monitorOption === 'popular'
      ? await resolvePopularAlbumIds(deps, userId, artist)
      : undefined

  return {
    ...(overrides.monitorOption != null
      ? {
          monitorOption:
            overrides.monitorOption === 'popular' ? 'selected' : overrides.monitorOption,
        }
      : {}),
    ...(popularAlbumIds
      ? { selectedAlbumIds: popularAlbumIds }
      : overrides.selectedAlbumIds
        ? { selectedAlbumIds: overrides.selectedAlbumIds }
        : {}),
    qualityProfileId: overrides.qualityProfileId ?? prefs.qualityProfileId,
    metadataProfileId: overrides.metadataProfileId ?? prefs.metadataProfileId,
    rootFolderId: overrides.rootFolderId ?? prefs.rootFolderId,
  }
}
