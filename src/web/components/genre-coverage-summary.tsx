import type { GenreCoverage } from '../lib/api'

export function GenreCoverageSummary({ coverage }: { coverage: GenreCoverage | null | undefined }) {
  if (!coverage || coverage.totalArtists === 0) return null

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted">
        {`Genre data available: ${coverage.coveredArtists}/${coverage.totalArtists}`}
      </p>
      {coverage.pendingArtists > 0 ? (
        <p className="text-xs text-muted">
          {`Pending genre data updates: ${coverage.pendingArtists}`}
        </p>
      ) : null}
    </div>
  )
}
