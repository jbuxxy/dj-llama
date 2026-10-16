export function PagerBar({
  page,
  totalPages,
  onPageChange,
}: {
  page: number
  totalPages: number
  onPageChange: (p: number) => void
}) {
  if (totalPages <= 1) return null
  const hasPrev = page > 0
  const hasNext = page + 1 < totalPages
  return (
    <div className="flex items-center justify-between px-4 py-2 border-t border-border">
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={!hasPrev}
        className="text-xs text-muted disabled:opacity-40 disabled:cursor-not-allowed hover:text-text"
      >
        Prev
      </button>
      <span className="text-xs text-muted">
        {page + 1} / {totalPages}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={!hasNext}
        className="text-xs text-muted disabled:opacity-40 disabled:cursor-not-allowed hover:text-text"
      >
        Next
      </button>
    </div>
  )
}
