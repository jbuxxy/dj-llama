import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/web/components/confirm-dialog'
import { Button } from '@/web/components/ui/button'
import { ApiError, downloadBackup, restoreBackupApi } from '@/web/lib/api'
import { AdminRow } from './admin-row'

type PendingRestore =
  | { file: File; step: 'confirm' }
  | { file: File; step: 'keyMismatch'; fields: string[] }

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const msg = (err.data as { error?: unknown } | null)?.error
    if (typeof msg === 'string' && msg) return msg
  }
  return 'Restore failed'
}

function restoredSummary(tables: Record<string, number>): string {
  const total = Object.values(tables).reduce((a, b) => a + b, 0)
  return `Restored ${total.toLocaleString('en')} rows across ${Object.keys(tables).length} tables`
}

export function BackupSection() {
  const [downloading, setDownloading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [pending, setPending] = useState<PendingRestore | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleDownload() {
    setDownloading(true)
    try {
      // Always include the artist tables: recommendations reference them, so a
      // backup without them can't be restored onto a fresh install.
      await downloadBackup(true)
      toast.success('Backup downloaded')
    } catch {
      toast.error("Couldn't create the backup")
    } finally {
      setDownloading(false)
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (fileRef.current) fileRef.current.value = ''
    if (file) setPending({ file, step: 'confirm' })
  }

  async function runRestore(file: File, force: boolean) {
    setPending(null)
    setRestoring(true)
    try {
      const result = await restoreBackupApi(file, force)
      if (result.encryptionMismatch && !force) {
        setPending({ file, step: 'keyMismatch', fields: result.affectedEncryptedFields })
        return
      }
      toast.success(
        force
          ? `${restoredSummary(result.tablesRestored)}. Re-enter the passwords and API keys listed earlier.`
          : restoredSummary(result.tablesRestored),
      )
      if (result.warnings.length > 0) toast.warning(result.warnings.join(' '))
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const fields = (err.data as { affectedFields?: string[] }).affectedFields ?? []
        setPending({ file, step: 'keyMismatch', fields })
      } else {
        toast.error(errorText(err))
      }
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="divide-y divide-border">
      <AdminRow
        title="Download a backup"
        description="Settings, users, recommendations and playlists, all in one file."
        action={
          <Button size="sm" onClick={handleDownload} disabled={downloading}>
            {downloading ? 'Preparing...' : 'Download'}
          </Button>
        }
      />
      <AdminRow
        title="Restore from a backup"
        description="Replaces everything here with the contents of a backup file."
        action={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              onChange={handleFileSelect}
              className="hidden"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={restoring}
            >
              {restoring ? 'Restoring...' : 'Choose file'}
            </Button>
          </>
        }
      />

      {pending?.step === 'confirm' && (
        <ConfirmDialog
          title="Restore this backup?"
          message={`Everything currently in DJ Llama will be replaced with the contents of "${pending.file.name}". This can't be undone, so download a backup first if you might want today's data back.`}
          confirmLabel="Restore"
          onConfirm={() => runRestore(pending.file, false)}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.step === 'keyMismatch' && (
        <ConfirmDialog
          title="Saved passwords won't carry over"
          message={`This backup was made with a different encryption key, so its saved passwords and API keys can't be read here.${
            pending.fields.length ? ` You'll need to re-enter: ${pending.fields.join(', ')}.` : ''
          } Everything else restores normally.`}
          confirmLabel="Restore anyway"
          onConfirm={() => runRestore(pending.file, true)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}
