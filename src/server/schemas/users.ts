import * as z from 'zod'
import { idParamSchema } from './validator'

// PATCH body: keep shape strict so future additions are a deliberate choice,
// not a silent expansion.
export const updateUserSchema = z
  .object({
    isAdmin: z.boolean().optional(),
    // Trusted-user flag for the requests workflow: their manual search
    // requests dispatch to Lidarr immediately instead of sitting in the
    // admin approval queue.
    autoApproveRequests: z.boolean().optional(),
  })
  .strict()

export const userIdParamSchema = idParamSchema
