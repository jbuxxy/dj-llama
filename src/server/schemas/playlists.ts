import * as z from 'zod'
import { cronSchema } from './cron'
import { idParamSchema } from './validator'

export const playlistStrategySchema = z.enum([
  'weekly_digest',
  'genre_focus',
  'mood_mix',
  'rediscover',
  'seasonal',
  'import',
  'ai_prompt',
  'daily_mix',
])

export const playlistIdParamSchema = idParamSchema

export const playlistExportFormatParamSchema = idParamSchema.extend({
  format: z.enum(['json', 'csv', 'm3u', 'xspf']),
})

export const missingTrackIdParamSchema = idParamSchema.extend({
  trackId: z.coerce.number().int().positive(),
})

export const duplicatePlaylistSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
})

export const createPlaylistSchema = z.object({
  name: z.string().trim().min(1).max(200),
  strategy: playlistStrategySchema,
  targetIds: z.array(z.number().int().positive()).max(50).optional(),
  schedule: cronSchema.nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
  autoPushToPlex: z.boolean().optional(),
  description: z.string().max(500).nullable().optional(),
})

export const previewAiPlaylistSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  size: z.number().int().min(1).max(100).optional(),
  useListeningHistory: z.boolean().optional(),
  genreFilters: z.array(z.string().min(1).max(100)).max(20).optional(),
  decadeFilters: z.array(z.number().int().min(1900).max(2100)).max(20).optional(),
  excludeLiveVersions: z.boolean().optional(),
})

// Query-string counterpart of the genreFilters/decadeFilters/excludeLiveVersions
// trio above -- both arrive as comma-separated lists since it's a GET.
export const previewFilterCountQuerySchema = z.object({
  genres: z
    .string()
    .max(500)
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((g) => g.trim())
            .filter(Boolean)
        : undefined,
    ),
  decades: z
    .string()
    .max(200)
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((d) => Number.parseInt(d.trim(), 10))
            .filter((n) => !Number.isNaN(n))
        : undefined,
    ),
  excludeLive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
})

export const updatePlaylistSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    strategy: playlistStrategySchema.optional(),
    targetIds: z.array(z.number().int().positive()).max(50).optional(),
    schedule: cronSchema.nullable().optional(),
    config: z.record(z.string(), z.unknown()).nullable().optional(),
    enabled: z.boolean().optional(),
    autoPushToPlex: z.boolean().optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .strict()

export const playlistTrackAddSchema = z.object({
  artistName: z.string().trim().min(1).max(500),
  trackName: z.string().trim().min(1).max(500),
  localPath: z.string().max(4000).nullable().optional(),
})
