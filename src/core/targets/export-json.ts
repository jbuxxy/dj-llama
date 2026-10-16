import type { ExportableRecommendation } from './types'

export function exportToJson(recommendations: ExportableRecommendation[]): string {
  return JSON.stringify(recommendations, null, 2)
}
