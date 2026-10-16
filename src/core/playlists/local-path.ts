// Generated playlists only store each track's local file path (no album
// MBID), but the library layout puts every track in its album's folder --
// e.g. "/music/TLC/(1999) FanMail/05 No Scrubs.mp3" -> "FanMail". Strips the
// common year prefixes/suffixes so the folder name lines up with the
// library_albums title.
export function albumTitleFromPath(localPath: string | null | undefined): string | null {
  if (!localPath) return null
  const parts = localPath.split(/[\\/]/).filter(Boolean)
  if (parts.length < 2) return null
  const folder = parts[parts.length - 2] as string
  const title = folder
    .replace(/^\(\d{4}\)\s*/, '')
    .replace(/^\[\d{4}\]\s*/, '')
    .replace(/^\d{4}\s*-\s*/, '')
    .replace(/\s*[([]\d{4}[)\]]$/, '')
    .trim()
  return title || null
}
