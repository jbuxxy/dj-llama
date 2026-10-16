import { getSeasonalPreset, isWithinSeasonalWindow } from './seasonal-presets'

export type SeasonalWindowOverride = {
  startMonth: number
  startDay: number
  endMonth: number
  endDay: number
}

export type SeasonalPlaylistState = {
  id: number
  name: string
  config: { presetKey?: string; windowOverride?: SeasonalWindowOverride } | null
  status: string
}

export type SeasonalTickDeps<T extends SeasonalPlaylistState> = {
  getEnabledSeasonalPlaylists: () => Promise<T[]>
  generatePlaylist: (playlistId: number) => Promise<void>
  tearDownPlaylist: (playlist: T) => Promise<void>
  onGenerated?: (playlist: T) => void
  onGenerateFailed?: (playlist: T, error: unknown) => void
  onTornDown?: (playlist: T) => void
  /** Defaults to `new Date()`. Overridable so tests can pin a calendar date. */
  now?: Date
}

/**
 * Seasonal playlists have no fixed recurrence -- they fire once when a
 * preset's calendar window opens and tear down once it closes, so (unlike
 * every other strategy) they carry no per-playlist cron; one shared daily
 * tick checks every enabled seasonal playlist's window state instead.
 * `status === 'active'` doubles as "currently pushed to Plex this year":
 * anything else means not yet generated (or already torn down this year).
 * The playlist row itself is never deleted here -- only an explicit user
 * toggle-off does that -- so a preset re-fires automatically next year
 * without the user having to re-enable it.
 */
export async function tickSeasonalPlaylists<T extends SeasonalPlaylistState>(
  deps: SeasonalTickDeps<T>,
): Promise<void> {
  const seasonalPlaylists = await deps.getEnabledSeasonalPlaylists()
  const now = deps.now ?? new Date()

  for (const playlist of seasonalPlaylists) {
    const preset = getSeasonalPreset(playlist.config?.presetKey)
    if (!preset) continue

    // Per-row window customization (config.windowOverride) takes priority
    // over the preset's built-in default calendar window when the user has
    // edited it for their own row.
    const window = playlist.config?.windowOverride ?? preset.window
    const inWindow = isWithinSeasonalWindow({ ...preset, window }, now)
    const alreadyGenerated = playlist.status === 'active'

    if (inWindow && !alreadyGenerated) {
      try {
        await deps.generatePlaylist(playlist.id)
        deps.onGenerated?.(playlist)
      } catch (error) {
        deps.onGenerateFailed?.(playlist, error)
      }
    } else if (!inWindow && alreadyGenerated) {
      await deps.tearDownPlaylist(playlist)
      deps.onTornDown?.(playlist)
    }
  }
}
