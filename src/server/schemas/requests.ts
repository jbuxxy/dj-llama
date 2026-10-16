import * as z from 'zod'
import { stripControlChars } from '@/core/text/strip-control-chars'
import { idParamSchema } from './validator'

export const requestIdParamSchema = idParamSchema

const mbidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'must be a valid MusicBrainz ID',
  )

export const mbidParamSchema = z.object({ mbid: mbidSchema })

export const searchRequestQuerySchema = z.object({
  q: z
    .string()
    .transform((s) => stripControlChars(s).trim())
    .pipe(z.string().min(1).max(200)),
})

export const createRequestSchema = z
  .object({
    kind: z.enum(['artist', 'album']),
    artistMbid: mbidSchema,
    artistName: z.string().min(1).max(500),
    releaseGroupMbid: mbidSchema.optional(),
    albumTitle: z.string().min(1).max(500).optional(),
    coverUrl: z.string().url().max(2000).optional(),
  })
  .refine((v) => v.kind !== 'album' || (v.releaseGroupMbid && v.albumTitle), {
    message: 'releaseGroupMbid and albumTitle are required when kind is "album"',
    path: ['releaseGroupMbid'],
  })

export const listRequestsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  libraryStatus: z.enum(['open', 'in_library']).optional(),
})

export const rejectRequestSchema = z.object({
  rejectionReason: z
    .string()
    .transform((s) => stripControlChars(s).trim())
    .pipe(z.string().max(400))
    .optional(),
})
