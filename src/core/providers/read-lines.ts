/** Yields each complete line of a streamed HTTP body (NDJSON / SSE). */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (line) yield line
        newline = pending.indexOf('\n')
      }
    }
    pending += decoder.decode()
    if (pending.trim()) yield pending
  } finally {
    reader.releaseLock()
  }
}
