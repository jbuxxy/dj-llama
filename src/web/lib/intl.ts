function toDate(value: string | Date): Date {
  return typeof value === 'string' ? new Date(value) : value
}

export function formatDate(value: string | Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en', options).format(toDate(value))
}

export function formatShortDate(value: string | Date): string {
  return formatDate(value, { month: 'short', day: 'numeric' })
}

export function formatShortDateTime(value: string | Date): string {
  return formatDate(value, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDateTime(value: string | Date): string {
  return formatDate(value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}
