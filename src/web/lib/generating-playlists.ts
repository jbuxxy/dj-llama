import { type QueryClient, useQuery } from '@tanstack/react-query'

const KEY = ['generating-playlist-ids'] as const

// Safety net only -- the SSE 'playlist-generated' event (see
// use-realtime-updates.ts) is what actually clears this in the normal case.
// Covers a dropped/never-reconnected SSE connection so a Generate button
// doesn't spin forever.
const SAFETY_TIMEOUT_MS = 3 * 60_000

// Generation is a fire-and-forget background job (POST .../generate returns
// before it's done), so no single component "owns" knowing when a given
// playlist finishes -- the Generate button that started it, the row showing
// its track count, and any other open tab all need the same answer. Stashing
// the in-flight id set in the query cache (rather than local component
// state) gives every one of those a shared source of truth for free, the
// same way the rest of this app already treats React Query as its client
// state layer.
export function useGeneratingPlaylistIds(): ReadonlySet<number> {
  const { data } = useQuery<number[]>({
    queryKey: KEY,
    queryFn: () => [],
    initialData: [],
    staleTime: Number.POSITIVE_INFINITY,
  })
  return new Set(data)
}

export function markPlaylistGenerating(queryClient: QueryClient, id: number): void {
  queryClient.setQueryData<number[]>(KEY, (old = []) => (old.includes(id) ? old : [...old, id]))
  setTimeout(() => clearPlaylistGenerating(queryClient, id), SAFETY_TIMEOUT_MS)
}

export function clearPlaylistGenerating(queryClient: QueryClient, id: number): void {
  queryClient.setQueryData<number[]>(KEY, (old = []) => old.filter((x) => x !== id))
}
