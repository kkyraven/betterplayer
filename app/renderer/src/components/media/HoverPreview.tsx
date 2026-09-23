import { useEffect, useRef, useState } from 'react'

export function HoverPreview({ src, onError }: { src: string; onError: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    const element = video.current
    if (!element) return
    element.src = src
    return () => {
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
  }, [src])
  return <video ref={video} className="poster" src={src} autoPlay muted loop playsInline
    aria-hidden="true" disablePictureInPicture
    style={{ pointerEvents: 'none', opacity: playing ? 1 : 0 }}
    onPlaying={() => setPlaying(true)} onError={onError} />
}
