// Weighted random sample without replacement -- higher-weight items are
// more likely to be picked, but the result isn't the exact same top-N by
// weight every call. Shared by daily_mix's artist selection (weight =
// taste score) and local track resolution (weight = liked/play-count bias).
export function weightedSample<T>(pool: T[], count: number, weightOf: (item: T) => number): T[] {
  const remaining = [...pool]
  const picked: T[] = []
  while (remaining.length > 0 && picked.length < count) {
    const totalWeight = remaining.reduce((sum, item) => sum + Math.max(weightOf(item), 0.0001), 0)
    let roll = Math.random() * totalWeight
    let index = remaining.length - 1
    for (let i = 0; i < remaining.length; i++) {
      roll -= Math.max(weightOf(remaining[i] as T), 0.0001)
      if (roll <= 0) {
        index = i
        break
      }
    }
    const [next] = remaining.splice(index, 1)
    if (next) picked.push(next)
  }
  return picked
}

export function shuffled<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = result[i]
    result[i] = result[j] as T
    result[j] = tmp as T
  }
  return result
}
