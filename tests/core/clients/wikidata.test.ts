// @vitest-environment node
import * as http from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWikidataClient } from '@/core/clients/wikidata'

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return {
    ...actual,
    lookup: vi.fn(async () => ({ address: '127.0.0.1', family: 4 })),
  }
})
vi.mock('@/core/validation', async () => {
  const actual = await vi.importActual<typeof import('@/core/validation')>('@/core/validation')
  return {
    ...actual,
    isPrivateUrl: () => false,
    isPrivateIp: () => false,
  }
})

let server: http.Server
let baseUrl: string
let nextResponse: { status: number; body: string } = { status: 200, body: '{}' }

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(nextResponse.status, { 'Content-Type': 'application/sparql-results+json' })
    res.end(nextResponse.body)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve())
  })
  const addr = server.address() as { port: number }
  baseUrl = `http://localhost:${addr.port}`
})

afterAll(() => {
  server.close()
})

function setSparql(bindings: unknown[]) {
  nextResponse = { status: 200, body: JSON.stringify({ results: { bindings } }) }
}

describe('Wikidata client', () => {
  it('parses description, Wikipedia URL, official site', async () => {
    setSparql([
      {
        artist: { value: 'http://www.wikidata.org/entity/Q11649' },
        description: { 'xml:lang': 'en', value: 'British rock band' },
        wikipedia: { value: 'https://en.wikipedia.org/wiki/Boards_of_Canada' },
        officialSite: { value: 'https://boardsofcanada.com/' },
      },
    ])
    const client = createWikidataClient(baseUrl)
    const result = await client.getArtistEnrichment('mbid-1')
    expect(result.wikidataId).toBe('Q11649')
    expect(result.description).toBe('British rock band')
    expect(result.externalLinks).toEqual({
      wikipedia: 'https://en.wikipedia.org/wiki/Boards_of_Canada',
      officialSite: 'https://boardsofcanada.com/',
    })
  })

  it('returns empty on no matching entity', async () => {
    setSparql([])
    const client = createWikidataClient(baseUrl)
    const result = await client.getArtistEnrichment('mbid-none')
    expect(result.wikidataId).toBeNull()
    expect(result.description).toBeNull()
  })

  it('returns empty on SPARQL error', async () => {
    nextResponse = { status: 500, body: 'boom' }
    const client = createWikidataClient(baseUrl)
    const result = await client.getArtistEnrichment('mbid-err')
    expect(result.wikidataId).toBeNull()
  })

  it('returns empty on malformed response', async () => {
    nextResponse = { status: 200, body: '<html>' }
    const client = createWikidataClient(baseUrl)
    const result = await client.getArtistEnrichment('mbid-bad')
    expect(result.wikidataId).toBeNull()
  })
})
