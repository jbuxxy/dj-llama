import PQueue from 'p-queue'
import { VERSION } from '@/version'

const BASE_URL = 'https://musicbrainz.org/ws/2'
const USER_AGENT = `DJLlama/${VERSION} (https://github.com/jbuxxy/dj-llama)`

export type MBArtist = {
  id: string
  name: string
  disambiguation?: string
  'life-span'?: {
    begin?: string
    end?: string
    ended?: boolean
  }
  tags?: Array<{ name: string; count: number }>
  relations?: MBRelation[]
}

/** Extract year from MB date string ("1985", "1985-03", "1985-03-15") */
export function parseYear(dateStr?: string): number | undefined {
  if (!dateStr) return undefined
  const year = Number.parseInt(dateStr.substring(0, 4), 10)
  return Number.isNaN(year) ? undefined : year
}

export type MBRelation = {
  type: string
  direction?: 'forward' | 'backward'
  url?: { resource: string }
  // Present on artist-artist relations (inc=artist-rels): the related artist.
  artist?: { id: string; name: string; disambiguation?: string }
}

export type MBSearchResult = {
  artists: Array<{
    id: string
    name: string
    disambiguation?: string
    tags?: Array<{ name: string; count: number }>
    score: number
    // Present when the search request includes inc=aliases. MB's canonical
    // `name` is often a stylized form (e.g. "*NSYNC") that differs from the
    // common name a source library reports ("NSYNC") -- aliases carry that
    // common form, so matching needs to check both.
    aliases?: Array<{ name: string }>
  }>
}

export type MBReleaseGroup = {
  id: string
  title: string
  type: string
  firstReleaseDate?: string
  /** e.g. ["Compilation"], ["Live"] -- present when this isn't a plain studio release. */
  secondaryTypes?: string[]
}

export type MBRecording = {
  id: string
  title: string
  isrcs?: string[]
}

export type MBTrack = {
  title: string
  position: string
  length?: number
}

export type RecordingArtistCredit = {
  recordingMbid: string
  artistMbid: string
  artistName: string
}

type MBRecordingLookup = {
  id: string
  title: string
  'artist-credit'?: Array<{
    artist: { id: string; name: string }
  }>
}

type MBRecordingWithReleasesLookup = MBRecordingLookup & {
  releases?: Array<{
    id: string
    'release-group'?: {
      id: string
      title: string
      'primary-type'?: string
      'secondary-types'?: string[]
      'first-release-date'?: string
      'artist-credit'?: Array<{
        artist: { id: string; name: string }
      }>
    }
  }>
}

export type RecordingReleaseGroupLookup = RecordingArtistCredit & {
  releaseGroups: MBReleaseGroup[]
}

export type StreamingUrls = {
  spotify?: string
  youtube?: string
  appleMusic?: string
  deezer?: string
  soundcloud?: string
}

const STREAMING_PATTERNS: Array<[RegExp, keyof StreamingUrls]> = [
  [/spotify\.com/i, 'spotify'],
  [/music\.youtube\.com/i, 'youtube'],
  [/youtube\.com/i, 'youtube'],
  [/music\.apple\.com/i, 'appleMusic'],
  [/deezer\.com/i, 'deezer'],
  [/soundcloud\.com/i, 'soundcloud'],
]

const STREAMING_TYPES = new Set(['streaming music', 'free streaming'])

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504])
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 1000
const MAX_RETRY_AFTER_MS = 30_000

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  // HTTP-date form
  const when = Date.parse(header)
  if (Number.isFinite(when)) {
    return Math.min(Math.max(when - Date.now(), 0), MAX_RETRY_AFTER_MS)
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Single shared rate gate. MusicBrainz enforces ~1 req/s per consumer; every
// subsystem (pipeline, library sync, discovery modes, routes) funnels through
// this one queue so concurrent runs can't sum past the ceiling and trigger 503s.
// interval is slightly above 1000ms so this app's own pacing carries a small
// safety margin below the limit rather than riding exactly on it.
const sharedQueue = new PQueue({ concurrency: 1, interval: 1150, intervalCap: 1 })

/**
 * Requests currently queued or in flight on the shared rate gate above. A
 * caller doing bulk MB-bound work (library sync, gap-fill) can surface this
 * so a stalled progress bar reads as "MusicBrainz is busy" instead of
 * looking hung -- two concurrent syncs can genuinely queue behind each other
 * for minutes at concurrency 1, with no errors or retries to log in between.
 */
export function getMusicBrainzQueueDepth(): number {
  return sharedQueue.size + sharedQueue.pending
}

export function createMusicBrainzClient() {
  const queue = sharedQueue

  async function fetchOnce(path: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      return await fetch(`${BASE_URL}${path}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  // Only the network round-trip is queued; the backoff sleep happens between
  // attempts OUTSIDE the rate-limited slot, and each attempt re-enqueues. This
  // stops one retrying request (e.g. during a 503 storm) from holding the single
  // concurrency slot and stalling all other MB traffic for its whole backoff.
  async function request<T>(path: string): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const res = (await queue.add(() => fetchOnce(path))) as Response

        if (res.ok) {
          return (await res.json()) as T
        }

        // Non-retryable HTTP status: surface immediately.
        if (!TRANSIENT_STATUSES.has(res.status)) {
          throw new Error(`MusicBrainz HTTP ${res.status} for ${path}`)
        }

        // Transient HTTP status: prefer server-provided Retry-After, else
        // exponential backoff with jitter. Final failed attempt throws out.
        if (attempt === MAX_RETRIES) {
          throw new Error(`MusicBrainz HTTP ${res.status} for ${path}`)
        }
        // A Retry-After of 0 (or anything shorter than our own backoff) is not
        // meaningful signal to retry immediately -- during a real 503 storm it
        // was observed driving near-instant re-attempts that just re-hit the
        // same overloaded endpoint, burning all MAX_RETRIES in under a second.
        // Only let the server's value stretch the wait, never shrink it below
        // our own exponential floor.
        const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'))
        const exponential = BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 250
        const backoff = retryAfter !== null ? Math.max(retryAfter, exponential) : exponential
        console.warn(
          `[musicbrainz] HTTP ${res.status} for ${path} (attempt ${attempt + 1}/${MAX_RETRIES + 1}); retrying in ${Math.round(backoff)}ms`,
        )
        await sleep(backoff)
        lastErr = new Error(`MusicBrainz HTTP ${res.status} for ${path}`)
      } catch (err) {
        // Network/timeout errors are retryable. The final attempt rethrows.
        const retryable =
          err instanceof Error &&
          (err.name === 'AbortError' ||
            err instanceof TypeError ||
            /fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(err.message))
        if (!retryable || attempt === MAX_RETRIES) {
          throw err
        }
        const backoff = BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 250
        console.warn(
          `[musicbrainz] ${err instanceof Error ? err.message : String(err)} for ${path} (attempt ${attempt + 1}/${MAX_RETRIES + 1}); retrying in ${Math.round(backoff)}ms`,
        )
        await sleep(backoff)
        lastErr = err
      }
    }
    // Unreachable under normal flow - loop either returns or throws above.
    throw lastErr instanceof Error ? lastErr : new Error(`MusicBrainz request failed for ${path}`)
  }

  function lookupArtist(mbid: string): Promise<MBArtist> {
    const params = new URLSearchParams({ inc: 'tags+url-rels', fmt: 'json' })
    return request<MBArtist>(`/artist/${mbid}?${params}`)
  }

  function searchArtist(query: string): Promise<MBSearchResult> {
    const params = new URLSearchParams({ query, fmt: 'json', inc: 'aliases' })
    return request<MBSearchResult>(`/artist/?${params}`)
  }

  // Uses the Lucene search endpoint (not the plain /release-group?artist=
  // browse) because the browse endpoint's `type` param only matches primary
  // type -- it does NOT exclude secondary types like "Live"/"Compilation",
  // so a browse query for "album|ep|single" still returns every live
  // bootleg release-group an artist has (e.g. 1000+ for a heavily-bootlegged
  // artist like Metallica, vs. ~84 real studio albums/EPs/singles). The
  // Lucene query below excludes anything with a secondary type in one
  // request, which is both correct and far faster to render.
  //
  // Deliberately does NOT have an option to include secondary types: for a
  // heavily-bootlegged artist (Nirvana has 521 Album/EP/Single release-groups
  // once Live/Compilation entries are let back in, vs. 43 without) that blows
  // past MB's hard 100-result page cap, and MB's arid: browse query has no
  // relevance ranking to put official releases first -- verified live that
  // "Nevermind" and "Incesticide" both fall off the first page entirely once
  // the secondary-type exclusion is dropped. searchReleaseGroupByTitle below
  // is the correct way to find a specific Compilation/Live release-group:
  // scoping the query by title too keeps the result set small regardless of
  // how bootlegged the artist's catalog is.
  async function getReleaseGroups(
    artistMbid: string,
    types: readonly string[] = ['Album', 'EP'],
  ): Promise<MBReleaseGroup[]> {
    const primaryClause = types
      .map((type) => `primarytype:${type.charAt(0).toUpperCase()}${type.slice(1).toLowerCase()}`)
      .join(' OR ')
    const query = `arid:${artistMbid} AND (${primaryClause}) AND NOT secondarytype:*`
    const params = new URLSearchParams({ query, fmt: 'json', limit: '100' })
    const data = await request<{
      'release-groups': Array<{
        id: string
        title: string
        'primary-type'?: string
        'first-release-date'?: string
      }>
    }>(`/release-group/?${params}`)
    return (data['release-groups'] ?? []).map((rg) => ({
      id: rg.id,
      title: rg.title,
      type: rg['primary-type'] ?? 'Other',
      firstReleaseDate: rg['first-release-date'],
    }))
  }

  // Targeted fallback for library reconciliation: finds a release-group by
  // title (including Compilation/Live entries getReleaseGroups excludes)
  // without enumerating the artist's whole catalog, so it stays small and
  // accurate even for artists with hundreds of bootleg entries in MB.
  async function searchReleaseGroupByTitle(
    artistMbid: string,
    title: string,
  ): Promise<MBReleaseGroup[]> {
    const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const query = `arid:${artistMbid} AND releasegroup:"${escapedTitle}"`
    const params = new URLSearchParams({ query, fmt: 'json', limit: '10' })
    const data = await request<{
      'release-groups': Array<{
        id: string
        title: string
        'primary-type'?: string
        'first-release-date'?: string
      }>
    }>(`/release-group/?${params}`)
    return (data['release-groups'] ?? []).map((rg) => ({
      id: rg.id,
      title: rg.title,
      type: rg['primary-type'] ?? 'Other',
      firstReleaseDate: rg['first-release-date'],
    }))
  }

  async function getRecordings(artistMbid: string, limit = 25): Promise<MBRecording[]> {
    const params = new URLSearchParams({
      artist: artistMbid,
      fmt: 'json',
      limit: String(limit),
    })
    const data = await request<{
      recordings?: Array<{
        id: string
        title: string
        isrcs?: string[]
      }>
    }>(`/recording?${params}`)

    return (data.recordings ?? []).map((recording) => ({
      id: recording.id,
      title: recording.title,
      isrcs: recording.isrcs,
    }))
  }

  // Track titles live on releases (specific editions), not release-groups,
  // and MB has no "give me the canonical tracklist" endpoint -- browse the
  // releases under this group and use whichever one comes back first. Good
  // enough for an informational tracklist before requesting; not trying to
  // pick the "definitive" pressing.
  async function getReleaseTracks(releaseGroupMbid: string): Promise<MBTrack[]> {
    const params = new URLSearchParams({
      'release-group': releaseGroupMbid,
      inc: 'recordings',
      fmt: 'json',
      limit: '1',
    })
    const data = await request<{
      releases?: Array<{
        media?: Array<{
          tracks?: Array<{ title: string; number: string; length?: number }>
        }>
      }>
    }>(`/release?${params}`)
    const release = data.releases?.[0]
    if (!release) return []
    return (release.media ?? []).flatMap((medium) =>
      (medium.tracks ?? []).map((t) => ({
        title: t.title,
        position: t.number,
        length: t.length,
      })),
    )
  }

  async function lookupRecording(mbid: string): Promise<RecordingArtistCredit | null> {
    const params = new URLSearchParams({ inc: 'artist-credits', fmt: 'json' })
    let data: MBRecordingLookup
    try {
      data = await request<MBRecordingLookup>(`/recording/${mbid}?${params}`)
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null
      throw err
    }
    const credit = data['artist-credit']?.[0]
    if (!credit) return null
    return {
      recordingMbid: mbid,
      artistMbid: credit.artist.id,
      artistName: credit.artist.name,
    }
  }

  // Track-based discovery's core lookup: given a recording MBID, resolve the
  // artist AND every release-group it appears on (so resolveTrackToAlbum can
  // pick "the" album, not just confirm the artist) in a single request.
  async function lookupRecordingWithReleaseGroups(
    mbid: string,
  ): Promise<RecordingReleaseGroupLookup | null> {
    const params = new URLSearchParams({
      inc: 'artist-credits+releases+release-groups',
      fmt: 'json',
    })
    let data: MBRecordingWithReleasesLookup
    try {
      data = await request<MBRecordingWithReleasesLookup>(`/recording/${mbid}?${params}`)
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null
      throw err
    }
    const credit = data['artist-credit']?.[0]
    if (!credit) return null

    const byReleaseGroup = new Map<string, MBReleaseGroup>()
    for (const release of data.releases ?? []) {
      const rg = release['release-group']
      if (!rg || byReleaseGroup.has(rg.id)) continue
      // A recording can appear on releases credited to someone else entirely
      // (a "Various Artists" compilation that licensed the track, a cover, a
      // tribute album) -- those release-groups aren't "an album by this
      // artist" and would fail downstream when a target (e.g. Lidarr) looks
      // for the release group under the recording's own artist. Skip any
      // release-group whose own artist-credit doesn't include this artist.
      const rgArtistIds = rg['artist-credit']?.map((c) => c.artist.id)
      if (rgArtistIds && !rgArtistIds.includes(credit.artist.id)) continue
      byReleaseGroup.set(rg.id, {
        id: rg.id,
        title: rg.title,
        type: rg['primary-type'] ?? 'Other',
        firstReleaseDate: rg['first-release-date'],
        secondaryTypes: rg['secondary-types'],
      })
    }

    return {
      recordingMbid: mbid,
      artistMbid: credit.artist.id,
      artistName: credit.artist.name,
      releaseGroups: [...byReleaseGroup.values()],
    }
  }

  // Fallback path when a track signal carries no recording MBID (e.g. an AI
  // track suggestion) -- Lucene search by artist+title to find the real
  // recording before resolving its albums.
  async function searchRecording(
    artistName: string,
    trackName: string,
  ): Promise<RecordingReleaseGroupLookup | null> {
    const query = `recording:"${trackName}" AND artist:"${artistName}"`
    const params = new URLSearchParams({ query, fmt: 'json', limit: '5' })
    const data = await request<{
      recordings?: Array<{ id: string; title: string; score: number }>
    }>(`/recording/?${params}`)
    const hit = data.recordings?.[0]
    if (!hit) return null
    return lookupRecordingWithReleaseGroups(hit.id)
  }

  // Same query as searchRecording, but every candidate hit instead of just
  // the top-scored one -- MusicBrainz's relevance ranking can put a
  // same-titled cover/re-recording (e.g. one licensed only for a "Various
  // Artists" fitness/karaoke compilation) ahead of the real original
  // recording. searchRecording's single-hit result silently gives up in that
  // case; a caller resolving "the real album" needs the option to try the
  // next candidate instead.
  async function searchRecordingCandidates(
    artistName: string,
    trackName: string,
    limit = 5,
  ): Promise<Array<{ id: string; title: string; score: number }>> {
    const query = `recording:"${trackName}" AND artist:"${artistName}"`
    const params = new URLSearchParams({ query, fmt: 'json', limit: String(limit) })
    const data = await request<{
      recordings?: Array<{ id: string; title: string; score: number }>
    }>(`/recording/?${params}`)
    return data.recordings ?? []
  }

  // Free-text track-name search (no artist constraint), unlike searchRecording
  // above which requires both. Used for the "search by song title" feature --
  // callers resolve each hit's albums via lookupRecordingWithReleaseGroups,
  // which is why this only returns the lightweight id/title/score, not a full
  // release-group resolution (kept a separate step so the caller can cap how
  // many hits get the expensive per-recording follow-up request).
  async function searchRecordingsByTitle(
    trackName: string,
    limit = 5,
  ): Promise<Array<{ id: string; title: string; score: number }>> {
    const query = `recording:"${trackName}"`
    const params = new URLSearchParams({ query, fmt: 'json', limit: String(limit) })
    const data = await request<{
      recordings?: Array<{ id: string; title: string; score: number }>
    }>(`/recording/?${params}`)
    return data.recordings ?? []
  }

  // MusicBrainz's "simple" search (dismax): matches the words of a free-text
  // query against recording title AND artist name together, so "missy
  // elliott get ur freak on" works without the caller knowing where the
  // artist ends and the title begins. Used to identify which song/artist the
  // user means, not to pick an album -- the top hits are usually copies of
  // the recording on compilations.
  async function searchRecordingsFreeText(
    text: string,
    limit = 15,
  ): Promise<
    Array<{ id: string; title: string; score: number; artistMbid: string; artistName: string }>
  > {
    const params = new URLSearchParams({
      query: text,
      dismax: 'true',
      fmt: 'json',
      limit: String(limit),
    })
    const data = await request<{
      recordings?: Array<{
        id: string
        title: string
        score: number
        'artist-credit'?: Array<{ name: string; artist: { id: string; name: string } }>
      }>
    }>(`/recording/?${params}`)
    return (data.recordings ?? []).flatMap((r) => {
      const credit = r['artist-credit']?.[0]
      return credit
        ? [
            {
              id: r.id,
              title: r.title,
              score: r.score,
              artistMbid: credit.artist.id,
              artistName: credit.artist.name,
            },
          ]
        : []
    })
  }

  // One page of a song's recordings under one artist's own name, each with
  // the release-groups it appears on -- read from the release list every
  // search hit already embeds, instead of a follow-up lookup per recording.
  // MusicBrainz scores every same-titled copy identically (confirmed live:
  // 103 "Get Ur Freak On" recordings by Missy Elliott, all score 100, the
  // studio album's copy 55th), so sampling the top few hits and looking each
  // up -- the old approach -- routinely missed the original album. Only
  // official releases credited to this artist count (not Various Artists
  // compilations); each release-group's date is its earliest release's.
  async function searchArtistRecordingReleaseGroups(
    trackName: string,
    artistMbid: string,
    options: { limit?: number; offset?: number; releaseGroupIds?: string[] } = {},
  ): Promise<{
    total: number
    recordings: Array<{
      recordingMbid: string
      recordingTitle: string
      recordingDisambiguation?: string
      releaseGroups: MBReleaseGroup[]
    }>
  }> {
    // The title's words, not an exact phrase: MusicBrainz tokenizes "No.5"
    // as one word, so the phrase "Mambo No 5" never matched Lou Bega's album
    // copy titled "Mambo No.5 (A Little bit Of…)". Constrained to the artist,
    // looser matching stays small, and callers filter titles themselves.
    // Lucene syntax characters are dropped rather than escaped.
    const terms = trackName.replace(/[+\-!(){}[\]^"~*?:\\/&|]/g, ' ').trim()
    // releaseGroupIds narrows the search to recordings on those albums --
    // the reliable way to ask "which of this artist's studio albums has this
    // song" when hundreds of equally-scored copies would otherwise bury it.
    const rgClause = options.releaseGroupIds?.length
      ? ` AND rgid:(${options.releaseGroupIds.join(' OR ')})`
      : ''
    const params = new URLSearchParams({
      query: `recording:(${terms}) AND arid:${artistMbid}${rgClause}`,
      fmt: 'json',
      limit: String(options.limit ?? 100),
      offset: String(options.offset ?? 0),
    })
    const data = await request<{
      count?: number
      recordings?: Array<{
        id: string
        title: string
        disambiguation?: string
        'artist-credit'?: Array<{ artist: { id: string } }>
        releases?: Array<{
          date?: string
          status?: string
          'artist-credit'?: Array<{ artist: { id: string } }>
          'release-group'?: {
            id: string
            title: string
            'primary-type'?: string
            'secondary-types'?: string[]
          }
        }>
      }>
    }>(`/recording/?${params}`)

    const recordings = (data.recordings ?? []).map((recording) => {
      const byReleaseGroup = new Map<string, MBReleaseGroup>()
      for (const release of recording.releases ?? []) {
        const rg = release['release-group']
        if (!rg) continue
        if (release.status && release.status !== 'Official') continue
        // MusicBrainz omits a release's artist-credit when it's the same as
        // the recording's (confirmed live: Ken Mellons' self-titled album has
        // artist-credit null), so a missing one means "the recording's".
        const credit = release['artist-credit'] ?? recording['artist-credit'] ?? []
        const creditIds = credit.map((c) => c.artist.id)
        if (!creditIds.includes(artistMbid)) continue
        const date = release.date || undefined
        const existing = byReleaseGroup.get(rg.id)
        if (existing) {
          if (date && (!existing.firstReleaseDate || date < existing.firstReleaseDate)) {
            existing.firstReleaseDate = date
          }
          continue
        }
        byReleaseGroup.set(rg.id, {
          id: rg.id,
          title: rg.title,
          type: rg['primary-type'] ?? 'Other',
          firstReleaseDate: date,
          secondaryTypes: rg['secondary-types'],
        })
      }
      return {
        recordingMbid: recording.id,
        recordingTitle: recording.title,
        recordingDisambiguation: recording.disambiguation || undefined,
        releaseGroups: [...byReleaseGroup.values()],
      }
    })
    return { total: data.count ?? recordings.length, recordings }
  }

  // Exact-match path for a source that hands us an ISRC (e.g. Shazam's full
  // response) instead of free text: ISRCs are assigned by rights holders to
  // official releases, so unlike a title search they essentially never
  // return unofficial/fan-bootleg recordings -- it's a way to skip the
  // "which of N search hits is the real one" problem entirely rather than
  // get better at ranking around it. Usually one recording per ISRC, but
  // occasionally a few (e.g. distinct masters for different territories).
  async function lookupRecordingsByIsrc(
    isrc: string,
  ): Promise<Array<{ id: string; title: string }>> {
    const params = new URLSearchParams({ inc: 'artist-credits', fmt: 'json' })
    let data: { recordings?: Array<{ id: string; title: string }> }
    try {
      data = await request<{ recordings?: Array<{ id: string; title: string }> }>(
        `/isrc/${encodeURIComponent(isrc)}?${params}`,
      )
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return []
      throw err
    }
    return data.recordings ?? []
  }

  function extractStreamingUrls(relations: MBRelation[]): StreamingUrls {
    const result: StreamingUrls = {}

    for (const rel of relations) {
      if (!rel.url?.resource) continue
      if (!STREAMING_TYPES.has(rel.type)) continue

      const resource = rel.url.resource

      for (const [pattern, key] of STREAMING_PATTERNS) {
        if (pattern.test(resource) && result[key] === undefined) {
          result[key] = resource
          break
        }
      }
    }

    return result
  }

  return {
    lookupArtist,
    searchArtist,
    getReleaseGroups,
    searchReleaseGroupByTitle,
    getRecordings,
    getReleaseTracks,
    lookupRecording,
    lookupRecordingWithReleaseGroups,
    searchRecording,
    searchRecordingsFreeText,
    searchArtistRecordingReleaseGroups,
    searchRecordingCandidates,
    searchRecordingsByTitle,
    lookupRecordingsByIsrc,
    extractStreamingUrls,
  }
}
