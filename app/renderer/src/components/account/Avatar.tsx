import { CircleUser } from 'lucide-react'
import { useState } from 'react'
import './Avatar.css'

export function Avatar({ name, url, size = 32 }: { name: string; url?: string | null; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <span className="profile-avatar" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {url && failed !== url ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(url)} /> : name.trim() ? Array.from(name.trim())[0]?.toLocaleUpperCase() : <CircleUser size={size * 0.6} />}
    </span>
  )
}
