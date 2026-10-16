import { Cron } from 'croner'
import * as z from 'zod'

// Cron string: any expression croner can parse. Validate by construction
// attempt so the error surfaces at the schema boundary instead of later.
export const cronSchema = z
  .string()
  .trim()
  .min(1, 'cron expression is required')
  .max(100)
  .refine(
    (value) => {
      try {
        new Cron(value, { maxRuns: 0 })
        return true
      } catch {
        return false
      }
    },
    { message: 'Invalid cron expression' },
  )
