export function TargetIcon({ type }: { type: string }) {
  switch (type) {
    case 'lidarr':
      return <img src="/icons/lidarr.png" alt="" className="w-4 h-4" />
    default:
      return <div className="w-4 h-4" />
  }
}

export function canApproveArtistToTarget(type: string): boolean {
  return type === 'lidarr'
}

export function targetActionLabel(type: string, name: string): string {
  switch (type) {
    case 'lidarr':
      return `Add to ${name}`
    default:
      return `Send to ${name}`
  }
}
