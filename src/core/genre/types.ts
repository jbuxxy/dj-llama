export type GenreInfo = {
  id: number
  name: string
  slug: string
  source: string
  parentGenreId: number | null
  artistCount: number
  cachedAt: Date | null
}

export type GenreArtistResult = {
  name: string
  mbid?: string
  tags: string[]
  listenerCount?: number
  source: string
}
