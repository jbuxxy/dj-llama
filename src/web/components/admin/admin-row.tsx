// Label + description on the left, action on the right; stacks on phones.
export function AdminRow({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-sm text-text">{title}</p>
          {description && <p className="text-xs text-muted mt-0.5">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </div>
  )
}
