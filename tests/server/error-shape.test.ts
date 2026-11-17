// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('server error shape', () => {
  it('returns errors through problem()/apiError(), never ad-hoc { error } JSON', () => {
    const offenders = sourceFiles(join(__dirname, '../../src/server')).filter((file) =>
      /\.json\(\s*\{[^}]*\berror\s*[:,}]/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
