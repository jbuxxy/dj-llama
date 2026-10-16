import PQueue from 'p-queue'
import { isMaintenance } from '@/core/ops/maintenance'
import { redactSecrets } from '@/core/providers/retry'
import type { Database } from '@/db'
import { getArtistsNeedingImageBackfill, upsertArtist } from '@/db/queries/artists'
import type { SettingsRow } from '@/db/queries/settings'
import { mergePreferences } from '@/db/schema'
import { createArtistImageClients } from './image-clients'
import { fetchArtistImage } from './resolve'
import type { StoreDb } from './store'

// Bounded per tick so a single run can't starve the shared AudioDB rate-limit
// bucket (30 tokens/min, see image-clients.ts) that the interactive rescan
// endpoint and the main discovery pipeline also draw from. Overflow falls
// through to Lidarr/fanart/musicinfo per fetchArtistImage's own fallback chain.
export const IMAGE_BACKFILL_LIMIT = 40

export type ArtistImageBackfillDeps = {
  db: Database
  getSettings: () => Promise<SettingsRow | null>
  tryConsumeRateLimit: StoreDb['tryConsumeRateLimit']
}

export type ArtistImageBackfillResult = {
  attempted: number
  updated: number
  failed: number
  skipped: boolean
}

const skippedResult: ArtistImageBackfillResult = {
  attempted: 0,
  updated: 0,
  failed: 0,
  skipped: true,
}

const backfillQueue = new PQueue({ concurrency: 1 })

export async function waitForImageBackfill(): Promise<void> {
  await backfillQueue.onIdle()
}

export async function runArtistImageBackfill(
  deps: ArtistImageBackfillDeps,
  limit = IMAGE_BACKFILL_LIMIT,
): Promise<ArtistImageBackfillResult> {
  if (isMaintenance()) return skippedResult

  return (await backfillQueue.add(async () => {
    if (isMaintenance()) return skippedResult

    const settings = await deps.getSettings()
    if (!settings) return skippedResult

    const preferences = mergePreferences(settings.preferences)
    const { audiodbClient, lidarrClient, fanartClient, musicinfoClient } = createArtistImageClients(
      {
        settings,
        preferences,
        tryConsumeRateLimit: deps.tryConsumeRateLimit,
      },
    )
    if (!audiodbClient && !lidarrClient && !fanartClient && !musicinfoClient) return skippedResult

    const candidates = await getArtistsNeedingImageBackfill(deps.db, limit)

    const result: ArtistImageBackfillResult = {
      attempted: 0,
      updated: 0,
      failed: 0,
      skipped: false,
    }
    for (const candidate of candidates) {
      if (isMaintenance()) break
      result.attempted++

      try {
        const image = await fetchArtistImage(
          candidate.mbid,
          candidate.name,
          audiodbClient,
          lidarrClient,
          fanartClient,
          musicinfoClient,
        )
        if (image.url) {
          await upsertArtist(deps.db, {
            mbid: candidate.mbid,
            name: candidate.name,
            imageUrl: image.url,
            logoUrl: image.logoUrl,
          })
          result.updated++
        } else if (image.failed) {
          await upsertArtist(deps.db, {
            mbid: candidate.mbid,
            name: candidate.name,
            imageFailed: true,
          })
          result.failed++
        } else {
          result.failed++
        }
      } catch (error) {
        result.failed++
        console.warn(
          `[artist-image-backfill] ${candidate.name}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        )
      }
    }

    return result
  })) as ArtistImageBackfillResult
}
