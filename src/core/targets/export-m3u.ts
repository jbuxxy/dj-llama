import type { ExportableRecommendation } from './types'
import { getStreamingUrl } from './types'

export function exportToM3u(recommendations: ExportableRecommendation[]): string {
  const lines = ['#EXTM3U']

  for (const rec of recommendations) {
    lines.push(`#EXTINF:-1,${rec.artistName}`)
    lines.push(getStreamingUrl(rec))
  }

  return lines.join('\n')
}
