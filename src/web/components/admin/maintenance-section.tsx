import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/web/components/ui/button'
import { clearImageFailures } from '@/web/lib/api'
import { AdminRow } from './admin-row'

export function MaintenanceSection() {
  const [running, setRunning] = useState(false)
  const [cleared, setCleared] = useState<number | null>(null)

  async function handleRetry() {
    setRunning(true)
    try {
      const result = await clearImageFailures()
      setCleared(result.cleared)
    } catch {
      toast.error("Couldn't reset image failures")
    } finally {
      setRunning(false)
    }
  }

  return (
    <AdminRow
      title="Retry missing artist images"
      description={
        cleared === null
          ? "Artists whose photo couldn't be found are retried after a week. Retry them now instead."
          : cleared === 0
            ? 'Nothing to retry. No artists are missing images.'
            : `${cleared} artist${cleared === 1 ? '' : 's'} will be retried.`
      }
      action={
        <Button size="sm" variant="outline" onClick={handleRetry} disabled={running}>
          {running ? 'Resetting...' : 'Retry images'}
        </Button>
      }
    />
  )
}
