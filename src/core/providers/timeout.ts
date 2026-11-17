export function timeoutSecondsToMs(timeoutSeconds: number): number {
  return Math.max(1, timeoutSeconds) * 1000
}

export function optionalTimeoutSecondsToMs(timeoutSeconds?: number | null): number | undefined {
  return timeoutSeconds == null ? undefined : timeoutSecondsToMs(timeoutSeconds)
}

export function timeoutSecondsWithDefaultToMs(
  timeoutSeconds: number | null | undefined,
  defaultSeconds: number,
): number {
  return timeoutSecondsToMs(timeoutSeconds ?? defaultSeconds)
}

// The Anthropic/OpenAI SDKs default to a 10-minute timeout per attempt (with
// retries on top), so a hung request used to leave a scan or mood search
// spinning for half an hour. Recommendation calls finish well inside this.
export const DEFAULT_SDK_TIMEOUT_MS = 120_000

export function timeoutMessage(label: string, timeoutMs: number): string {
  const seconds = timeoutMs / 1000
  return `${label} timed out after ${seconds} second${seconds === 1 ? '' : 's'}`
}

/**
 * Runs `run` with an AbortSignal that fires after `timeoutMs`, turning the
 * resulting abort into a readable "<label> timed out after N seconds" error.
 * The signal stays live for the whole callback, so a streamed body read
 * inside it is covered too.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await run(controller.signal)
  } catch (err) {
    if (controller.signal.aborted) throw new Error(timeoutMessage(label, timeoutMs))
    throw err
  } finally {
    clearTimeout(timer)
  }
}
