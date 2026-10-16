export const REJECTION_REASONS = [
  'already_own',
  'wrong_style',
  'not_interested',
  'tried_didnt_like',
  'not_right_now',
  'other',
] as const

export type RejectionReason = (typeof REJECTION_REASONS)[number]

export const REJECTION_REASON_LABEL: Record<RejectionReason, string> = {
  already_own: 'I already own this',
  wrong_style: 'Wrong genre or style for me',
  not_interested: 'Not interested in this artist',
  tried_didnt_like: "Tried it, didn't like it",
  not_right_now: 'Maybe later, not now',
  other: 'Other',
}

const REJECTION_REASON_SET: ReadonlySet<string> = new Set(REJECTION_REASONS)

export function isValidRejectionReason(value: string): value is RejectionReason {
  return REJECTION_REASON_SET.has(value)
}
