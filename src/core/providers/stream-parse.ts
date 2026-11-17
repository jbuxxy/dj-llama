import type { AiRecommendation } from '@/core/types'
import { AiRecommendationItemSchema, stripReasoningBlocks } from './prompt'

/**
 * Incrementally pulls complete recommendation objects out of a model's JSON
 * output while it is still being generated, so mood search can show the
 * first card seconds into a 10-20s response instead of only at the end.
 *
 * The output is either a bare array or `{ "recommendations": [ ... ] }`
 * (possibly fenced, possibly after a <think> block from a local reasoning
 * model). Each time an element object of the first array closes, it is
 * parsed and validated on its own and emitted exactly once. Whatever the
 * provider returns as its final, fully parsed list stays authoritative --
 * this only exists to show results early.
 */
export class RecommendationStreamParser {
  private buffer = ''
  private emittedObjects = 0

  constructor(private readonly onRecommendation: (rec: AiRecommendation) => void) {}

  push(chunk: string): void {
    if (!chunk) return
    this.buffer += chunk
    // Don't scan inside an unfinished reasoning block -- it can contain
    // brackets and draft JSON that isn't the answer.
    if (/<think\b/i.test(this.buffer) && !/<\/think>/i.test(this.buffer)) return
    const objects = completeArrayObjects(stripReasoningBlocks(this.buffer))
    for (let i = this.emittedObjects; i < objects.length; i++) {
      const raw = objects[i]
      const parsed = AiRecommendationItemSchema.safeParse(raw)
      if (parsed.success) {
        try {
          this.onRecommendation(parsed.data)
        } catch (err) {
          console.warn('[ai-stream] onRecommendation handler threw:', err)
        }
      }
    }
    this.emittedObjects = Math.max(this.emittedObjects, objects.length)
  }
}

/** Every complete `{...}` element of the first JSON array in `text`, parsed. */
export function completeArrayObjects(text: string): unknown[] {
  const arrayStart = text.indexOf('[')
  if (arrayStart === -1) return []
  const out: unknown[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let objectStart = -1
  for (let i = arrayStart + 1; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{' || ch === '[') {
      if (depth === 0 && ch === '{') objectStart = i
      depth++
    } else if (ch === '}' || ch === ']') {
      if (depth === 0) break // the array itself closed
      depth--
      if (depth === 0 && ch === '}' && objectStart !== -1) {
        try {
          out.push(JSON.parse(text.slice(objectStart, i + 1)))
        } catch {
          out.push(null) // keep indexes stable; fails validation downstream
        }
        objectStart = -1
      }
    }
  }
  return out
}
