import { Bell } from 'lucide-react'
import { useState } from 'react'

function ServiceLogo({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span
        aria-hidden={alt ? undefined : true}
        className="flex items-center justify-center w-6 h-6 rounded bg-surface text-micro font-bold text-muted"
      >
        {alt.charAt(0) || '?'}
      </span>
    )
  }
  return <img src={src} alt={alt} className="w-6 h-6 rounded" onError={() => setFailed(true)} />
}

export function LidarrIcon() {
  return <ServiceLogo src="/icons/lidarr.png" alt="Lidarr" />
}

export function AiProviderIcon({ provider }: { provider?: string }) {
  const icons: Record<string, { src: string; alt: string }> = {
    anthropic: { src: '/icons/anthropic.png', alt: 'Anthropic' },
    openai: { src: '/icons/openai.png', alt: 'OpenAI' },
    gemini: { src: '/icons/gemini.png', alt: 'Google Gemini' },
    ollama: { src: '/icons/ollama.png', alt: 'Ollama' },
  }
  const icon = provider ? icons[provider] : null
  if (icon) return <ServiceLogo src={icon.src} alt={icon.alt} />
  // Generic fallback for openai-compatible or unknown
  return <ServiceLogo src="/icons/openai.png" alt="" />
}

export function SpotifyIcon() {
  return <ServiceLogo src="/icons/spotify.svg" alt="Spotify" />
}

export function DeezerIcon() {
  return <ServiceLogo src="/icons/deezer.svg" alt="Deezer" />
}

export function AppleMusicIcon() {
  return <ServiceLogo src="/icons/apple-music.svg" alt="Apple Music" />
}

export function PlexIcon() {
  return <ServiceLogo src="/icons/plex.svg" alt="Plex" />
}

export function WebhookIcon() {
  return (
    <span className="flex items-center justify-center w-6 h-6 text-svc-webhook">
      <Bell size={18} />
    </span>
  )
}
