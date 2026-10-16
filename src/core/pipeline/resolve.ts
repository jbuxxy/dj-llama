import { type AudiodbClient, RateLimitedError } from '@/core/clients/audiodb'
import { extractImages, type ImageEntry } from '@/core/clients/image-utils'
import type {
  MBArtist,
  MBReleaseGroup,
  MBSearchResult,
  RecordingReleaseGroupLookup,
} from '@/core/clients/musicbrainz'
import { parseYear } from '@/core/clients/musicbrainz'
import type { DiscoveredArtist, PipelineProgress, ResolvedArtist } from '@/core/types'

interface MusicBrainzClient {
  lookupArtist: (mbid: string) => Promise<MBArtist>
  searchArtist: (query: string) => Promise<MBSearchResult>
  extractStreamingUrls: (
    relations: Array<{ type: string; url?: { resource: string } }>,
  ) => Record<string, string>
  getReleaseGroups?: (
    artistMbid: string,
  ) => Promise<Array<{ id: string; title: string; type: string; firstReleaseDate?: string }>>
}

interface LidarrLookupClient {
  lookupArtist: (term: string) => Promise<unknown[]>
}

interface FanartClient {
  getArtistImages: (mbid: string) => Promise<{ url?: string; logoUrl?: string }>
}

interface MusicinfoClient {
  lookupArtistImages: (mbid: string) => Promise<{ url?: string; logoUrl?: string }>
}

/** Fraction of discovery genres found in MB tags. Returns -1 when either list is empty (no data). */
function genreOverlapScore(discoveryGenres: string[], mbTags: Array<{ name: string }>): number {
  if (discoveryGenres.length === 0 || mbTags.length === 0) return -1
  const mbGenres = new Set(mbTags.map((t) => t.name.toLowerCase()))
  const matches = discoveryGenres.filter((g) => mbGenres.has(g.toLowerCase()))
  return matches.length / discoveryGenres.length
}

export async function resolve(
  discovered: DiscoveredArtist[],
  mb: MusicBrainzClient,
  onProgress?: (progress: PipelineProgress) => void,
  lidarr?: LidarrLookupClient | null,
  fanart?: FanartClient | null,
  musicinfo?: MusicinfoClient | null,
  audiodb?: AudiodbClient | null,
  promoteSuggestedAlbums = false,
): Promise<ResolvedArtist[]> {
  // Album-kind discoveries (gap-fill / release-radar) carry a releaseGroupMbid and
  // must each resolve to their OWN recommendation -- one per release group, even
  // when several share an artist. They skip the artist-dedup grouping below.
  const albumDiscovered = discovered.filter((d) => d.releaseGroupMbid)
  const artistDiscovered = discovered.filter((d) => !d.releaseGroupMbid)

  // Group artist-kind by MBID (if known) then by name, to deduplicate
  const byMbid = new Map<string, DiscoveredArtist[]>()
  const byName = new Map<string, DiscoveredArtist[]>()

  for (const artist of artistDiscovered) {
    if (artist.mbid) {
      const key = artist.mbid
      const existing = byMbid.get(key) ?? []
      existing.push(artist)
      byMbid.set(key, existing)
    } else {
      const key = artist.name.toLowerCase()
      const existing = byName.get(key) ?? []
      existing.push(artist)
      byName.set(key, existing)
    }
  }

  // Group album-kind by release group: one resolved rec per release group.
  const byReleaseGroup = new Map<string, DiscoveredArtist[]>()
  for (const d of albumDiscovered) {
    const key = d.releaseGroupMbid as string
    const existing = byReleaseGroup.get(key) ?? []
    existing.push(d)
    byReleaseGroup.set(key, existing)
  }

  const total = byMbid.size + byName.size + byReleaseGroup.size
  let current = 0
  const resolved: ResolvedArtist[] = []

  onProgress?.({
    stage: 'resolve',
    current: 0,
    total,
    message: 'Starting resolution',
  })

  // Resolve artists that already have MBIDs
  for (const [mbid, discoveries] of byMbid) {
    current++
    const artistName = discoveries[0]?.name ?? mbid
    onProgress?.({
      stage: 'resolve',
      current,
      total,
      message: `Resolving ${artistName}...`,
    })

    try {
      const mbArtist = await mb.lookupArtist(mbid)
      resolved.push(
        await buildResolvedArtist(
          mbArtist,
          discoveries,
          mb,
          lidarr,
          fanart,
          musicinfo,
          audiodb,
          promoteSuggestedAlbums,
        ),
      )
    } catch {
      // Drop unresolvable
    }
  }

  // Search MB for artists without MBIDs
  for (const [_nameLower, discoveries] of byName) {
    current++
    const firstName = discoveries[0]?.name ?? ''
    onProgress?.({
      stage: 'resolve',
      current,
      total,
      message: `Searching ${firstName}...`,
    })
    if (!firstName) continue

    try {
      const searchResult = await mb.searchArtist(firstName)
      const discoveryGenres = discoveries.flatMap((d) => d.genres ?? [])
      const maxCandidates = discoveryGenres.length > 0 ? 5 : 1

      let bestCandidate: MBArtist | null = null
      let bestOverlap = -Infinity

      for (const hit of searchResult.artists.slice(0, maxCandidates)) {
        if (byMbid.has(hit.id)) continue
        try {
          const mbArtist = await mb.lookupArtist(hit.id)

          if (discoveryGenres.length === 0) {
            // No genre data - trust MB search ranking
            bestCandidate = mbArtist
            break
          }

          const overlap = genreOverlapScore(discoveryGenres, mbArtist.tags ?? [])
          if (overlap > bestOverlap) {
            bestCandidate = mbArtist
            bestOverlap = overlap
          }
          if (overlap > 0) break // good enough
        } catch {
          // skip failed lookup, try next candidate
        }
      }

      // Skip when AI provided genres but the best MB candidate has zero overlap --
      // strong signal that the AI confused similarly-named artists (e.g. "Digital
      // Underground" vs "The Velvet Underground"). bestOverlap of -1 means MB had
      // no tags to compare, which is fine - many lesser-known artists lack tags.
      if (discoveryGenres.length > 0 && bestOverlap === 0) continue

      if (!bestCandidate || byMbid.has(bestCandidate.id)) continue
      resolved.push(
        await buildResolvedArtist(
          bestCandidate,
          discoveries,
          mb,
          lidarr,
          fanart,
          musicinfo,
          audiodb,
          promoteSuggestedAlbums,
        ),
      )
      byMbid.set(bestCandidate.id, discoveries)
    } catch {
      // Drop unresolvable
    }
  }

  // Resolve album-kind discoveries: one rec per release group, caching the artist
  // MB lookup so N missing albums for one artist cost a single lookupArtist call.
  const artistLookupCache = new Map<string, MBArtist>()
  for (const [, discoveries] of byReleaseGroup) {
    current++
    const artistMbid = discoveries[0]?.mbid
    const albumTitle = discoveries[0]?.suggestedAlbum ?? ''
    onProgress?.({
      stage: 'resolve',
      current,
      total,
      message: `Resolving ${albumTitle}...`,
    })
    if (!artistMbid) continue
    try {
      let mbArtist = artistLookupCache.get(artistMbid)
      if (!mbArtist) {
        mbArtist = await mb.lookupArtist(artistMbid)
        artistLookupCache.set(artistMbid, mbArtist)
      }
      resolved.push(
        await buildResolvedArtist(
          mbArtist,
          discoveries,
          mb,
          lidarr,
          fanart,
          musicinfo,
          audiodb,
          promoteSuggestedAlbums,
        ),
      )
    } catch {
      // Drop unresolvable
    }
  }

  onProgress?.({
    stage: 'resolve',
    current: total,
    total,
    message: 'Resolution complete',
  })

  // Final dedup. Album-kind keys on (artist, release group) so distinct albums for
  // one artist both survive; artist-kind keys on the artist mbid as before.
  const seenKeys = new Set<string>()
  return resolved.filter((a) => {
    const key =
      a.kind === 'album' && a.releaseGroupMbid ? `${a.mbid}::${a.releaseGroupMbid}` : a.mbid
    if (seenKeys.has(key)) return false
    seenKeys.add(key)
    return true
  })
}

function normalizeTitle(title: string): string {
  return title
    .replace(/\s*\(.*\)\s*$/, '')
    .trim()
    .toLowerCase()
}

/**
 * Picks a specific album to recommend for an artist-kind candidate that has
 * no AI-suggested title (e.g. similar-artist/label/listen-history discovery
 * modes, which only ever produce an artist name). Recommendations are
 * album-focused end to end, so every candidate needs one real release group
 * to attach to rather than surfacing as a bare artist. Most-recent Album/EP
 * is used as the heuristic -- no extra AI round-trip per candidate, and it's
 * a reasonable proxy for "what would this artist's page lead with."
 */
async function pickFallbackAlbum(
  artistMbid: string,
  mb: MusicBrainzClient,
): Promise<
  { releaseGroupId?: string; title: string; type?: string; firstReleaseDate?: string } | undefined
> {
  if (!mb.getReleaseGroups) return undefined
  try {
    // mb.getReleaseGroups queries MusicBrainz with "AND NOT secondarytype:*"
    // (see its own doc comment in clients/musicbrainz.ts) and defaults to
    // primary types Album/EP only -- a Live, Broadcast, Compilation, etc.
    // release-group is structurally impossible to get back from this call,
    // so no extra filtering is needed here to keep this fallback studio-only.
    const releaseGroups = await mb.getReleaseGroups(artistMbid)
    if (releaseGroups.length === 0) return undefined
    const sorted = [...releaseGroups].sort((a, b) => {
      const dateA = a.firstReleaseDate ? Date.parse(a.firstReleaseDate) : Number.NaN
      const dateB = b.firstReleaseDate ? Date.parse(b.firstReleaseDate) : Number.NaN
      if (Number.isNaN(dateA) && Number.isNaN(dateB)) return 0
      if (Number.isNaN(dateA)) return 1
      if (Number.isNaN(dateB)) return -1
      return dateB - dateA
    })
    const best = sorted[0]
    if (!best) return undefined
    return {
      releaseGroupId: best.id,
      title: best.title,
      type: best.type,
      firstReleaseDate: best.firstReleaseDate,
    }
  } catch {
    return undefined
  }
}

async function matchSuggestedAlbum(
  suggestedAlbum: string,
  artistMbid: string,
  mb: MusicBrainzClient,
): Promise<{ releaseGroupId?: string; title: string; type?: string; firstReleaseDate?: string }> {
  if (!mb.getReleaseGroups) {
    return { title: suggestedAlbum }
  }

  try {
    // Same structural guarantee as pickFallbackAlbum above: mb.getReleaseGroups
    // excludes every secondary-typed (Live, Compilation, etc.) release-group
    // at the query level, so nothing here can match a live album.
    const releaseGroups = await mb.getReleaseGroups(artistMbid)

    // Step 1: exact title match (case-insensitive)
    const exact = releaseGroups.find(
      (rg) => rg.title.toLowerCase() === suggestedAlbum.toLowerCase(),
    )
    if (exact) {
      return {
        releaseGroupId: exact.id,
        title: exact.title,
        type: exact.type,
        firstReleaseDate: exact.firstReleaseDate,
      }
    }

    // Step 2: normalized match (strip parenthetical suffixes)
    const normalizedSuggestion = normalizeTitle(suggestedAlbum)
    const normalized = releaseGroups.find((rg) => normalizeTitle(rg.title) === normalizedSuggestion)
    if (normalized) {
      return {
        releaseGroupId: normalized.id,
        title: normalized.title,
        type: normalized.type,
        firstReleaseDate: normalized.firstReleaseDate,
      }
    }

    // Step 3: no match - return free text without releaseGroupId
    return { title: suggestedAlbum }
  } catch {
    return { title: suggestedAlbum }
  }
}

async function buildResolvedArtist(
  mbArtist: MBArtist,
  discoveries: DiscoveredArtist[],
  mb: MusicBrainzClient,
  lidarr?: LidarrLookupClient | null,
  fanart?: FanartClient | null,
  musicinfo?: MusicinfoClient | null,
  audiodb?: AudiodbClient | null,
  promoteSuggestedAlbums = false,
): Promise<ResolvedArtist> {
  const tags = (mbArtist.tags ?? []).map((t) => t.name)
  const streamingUrls = mb.extractStreamingUrls(mbArtist.relations ?? [])

  // AudioDB first, then Lidarr -> fanart.tv -> musicinfo.pro
  const imageResult = await fetchArtistImage(
    mbArtist.id,
    mbArtist.name,
    audiodb,
    lidarr,
    fanart,
    musicinfo,
  )

  // Album-kind: a discovery from release-radar already knows the real
  // release-group id -- use it directly and skip the lossy title match.
  const albumDiscovery = discoveries.find((d) => d.releaseGroupMbid)
  let kind: 'artist' | 'album' | undefined
  let releaseGroupMbid: string | undefined
  let releaseDate: string | undefined
  let suggestedAlbum:
    | { releaseGroupId?: string; title: string; type?: string; firstReleaseDate?: string }
    | undefined

  if (albumDiscovery?.releaseGroupMbid) {
    kind = 'album'
    releaseGroupMbid = albumDiscovery.releaseGroupMbid
    releaseDate = albumDiscovery.releaseDate
    suggestedAlbum = {
      releaseGroupId: albumDiscovery.releaseGroupMbid,
      title: albumDiscovery.suggestedAlbum ?? '',
    }
  } else {
    // Artist-kind: recover a release-group id from the free-text AI title.
    const aiSuggestion = discoveries.find((d) => d.suggestedAlbum)?.suggestedAlbum
    const matched = aiSuggestion
      ? await matchSuggestedAlbum(aiSuggestion, mbArtist.id, mb)
      : undefined
    // No AI-suggested title (similar-artist/label/listen-history discovery
    // modes only ever produce an artist name) -- fall back to the artist's
    // most recent Album/EP so recommendations stay album-focused end to end.
    const fallback =
      promoteSuggestedAlbums && !matched?.releaseGroupId
        ? await pickFallbackAlbum(mbArtist.id, mb)
        : undefined
    const resolvedAlbum = matched?.releaseGroupId ? matched : fallback
    suggestedAlbum = resolvedAlbum ?? matched
    if (promoteSuggestedAlbums && resolvedAlbum?.releaseGroupId) {
      kind = 'album'
      releaseGroupMbid = resolvedAlbum.releaseGroupId
      releaseDate = resolvedAlbum.firstReleaseDate
    }
  }

  return {
    mbid: mbArtist.id,
    name: mbArtist.name,
    disambiguation: mbArtist.disambiguation,
    tags,
    genres: tags,
    imageUrl: imageResult.url,
    logoUrl: imageResult.logoUrl,
    imageFailed: imageResult.failed,
    streamingUrls,
    suggestedAlbum,
    discoveries,
    beginYear: parseYear(mbArtist['life-span']?.begin),
    endYear: parseYear(mbArtist['life-span']?.end),
    kind,
    releaseGroupMbid,
    releaseDate,
  }
}

export async function fetchArtistImage(
  mbid: string,
  name: string,
  audiodb?: AudiodbClient | null,
  lidarr?: LidarrLookupClient | null,
  fanart?: FanartClient | null,
  musicinfo?: MusicinfoClient | null,
): Promise<{ url?: string; logoUrl?: string; failed: boolean }> {
  let audiodbCompleted = !audiodb

  // Primary: AudioDB (MBID first, then name search when MBID yields nothing).
  // A rate-limit error skips straight to the fallback chain (no name search).
  if (audiodb) {
    try {
      const byMbid = await audiodb.getArtistImages(mbid)
      if (byMbid.url) return { ...byMbid, failed: false }
      if (name) {
        const byName = await audiodb.searchArtistByName(name)
        if (byName.url) return { ...byName, failed: false }
      }
      audiodbCompleted = true
    } catch (err) {
      if (!(err instanceof RateLimitedError)) {
        console.warn(`[resolve] audiodb image lookup failed for ${mbid}:`, err)
      }
    }
  }

  // Fallback chain: Lidarr -> fanart.tv -> musicinfo.pro.
  // AudioDB stays the sequential primary above; the remaining fallbacks only
  // fire when it misses, so we run them concurrently and pick the first hit by
  // priority order (Lidarr > fanart > musicinfo) to match the old short-circuit
  // winner while shaving the tail latency of the miss case.
  type Hit = { url?: string; logoUrl?: string }
  type LookupOutcome = { hit: Hit | null; completed: boolean }
  const tasks: Array<{ priority: number; run: () => Promise<LookupOutcome> }> = []

  if (lidarr) {
    tasks.push({
      priority: 0,
      run: async () => {
        try {
          const results = await lidarr.lookupArtist(`lidarr:${mbid}`)
          const artist = results[0] as { images?: ImageEntry[] } | undefined
          if (artist?.images?.length) {
            const extracted = extractImages(artist.images)
            if (extracted.url) return { hit: extracted, completed: true }
          }
          return { hit: null, completed: true }
        } catch (err) {
          console.warn(`[resolve] Lidarr image lookup failed for ${mbid}:`, err)
          return { hit: null, completed: false }
        }
      },
    })
  }

  if (fanart) {
    tasks.push({
      priority: 1,
      run: async () => {
        try {
          const result = await fanart.getArtistImages(mbid)
          return { hit: result.url ? result : null, completed: true }
        } catch (err) {
          console.warn(`[resolve] fanart.tv image lookup failed for ${mbid}:`, err)
          return { hit: null, completed: false }
        }
      },
    })
  }

  if (musicinfo) {
    tasks.push({
      priority: 2,
      run: async () => {
        try {
          const result = await musicinfo.lookupArtistImages(mbid)
          return { hit: result.url ? result : null, completed: true }
        } catch (err) {
          console.warn(`[resolve] musicinfo image lookup failed for ${mbid}:`, err)
          return { hit: null, completed: false }
        }
      },
    })
  }

  const settled = await Promise.allSettled(tasks.map((task) => task.run()))
  const hit = tasks
    .map((task, i) => {
      const result = settled[i]
      return {
        priority: task.priority,
        value: result?.status === 'fulfilled' ? result.value.hit : null,
      }
    })
    .filter((candidate) => candidate.value?.url)
    .sort((a, b) => a.priority - b.priority)[0]

  if (hit?.value) return { ...hit.value, failed: false }

  const hasConfiguredProvider = Boolean(audiodb ?? lidarr ?? fanart ?? musicinfo)
  const allFallbacksCompleted = settled.every(
    (result) => result.status === 'fulfilled' && result.value.completed,
  )
  const completeMiss = hasConfiguredProvider && audiodbCompleted && allFallbacksCompleted

  if (!completeMiss) return { failed: false }
  return { failed: !fanart && !musicinfo }
}

export type TrackCandidate = {
  artistName: string
  trackName: string
  /** Recording MBID, when the signal carried one directly. */
  recordingMbid?: string
  similarityScore: number
  aiReasoning?: string
  source: string
}

interface MusicBrainzTrackClient {
  lookupRecordingWithReleaseGroups: (mbid: string) => Promise<RecordingReleaseGroupLookup | null>
  searchRecording: (
    artistName: string,
    trackName: string,
  ) => Promise<RecordingReleaseGroupLookup | null>
  lookupArtist: (mbid: string) => Promise<MBArtist>
  extractStreamingUrls: (
    relations: Array<{ type: string; url?: { resource: string } }>,
  ) => Record<string, string>
}

// Secondary types that still describe a genuinely different recording/edit
// (not just a different packaging of the same original performance) --
// these are dropped outright regardless of tier, same as before: a remix or
// soundtrack cut is never an acceptable substitute for the track itself.
const DISQUALIFYING_SECONDARY_TYPES = new Set([
  'Remix',
  'Soundtrack',
  'Spokenword',
  'Interview',
  'Audiobook',
  'Audio drama',
  'DJ-mix',
  'Mixtape/Street',
  'Demo',
  'Field recording',
])

/**
 * A recording can appear on several release-groups (the original album, a
 * greatest-hits compilation, an EP, a single, a live album, a reissue,
 * etc.) -- ranked so a genuine original release always wins over a
 * repackaging, and a repackaging always wins over a live recording of the
 * same performance:
 *   0. Album (a true studio album, no secondary type)
 *   1. Compilation (e.g. "Greatest Hits") -- still the same studio
 *      recording, just repackaged, so it's a fine substitute when no true
 *      original album is available
 *   2. EP
 *   3. Single/Other (an artist's own original single -- e.g. an artist who
 *      releases mostly singles rather than albums)
 *   4. Live or Broadcast (e.g. a BBC session) -- last resort; only picked
 *      when nothing above is available
 * A release group carrying both Compilation and Live/Broadcast (a "live
 * greatest hits") is treated as Live/Broadcast, the worse of the two. Anything with a
 * different-recording secondary type (Remix/Soundtrack/etc., see
 * DISQUALIFYING_SECONDARY_TYPES) is dropped outright, not merely
 * deprioritized -- unlike a compilation or live cut, that's not the same
 * recording at all. Within a tier, earliest release date wins, as the proxy
 * for "the original album/single this track is from" rather than a later
 * repackaging.
 * Returns undefined when every release-group for this recording carries a
 * disqualifying secondary type -- which, with `excludeLive`, now includes
 * Live/Broadcast too (see that option below).
 */
// pickBestReleaseGroup's ranking for one release-group (lower = more likely
// the original album the track came from); undefined = disqualified. Exported
// so callers ranking several candidates (manual track search) use the exact
// same rules.
export function originalReleaseTier(
  rg: MBReleaseGroup,
  options?: { excludeLive?: boolean },
): number | undefined {
  const secondary = rg.secondaryTypes ?? []
  if (secondary.some((t) => DISQUALIFYING_SECONDARY_TYPES.has(t))) return undefined
  if (secondary.includes('Live') || secondary.includes('Broadcast')) {
    return options?.excludeLive ? undefined : 4
  }
  if (secondary.includes('Compilation')) return 1
  if (rg.type === 'Album') return 0
  if (rg.type === 'EP') return 2
  return 3
}

export function pickBestReleaseGroup(
  releaseGroups: MBReleaseGroup[],
  options?: {
    // Live/Broadcast is tier 4 (last resort) by default -- right for an
    // explicit user action like song-identify, where the thing playing
    // really might *be* a live recording and reporting it as the studio
    // original would misidentify it. The automated paths that request
    // albums the user never specifically asked for (track-based
    // recommendation discovery, playlist-import's missing-track resolution)
    // pass this instead: a live album is never an acceptable stand-in for
    // "the album" there, confirmed as an actual user complaint after a
    // recommendation surfaced one. Manual track search ranks with
    // originalReleaseTier directly and keeps live at tier 4.
    excludeLive?: boolean
  },
): MBReleaseGroup | undefined {
  const ranked = releaseGroups
    .map((rg) => ({ rg, tier: originalReleaseTier(rg, options) }))
    .filter((x): x is { rg: MBReleaseGroup; tier: number } => x.tier !== undefined)
  if (ranked.length === 0) return undefined

  return ranked.sort((a, b) => {
    const tierDiff = a.tier - b.tier
    if (tierDiff !== 0) return tierDiff
    const dateA = a.rg.firstReleaseDate
      ? Date.parse(a.rg.firstReleaseDate)
      : Number.POSITIVE_INFINITY
    const dateB = b.rg.firstReleaseDate
      ? Date.parse(b.rg.firstReleaseDate)
      : Number.POSITIVE_INFINITY
    return dateA - dateB
  })[0]?.rg
}

/**
 * Track-based discovery's resolver: given a specific track (from
 * discover-tracks.ts), finds which real album it's from via MusicBrainz and
 * builds a ResolvedArtist scoped to that one release-group -- deliberately
 * NOT going through resolve()'s artist-dedup grouping above, since a track
 * candidate already carries its own definite recording->release-group path
 * and needs no name-search/genre-overlap disambiguation. Returns null (never
 * throws) when the recording or its albums can't be found -- callers should
 * drop the candidate, not fail the whole pipeline run.
 */
export async function resolveTrackToAlbum(
  track: TrackCandidate,
  mb: MusicBrainzTrackClient,
  audiodb?: AudiodbClient | null,
  lidarr?: LidarrLookupClient | null,
  fanart?: FanartClient | null,
  musicinfo?: MusicinfoClient | null,
): Promise<ResolvedArtist | null> {
  try {
    const lookup = track.recordingMbid
      ? await mb.lookupRecordingWithReleaseGroups(track.recordingMbid)
      : null
    // A recording-MBID-only candidate (ListenBrainz) has no title to search by.
    let recording =
      lookup ??
      (track.trackName ? await mb.searchRecording(track.artistName, track.trackName) : null)
    if (!recording) return null

    let releaseGroup = pickBestReleaseGroup(recording.releaseGroups, { excludeLive: true })

    // The resolved recording MBID can itself be a remix/soundtrack/etc.
    // recording (a distinct MBID from the studio one) whose release-groups
    // are all disqualifying types (see DISQUALIFYING_SECONDARY_TYPES, and
    // excludeLive above) -- pickBestReleaseGroup rejects those rather than
    // returning one (a compilation release-group, by contrast, is still an
    // accepted last-resort tier), so retry via title search for a recording
    // that actually has an original-recording release before giving up on
    // this track entirely.
    if (!releaseGroup && lookup && track.trackName) {
      const searched = await mb.searchRecording(track.artistName, track.trackName)
      if (searched && searched.recordingMbid !== recording.recordingMbid) {
        const searchedReleaseGroup = pickBestReleaseGroup(searched.releaseGroups, {
          excludeLive: true,
        })
        if (searchedReleaseGroup) {
          recording = searched
          releaseGroup = searchedReleaseGroup
        }
      }
    }

    if (!releaseGroup) return null

    const mbArtist = await mb.lookupArtist(recording.artistMbid)
    const tags = (mbArtist.tags ?? []).map((t) => t.name)
    const imageResult = await fetchArtistImage(
      mbArtist.id,
      mbArtist.name,
      audiodb,
      lidarr,
      fanart,
      musicinfo,
    )

    return {
      mbid: mbArtist.id,
      name: mbArtist.name,
      disambiguation: mbArtist.disambiguation,
      tags,
      genres: tags,
      imageUrl: imageResult.url,
      logoUrl: imageResult.logoUrl,
      imageFailed: imageResult.failed,
      streamingUrls: mb.extractStreamingUrls(mbArtist.relations ?? []),
      suggestedAlbum: {
        releaseGroupId: releaseGroup.id,
        title: releaseGroup.title,
        type: releaseGroup.type,
      },
      discoveries: [
        {
          name: mbArtist.name,
          mbid: mbArtist.id,
          similarityScore: track.similarityScore,
          aiReasoning: track.aiReasoning,
          source: track.source,
          releaseGroupMbid: releaseGroup.id,
          releaseDate: releaseGroup.firstReleaseDate,
        },
      ],
      beginYear: parseYear(mbArtist['life-span']?.begin),
      endYear: parseYear(mbArtist['life-span']?.end),
      kind: 'album',
      releaseGroupMbid: releaseGroup.id,
      releaseDate: releaseGroup.firstReleaseDate,
    }
  } catch {
    return null
  }
}

/**
 * Merges resolveTrackToAlbum results that land on the same real (artist,
 * release-group) pair -- e.g. the artist-similarity and track-similarity AI
 * passes both independently suggesting a track from the same album -- into one
 * ResolvedArtist with both `discoveries` entries combined. This is what lets
 * score()'s existing multi-source-consensus calc (`uniqueSources.size / 4`)
 * apply at the track level exactly as it already does for artist-similarity,
 * with zero changes to score.ts itself.
 */
export function mergeTrackResolutions(resolutions: ResolvedArtist[]): ResolvedArtist[] {
  const byKey = new Map<string, ResolvedArtist>()
  for (const r of resolutions) {
    const key = `${r.mbid}::${r.releaseGroupMbid}`
    const existing = byKey.get(key)
    if (existing) {
      existing.discoveries.push(...r.discoveries)
    } else {
      byKey.set(key, { ...r, discoveries: [...r.discoveries] })
    }
  }
  return [...byKey.values()]
}
