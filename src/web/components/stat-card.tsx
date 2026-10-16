import { cn } from '../lib/utils'
import { Skeleton } from './ui/skeleton'

type StatCardProps = {
  label: string
  value: string | number
  subValue?: string
  color?: string
  loading?: boolean
}

export function StatCard({ label, value, subValue, color, loading }: StatCardProps) {
  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-lg p-4 space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-1">
      <p className="text-xs text-muted uppercase tracking-wide">{label}</p>
      <p className={cn('text-2xl font-bold text-text', color)}>{value}</p>
      {subValue && <p className="text-xs text-muted">{subValue}</p>}
    </div>
  )
}
