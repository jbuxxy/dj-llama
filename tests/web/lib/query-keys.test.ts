import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '@/web/lib/query-keys'

function invalidatedBy(prefix: readonly unknown[], keys: ReadonlyArray<readonly unknown[]>) {
  const client = new QueryClient()
  for (const key of keys) client.setQueryData(key, 1)
  client.invalidateQueries({ queryKey: prefix, refetchType: 'none' })
  return keys.filter((key) => client.getQueryState(key)?.isInvalidated)
}

describe('queryKeys', () => {
  it('refreshes every request view, Dashboard strip included, from one prefix', () => {
    const keys = [
      queryKeys.requests.mine('open', 0),
      queryKeys.requests.mineRecent,
      queryKeys.requests.pending,
      queryKeys.dashboard.taste,
    ]
    expect(invalidatedBy(queryKeys.requests.all, keys)).toEqual(keys.slice(0, 3))
  })

  it('covers Discover and the Dashboard picks under recommendations', () => {
    const keys = [
      queryKeys.recommendations.list({ page: 0 }),
      queryKeys.recommendations.count('pending'),
      queryKeys.dashboard.pick,
      queryKeys.dashboard.approved,
      queryKeys.dashboard.activity,
    ]
    expect(invalidatedBy(queryKeys.recommendations.all, keys)).toEqual(keys.slice(0, 4))
  })
})
