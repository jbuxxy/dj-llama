import type { SystemInfo } from '@/web/lib/api'
import { formatDateTime } from '@/web/lib/intl'

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-sm text-text text-right min-w-0 break-words">{children}</dd>
    </div>
  )
}

export function SystemSection({ info }: { info: SystemInfo | undefined }) {
  if (!info) return <p className="text-sm text-muted">Loading...</p>
  const sha = info.gitSha && info.gitSha !== 'dev' ? info.gitSha.slice(0, 7) : null
  return (
    <dl className="divide-y divide-border">
      <Fact label="Version">
        {info.version}
        {sha && <span className="text-muted font-mono text-xs"> · {sha}</span>}
      </Fact>
      <Fact label="Database">
        {info.dbBackend === 'postgres' ? 'PostgreSQL' : 'Built-in (PGlite)'}
        {info.pendingMigrations > 0 ? (
          <span className="block text-xs text-amber-400">
            {info.pendingMigrations} update{info.pendingMigrations === 1 ? '' : 's'} waiting for a
            restart
          </span>
        ) : (
          <span className="block text-xs text-approve">Up to date</span>
        )}
      </Fact>
      <Fact label="Safety snapshot">
        {info.lastAutoBackup ? formatDateTime(info.lastAutoBackup.createdAt) : 'None yet'}
        <span className="block text-xs text-muted">Saved automatically before each update</span>
      </Fact>
    </dl>
  )
}
