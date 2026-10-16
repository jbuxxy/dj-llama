// Lidarr does a heavy, synchronous full-catalog refresh for every newly
// added artist, and a burst of adds (a playlist import resolving dozens of
// missing albums, several imported playlists syncing at once, "Retry
// failed") stacks those refreshes until Lidarr takes minutes to answer even
// simple reads. Confirmed live (2026-10-12): GET /api/v1/album took up to
// 220s mid-burst, far past the client's 30s timeout, so every add in the
// burst was recorded as failed with "The operation was aborted."
//
// Two guards, applied around every Lidarr add (see targets/lidarr.ts):
// - writes to the same Lidarr run one at a time, process-wide, so
//   independent callers queue instead of piling on together;
// - before each write, wait (bounded) for Lidarr's own command queue to
//   drain its artist refreshes, so the next add doesn't land on top of them.

const BUSY_COMMANDS = new Set(['RefreshArtist', 'RefreshAlbum', 'BulkRefreshArtist'])
const IDLE_POLL_MS = 5_000
// Bounded so a stuck Lidarr command can't wedge every add forever -- past
// this, proceed anyway and let the add's own timeout decide.
const IDLE_MAX_WAIT_MS = 3 * 60_000

type CommandStatus = { name: string; status: string }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const queues = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => undefined)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

export async function waitForLidarrIdle(
  getCommands: () => Promise<CommandStatus[]>,
  { pollMs = IDLE_POLL_MS, maxWaitMs = IDLE_MAX_WAIT_MS } = {},
): Promise<void> {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    // A command-queue read that itself errors or times out means Lidarr is
    // too busy to answer -- treat it as busy rather than idle.
    const busy = await getCommands()
      .then((commands) =>
        commands.some(
          (c) => BUSY_COMMANDS.has(c.name) && (c.status === 'queued' || c.status === 'started'),
        ),
      )
      .catch(() => true)
    if (!busy) return
    await sleep(pollMs)
  }
}

export function throttledLidarrWrite<T>(
  lidarrUrl: string,
  getCommands: () => Promise<CommandStatus[]>,
  fn: () => Promise<T>,
): Promise<T> {
  return serialize(lidarrUrl, async () => {
    await waitForLidarrIdle(getCommands)
    return fn()
  })
}
