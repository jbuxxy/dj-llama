import * as z from 'zod'

export const quickDiscoverSchema = z.object({
  artistName: z.string().trim().min(1).max(200),
  // Carried through from mood-discover's AI result so the seed artist can
  // resolve to the specific album the AI had in mind, instead of falling
  // back to that artist's most recent Album/EP.
  suggestedAlbum: z.string().trim().min(1).max(300).optional(),
  reasoning: z.string().trim().min(1).max(1000).optional(),
})
