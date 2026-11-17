import * as z from 'zod'
import { MBID_RE } from '@/core/validation'

// Keep the batch cap in lockstep with the runtime slice in library.ts.
export const libraryWarmSchema = z
  .object({
    mbids: z.array(z.string().min(1)).min(1).max(200),
  })
  .strict()

export const librarySyncSchema = z
  .object({
    source: z.string().min(1).optional(),
  })
  .strict()

export const libraryOverrideSchema = z
  .object({
    source: z.string().min(1),
    sourceArtistId: z.string().min(1),
    // Empty string or null clear the override; otherwise must be a UUID.
    correctMbid: z
      .union([
        z.literal(''),
        z.null(),
        z.string().regex(MBID_RE, 'correctMbid must be a valid UUID'),
      ])
      .optional(),
    note: z.string().optional(),
  })
  .strict()

export const libraryAlbumOverrideSchema = z
  .object({
    source: z.string().min(1),
    sourceAlbumId: z.string().min(1),
    correctAlbumMbid: z
      .union([
        z.literal(''),
        z.null(),
        z.string().regex(MBID_RE, 'correctAlbumMbid must be a valid UUID'),
      ])
      .optional(),
    note: z.string().optional(),
  })
  .strict()
