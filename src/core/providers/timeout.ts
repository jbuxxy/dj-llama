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
