import { useEffect, useId, useRef, useState } from 'react'
import {
  REJECTION_REASON_LABEL,
  REJECTION_REASONS,
  type RejectionReason,
} from '@/core/recommendations/rejection-reasons'
import { Button } from './ui/button'

type Props = {
  open: boolean
  onClose: () => void
  onSubmit: (payload: {
    reason: RejectionReason | null
    reasonText: string | null
    permanent: boolean
  }) => Promise<void>
  artistName?: string
}

export function RejectionPicker({ open, onClose, onSubmit, artistName }: Props) {
  const titleId = useId()
  const [reason, setReason] = useState<RejectionReason | null>(null)
  const [reasonText, setReasonText] = useState('')
  const [permanent, setPermanent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const firstRadioRef = useRef<HTMLButtonElement | null>(null)

  // Reset on open/close so a stale reason from a prior card never bleeds in.
  useEffect(() => {
    if (!open) {
      setReason(null)
      setReasonText('')
      setPermanent(false)
      setSubmitting(false)
    } else {
      requestAnimationFrame(() => firstRadioRef.current?.focus())
    }
  }, [open])

  // not_right_now is incompatible with permanent: drop the flag if user
  // back-tracks into that combination.
  useEffect(() => {
    if (reason === 'not_right_now' && permanent) setPermanent(false)
  }, [reason, permanent])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const submitLabel = permanent ? 'Block forever' : 'Reject'
  const permanentDisabled = reason === 'not_right_now'

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      await onSubmit({
        reason,
        reasonText: reason === 'other' ? reasonText.trim() || null : null,
        permanent,
      })
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-bg/70 backdrop-blur-sm z-50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: dialog content wrapper prevents click-through */}
        <div
          className="bg-surface text-text border border-border w-full md:max-w-md md:rounded-xl rounded-t-xl p-4 max-h-[85vh] overflow-y-auto shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
        >
          <div className="md:hidden mx-auto mb-3 h-1 w-9 rounded-full bg-border" />
          <h2 id={titleId} className="text-base font-semibold mb-3">
            {artistName ? `Why are you rejecting? - ${artistName}` : 'Why are you rejecting?'}
          </h2>

          <div className="grid gap-1.5">
            {REJECTION_REASONS.map((r, i) => (
              <button
                key={r}
                ref={i === 0 ? firstRadioRef : undefined}
                type="button"
                aria-pressed={reason === r}
                onClick={() => setReason(r)}
                className={`text-left px-3 py-2 rounded-md border text-sm transition-colors ${
                  reason === r
                    ? 'bg-accent/10 border-accent text-text'
                    : 'bg-bg border-border text-muted hover:text-text'
                }`}
              >
                {REJECTION_REASON_LABEL[r]}
              </button>
            ))}
          </div>

          {reason === 'other' && (
            <textarea
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value.slice(0, 200))}
              placeholder="Tell us why (optional, 200 chars)"
              maxLength={200}
              className="mt-2 w-full bg-bg border border-border rounded-md p-2 text-sm"
              rows={3}
            />
          )}

          <label
            className={`mt-3 flex items-center gap-2 text-sm ${permanentDisabled ? 'opacity-50' : ''}`}
            title={permanentDisabled ? "Disabled when 'Maybe later' is selected" : undefined}
          >
            <input
              type="checkbox"
              checked={permanent}
              disabled={permanentDisabled}
              onChange={(e) => setPermanent(e.target.checked)}
            />
            <span>Don't show this artist again</span>
          </label>

          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant={permanent ? 'destructive' : 'outline'}
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitLabel}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
