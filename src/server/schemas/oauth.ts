import * as z from 'zod'

// Initiate body is optional overall; no provider currently uses these fields
// (the framework is provider-less right now), but if a future provider needs
// clientId/clientSecret/redirectUri, all three must be strings when present.
// Handler enforces per-provider requirements after the switch, so this schema
// stays lenient.
export const oauthInitiateSchema = z
  .object({
    clientId: z.string().max(500).optional(),
    clientSecret: z.string().max(500).optional(),
    redirectUri: z
      .string()
      .max(2048)
      .refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
        message: 'redirectUri must start with http:// or https://',
      })
      .optional(),
  })
  .passthrough()
