// Writes .br and .gz siblings for the built SPA so serveStatic({ precompressed })
// can hand browsers compressed bundles without compressing per request.
// Runs after `vite build` (see package.json "build").
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const ROOT = process.argv[2] ?? 'dist/web'
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|webmanifest|txt|map)$/i
const MIN_BYTES = 1024

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

let count = 0
let before = 0
let after = 0
for (const path of walk(ROOT)) {
  if (!COMPRESSIBLE.test(path)) continue
  const data = readFileSync(path)
  if (data.length < MIN_BYTES) continue
  const br = brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  })
  writeFileSync(`${path}.br`, br)
  writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }))
  count++
  before += data.length
  after += br.length
}
console.log(
  `precompress: ${count} files, ${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB brotli`,
)
