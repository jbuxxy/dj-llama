import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { getUserPreferences, updateUserPreferences } from '@/web/lib/api'

// Persists which dashboard cards the user has manually collapsed, the same
// server-side-preference pattern useHints uses for dismissed hints -- so
// collapse state follows the user across devices/sessions instead of
// resetting on every reload.
export function useCollapsedSections() {
  const queryClient = useQueryClient()

  const { data: prefs } = useQuery({
    queryKey: ['user-preferences'],
    queryFn: getUserPreferences,
    staleTime: 60_000,
  })

  const collapsed: string[] = (prefs?.collapsedDashboardSections as string[] | undefined) ?? []

  // `collapsed` stores ids whose state has been manually toggled away from
  // their default -- so a section can default to collapsed (e.g. the taste
  // genre breakdown) without needing a second "expanded" list. Membership
  // means "flipped", not "collapsed", hence the XOR against defaultCollapsed.
  const isCollapsed = useCallback(
    (id: string, defaultCollapsed = false) =>
      collapsed.includes(id) ? !defaultCollapsed : defaultCollapsed,
    [collapsed],
  )

  const toggleSection = useCallback(
    async (id: string) => {
      const updated = collapsed.includes(id)
        ? collapsed.filter((c) => c !== id)
        : [...collapsed, id]
      queryClient.setQueryData(
        ['user-preferences'],
        (old: Record<string, unknown> | undefined) => ({
          ...(old ?? {}),
          collapsedDashboardSections: updated,
        }),
      )
      try {
        await updateUserPreferences({ collapsedDashboardSections: updated })
      } catch {
        // best-effort
      }
    },
    [collapsed, queryClient],
  )

  return { isCollapsed, toggleSection }
}
