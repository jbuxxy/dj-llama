// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GenreCoverageSummary } from '@/web/components/genre-coverage-summary'

describe('GenreCoverageSummary', () => {
  it('renders nothing when no listening artists were analyzed', () => {
    const { container } = render(
      <GenreCoverageSummary coverage={{ coveredArtists: 0, pendingArtists: 0, totalArtists: 0 }} />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
