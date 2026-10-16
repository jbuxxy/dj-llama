import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/web/components/confirm-dialog'
import { Button } from '@/web/components/ui/button'
import { Input } from '@/web/components/ui/input'
import { ApiError, migrateBackendApi, testMigrateTarget } from '@/web/lib/api'

// Only rendered when this install runs on the built-in PGlite database: the one
// useful move is out to a real PostgreSQL server. (The API can also target
// PGlite, but nobody on Postgres needs to go back.)

const TEST_ERRORS: Record<string, string> = {
  unreachable: "Couldn't reach that server. Check the host and port.",
  auth_failed: 'The username or password was rejected.',
  timeout: 'The server took too long to answer.',
  db_missing: "That database doesn't exist on the server yet. Create it first.",
  unknown: "Couldn't connect.",
}

type MigrateResult = {
  ok: boolean
  tablesMigrated: Record<string, number>
  mismatches: { table: string; source: number; target: number; contentDiffers?: boolean }[]
  targetEnvHint: string
}

type TestState =
  | { status: 'idle' }
  | { status: 'ok'; description: string }
  | { status: 'error'; message: string }

function isPostgresUrl(value: string): boolean {
  try {
    const u = new URL(value.trim())
    return (u.protocol === 'postgres:' || u.protocol === 'postgresql:') && !!u.hostname
  } catch {
    return false
  }
}

function apiMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.data && typeof err.data === 'object') {
    const data = err.data as { code?: unknown; error?: unknown; detail?: unknown; title?: unknown }
    if (typeof data.code === 'string' && TEST_ERRORS[data.code])
      return TEST_ERRORS[data.code] as string
    for (const v of [data.detail, data.error, data.title]) if (typeof v === 'string' && v) return v
  }
  return fallback
}

export function MigrateBackendSection() {
  const [dsn, setDsn] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [testing, setTesting] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [result, setResult] = useState<MigrateResult | null>(null)
  const [copied, setCopied] = useState(false)

  const validUrl = isPostgresUrl(dsn)
  const target = { backend: 'postgres' as const, dsn: dsn.trim() }

  async function handleTest() {
    setTesting(true)
    try {
      const res = await testMigrateTarget(target)
      setTest(
        res.ok
          ? { status: 'ok', description: res.description ?? 'PostgreSQL' }
          : {
              status: 'error',
              message: TEST_ERRORS[res.code ?? 'unknown'] ?? TEST_ERRORS.unknown ?? '',
            },
      )
    } catch (err) {
      setTest({ status: 'error', message: apiMessage(err, "Couldn't connect.") })
    } finally {
      setTesting(false)
    }
  }

  async function handleMigrate() {
    setShowConfirm(false)
    setMigrating(true)
    setResult(null)
    try {
      setResult(await migrateBackendApi(target, overwrite))
    } catch (err) {
      // A verification failure still returns the report (422) -- show it.
      if (
        err instanceof ApiError &&
        err.status === 422 &&
        err.data &&
        typeof err.data === 'object' &&
        'report' in err.data
      ) {
        setResult((err.data as { report: MigrateResult }).report)
      } else {
        toast.error(apiMessage(err, 'Migration failed'))
      }
    } finally {
      setMigrating(false)
    }
  }

  async function copyHint(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard unavailable (non-secure context); the text stays selectable.
    }
  }

  const totalRows = result ? Object.values(result.tablesMigrated).reduce((a, b) => a + b, 0) : 0

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        DJ Llama is using its built-in database. For bigger libraries or several users, copy
        everything to a PostgreSQL server. Your current data isn't changed.
      </p>

      <div>
        <label
          htmlFor="migrate-postgres-dsn"
          className="block text-xs font-medium text-muted mb-1.5"
        >
          PostgreSQL connection URL
        </label>
        <Input
          id="migrate-postgres-dsn"
          type="password"
          value={dsn}
          onChange={(e) => {
            setDsn(e.target.value)
            setTest({ status: 'idle' })
          }}
          placeholder="postgresql://user:password@host:5432/djllama"
          autoComplete="off"
          spellCheck={false}
        />
        {dsn && !validUrl && (
          <p className="text-xs text-reject mt-1.5">
            Should look like postgresql://user:password@host:5432/database
          </p>
        )}
        {test.status === 'ok' && (
          <p className="text-xs text-approve mt-1.5">Connected to {test.description}</p>
        )}
        {test.status === 'error' && <p className="text-xs text-reject mt-1.5">{test.message}</p>}
      </div>

      <label className="flex items-start gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(e) => setOverwrite(e.target.checked)}
          className="mt-0.5 rounded border-border"
        />
        <span>
          Replace anything already in that database
          <span className="block text-xs text-muted">
            Leave off unless a previous attempt stopped partway.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleTest}
          disabled={!validUrl || testing || migrating}
        >
          {testing ? 'Testing...' : 'Test connection'}
        </Button>
        <Button
          size="sm"
          onClick={() => setShowConfirm(true)}
          disabled={!validUrl || testing || migrating}
        >
          {migrating ? 'Copying...' : 'Copy to PostgreSQL'}
        </Button>
      </div>

      {result && (
        <div className="space-y-2 rounded-lg border border-border bg-bg p-3">
          <p className="text-sm font-medium text-text">
            {result.ok
              ? `Copied ${totalRows.toLocaleString('en')} rows`
              : `Copied, but ${result.mismatches.map((m) => m.table).join(', ')} didn't match. Don't switch over yet.`}
          </p>
          {result.ok && (
            <>
              <p className="text-xs text-muted">
                To switch, set this environment variable on the container and restart it:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 break-all rounded border border-border bg-surface px-2 py-1 font-mono text-xs">
                  {result.targetEnvHint}
                </code>
                <Button size="sm" variant="outline" onClick={() => copyHint(result.targetEnvHint)}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {showConfirm && (
        <ConfirmDialog
          title="Copy to PostgreSQL?"
          message="DJ Llama pauses changes while it copies everything over. Your current database isn't touched. When it's done you'll get the setting to switch to the new one."
          confirmLabel="Start copy"
          destructive={false}
          onConfirm={handleMigrate}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  )
}
