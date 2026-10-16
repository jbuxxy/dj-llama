export const ARTIST_EXTERNAL_LINK_KEYS = ['wikipedia', 'officialSite', 'musicbrainz'] as const

export const ARTIST_EXTERNAL_LINK_LABEL: Record<
  (typeof ARTIST_EXTERNAL_LINK_KEYS)[number],
  string
> = {
  wikipedia: 'Wikipedia',
  officialSite: 'Official site',
  musicbrainz: 'MusicBrainz',
}
