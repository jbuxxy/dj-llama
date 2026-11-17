/**
 * Small in-process TTL + size-bounded cache for slow external lookups
 * (MusicBrainz release groups, Lidarr metadata search, Plex history). Stores
 * the in-flight promise, so concurrent callers for the same key share one
 * upstream request; failed loads are evicted so they're retried next time.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { at: number; value: Promise<V> }>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key)
    if (hit && Date.now() - hit.at < this.ttlMs) {
      // Refresh recency for LRU-ish eviction.
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit.value
    }
    const value = load()
    this.entries.set(key, { at: Date.now(), value })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key)
    })
    return value
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}
