import type { PlaylistStrategyImpl } from './types'

export const aiPromptStrategy: PlaylistStrategyImpl = {
  async selectArtists(deps, config) {
    const prompt = config.prompt?.trim()
    if (!prompt) return []

    if (deps.selectAlbumsWithAi) {
      return deps.selectAlbumsWithAi({
        prompt,
        size: config.size,
        useListeningHistory: config.useListeningHistory,
        genreFilters: config.genreFilters,
        decadeFilters: config.decadeFilters,
        excludeLiveVersions: config.excludeLiveVersions,
      })
    }
    if (deps.selectArtistsWithAi) {
      return deps.selectArtistsWithAi({ prompt, size: config.size })
    }
    return []
  },
}
