import { Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { errMsg } from '@/core/validation'
import { ApiError, createRequest, type IdentifySongResult, identifySong } from '../lib/api'
import { blobToWav } from '../lib/wav-encode'
import { Button } from './ui/button'

type Props = {
  onClose: () => void
}

type Phase = 'listening' | 'identifying' | 'confirm' | 'requesting' | 'result' | 'error'

type Candidate = {
  artist: string
  title: string
  artistMbid: string
  artistName: string
  releaseGroupMbid: string
  albumTitle: string
  coverUrl?: string
}

type Outcome =
  | { kind: 'no-match' }
  | { kind: 'unresolved'; artist: string; title: string }
  | { kind: 'already-owned'; artist: string; album: string; coverUrl?: string }
  | { kind: 'dispatched'; artist: string; album: string; coverUrl?: string }
  | { kind: 'pending'; artist: string; album: string; coverUrl?: string }
  | { kind: 'failed'; artist: string; album: string; coverUrl?: string }

// shazam-api documents its own target clip length as 8s (Shazam.MAX_TIME_SCEONDS)
// -- unlike AudioTag, which wanted up to 30s, Shazam's fingerprinting doesn't
// benefit from a longer first attempt. We still check in across a couple of
// short segments and stop the moment one matches, rather than listening the
// full window on the first try.
const CHECKPOINT_MS = 8_000
const MAX_CHECKPOINTS = 2
const MIME_CANDIDATES = ['audio/webm', 'audio/mp4', 'audio/ogg']

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

export function SongIdentifyDialog({ onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('listening')
  const [errorMessage, setErrorMessage] = useState('')
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const startedRef = useRef(false)

  // Runs exactly once on mount to start recording.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    let cancelled = false
    let stream: MediaStream | null = null

    // Records one independently-finalized clip (not a periodic snapshot of
    // an ongoing stream). This matters on iOS, where every browser -- Chrome
    // included -- runs on WebKit and MediaRecorder only outputs MP4. Unlike
    // WebM, MP4's metadata is normally written once at finalization, so a
    // blob built from concatenated mid-stream chunks can fail to decode past
    // a sliver of audio (surfacing as AudioTag's "audio is too short"). A
    // properly stopped recorder always produces a complete, valid file
    // regardless of container, so each checkpoint gets its own short
    // recording instead of a growing snapshot of one long one.
    function recordSegment(s: MediaStream, durationMs: number): Promise<Blob> {
      return new Promise((resolve) => {
        const mimeType = pickMimeType()
        const recorder = new MediaRecorder(s, mimeType ? { mimeType } : undefined)
        recorderRef.current = recorder
        const chunks: BlobPart[] = []
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data)
        }
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
        }
        recorder.start()
        setTimeout(() => {
          if (recorder.state === 'recording') recorder.stop()
        }, durationMs)
      })
    }

    async function attemptIdentify(raw: Blob): Promise<IdentifySongResult | 'error'> {
      try {
        const wav = await blobToWav(raw)
        return await identifySong(wav, 'clip.wav')
      } catch {
        return 'error'
      }
    }

    async function applyResult(res: IdentifySongResult | 'error') {
      if (res === 'error') {
        setPhase('error')
        setErrorMessage('Something went wrong. Try again.')
        return
      }
      if (!res.matched) {
        setOutcome({ kind: 'no-match' })
        setPhase('result')
        return
      }
      if (!res.resolved) {
        setOutcome({ kind: 'unresolved', artist: res.artist, title: res.title })
        setPhase('result')
        return
      }
      if (res.alreadyOwned) {
        setOutcome({
          kind: 'already-owned',
          artist: res.artistName,
          album: res.albumTitle,
          coverUrl: res.coverUrl,
        })
        setPhase('result')
        return
      }
      // Not owned and resolved to an album -- ask before requesting rather
      // than dispatching automatically, so a wrong/ambiguous identification
      // never silently fires off a Lidarr add.
      setCandidate({
        artist: res.artist,
        title: res.title,
        artistMbid: res.artistMbid,
        artistName: res.artistName,
        releaseGroupMbid: res.releaseGroupMbid,
        albumTitle: res.albumTitle,
        coverUrl: res.coverUrl,
      })
      setPhase('confirm')
    }

    async function runListeningLoop(s: MediaStream) {
      for (let checkpoint = 1; checkpoint <= MAX_CHECKPOINTS; checkpoint++) {
        if (cancelled) return
        setPhase('listening')
        const segment = await recordSegment(s, CHECKPOINT_MS)
        if (cancelled) return

        setPhase('identifying')
        const res = await attemptIdentify(segment)
        if (cancelled) return

        const isFinal = checkpoint >= MAX_CHECKPOINTS
        if ((res !== 'error' && res.matched) || isFinal) {
          await applyResult(res)
          return
        }
      }
    }

    navigator.mediaDevices
      // Default mic constraints apply voice-call DSP (echo cancellation,
      // noise suppression, auto-gain) that's tuned for speech and actively
      // destroys the frequency/transient content music fingerprinting needs
      // -- confirmed via a direct re-upload test where AudioTag parsed our
      // clip as a correctly-sized 10s file but still rejected it as having
      // too little usable signal. Disable all three to capture raw audio.
      .getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      .then((s) => {
        if (cancelled) {
          for (const tr of s.getTracks()) tr.stop()
          return
        }
        stream = s
        void runListeningLoop(s).finally(() => {
          for (const tr of s.getTracks()) tr.stop()
        })
      })
      .catch((err) => {
        if (cancelled) return
        setPhase('error')
        setErrorMessage(errMsg(err))
      })

    return () => {
      cancelled = true
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
      for (const tr of stream?.getTracks() ?? []) tr.stop()
    }
  }, [])

  async function confirmRequest() {
    if (!candidate) return
    setPhase('requesting')
    try {
      const created = await createRequest({
        kind: 'album',
        artistMbid: candidate.artistMbid,
        artistName: candidate.artistName,
        releaseGroupMbid: candidate.releaseGroupMbid,
        albumTitle: candidate.albumTitle,
        coverUrl: candidate.coverUrl,
      })
      setOutcome({
        kind: created.status === 'dispatched' ? 'dispatched' : 'pending',
        artist: candidate.artistName,
        album: candidate.albumTitle,
        coverUrl: candidate.coverUrl,
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setOutcome({
          kind: 'already-owned',
          artist: candidate.artistName,
          album: candidate.albumTitle,
          coverUrl: candidate.coverUrl,
        })
      } else {
        setOutcome({
          kind: 'failed',
          artist: candidate.artistName,
          album: candidate.albumTitle,
          coverUrl: candidate.coverUrl,
        })
      }
    }
    setPhase('result')
  }

  function resultMessage(): string {
    if (!outcome) return ''
    switch (outcome.kind) {
      case 'no-match':
        return "Couldn't identify that song. Try again."
      case 'unresolved':
        return `Identified as "${outcome.title}" by ${outcome.artist}, but couldn't find a matching album to request.`
      case 'already-owned':
        return `Already in your library: ${outcome.artist} – ${outcome.album}`
      case 'dispatched':
        return `Requested ${outcome.artist} – ${outcome.album}`
      case 'pending':
        return `Added to the request queue for admin approval: ${outcome.artist} – ${outcome.album}`
      case 'failed':
        return `Identified ${outcome.artist} – ${outcome.album}, but the request failed. Try again.`
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
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Identify song"
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: dialog content wrapper prevents click-through */}
        <div
          className="bg-surface border border-border rounded-lg shadow-lg w-full max-w-sm p-4"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
        >
          <div className="flex items-start justify-between">
            <h3 className="text-sm font-medium text-text">Identify song</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cancel"
              className="text-muted hover:text-text"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex flex-col items-center gap-3 py-6">
            {(phase === 'listening' || phase === 'identifying') && (
              <>
                <Loader2 size={32} className="text-accent animate-spin" aria-hidden="true" />
                <p className="text-sm text-muted">Identifying...</p>
              </>
            )}
            {phase === 'confirm' && candidate && (
              <>
                {candidate.coverUrl && (
                  <img
                    src={candidate.coverUrl}
                    alt=""
                    className="w-20 h-20 rounded object-cover bg-bg"
                  />
                )}
                <p className="text-sm text-text text-center">
                  {`Identified "${candidate.albumTitle}" by ${candidate.artistName}. Request it?`}
                </p>
              </>
            )}
            {phase === 'requesting' && (
              <>
                <Loader2 size={32} className="text-accent animate-spin" aria-hidden="true" />
                <p className="text-sm text-muted">Requesting...</p>
              </>
            )}
            {phase === 'result' && (
              <>
                {outcome && 'coverUrl' in outcome && outcome.coverUrl && (
                  <img
                    src={outcome.coverUrl}
                    alt=""
                    className="w-20 h-20 rounded object-cover bg-bg"
                  />
                )}
                <p className="text-sm text-text text-center">{resultMessage()}</p>
              </>
            )}
            {phase === 'error' && (
              <p className="text-sm text-reject text-center">
                {errorMessage || 'Something went wrong. Try again.'}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            {phase === 'confirm' ? (
              <>
                <Button size="sm" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button size="sm" onClick={confirmRequest}>
                  Request
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={onClose} disabled={phase === 'requesting'}>
                {phase === 'listening' || phase === 'identifying' ? 'Cancel' : 'Close'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
