export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`shrink-0 w-9 h-5 rounded-full transition-colors relative disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? 'bg-approve' : 'bg-border'
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-bg transition-transform ${
          checked ? 'left-4' : 'left-0.5'
        }`}
      />
    </button>
  )
}
