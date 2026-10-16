import { toast } from 'sonner'
import type { ApprovalResponse } from './api'

/**
 * Surface the per-target outcome of an approve attempt at submit time.
 * Returns true when every attempted target succeeded (caller runs its normal
 * success path); returns false after showing a partial/total-failure toast.
 */
export function reportApprovalOutcome(res: ApprovalResponse): boolean {
  const summary = res.targetSummary
  if (summary && summary.total > 0 && summary.failed > 0) {
    const names = summary.failures.map((f) => f.name).join(', ')
    if (summary.succeeded > 0) {
      toast.warning(`Added to ${summary.succeeded} of ${summary.total} targets. Failed: ${names}`)
    } else {
      toast.error(`Could not add to any target. Failed: ${names}`)
    }
    return false
  }
  // No target summary (discovery-only / no actionable targets) but the server
  // still reports a failed add.
  if (res.status === 'add_failed') {
    toast.error('Failed to approve')
    return false
  }
  // Full success, but a target reported a non-fatal partial outcome (e.g. the
  // artist was added but the selected album could not be monitored yet).
  if (summary?.warnings?.length) {
    toast.warning(summary.warnings.join('; '))
  }
  return true
}
