import { Globe, X } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { Slider } from '@/components/ui/Slider'
import { invoke } from '@/ipc'
import { useAccount } from '@/state/account'
import { useAccountNavigation } from '@/state/accountNavigation'
import { useT } from '@/state/i18n'
import { useProfilePhoto } from '@/state/profilePhoto'
import { Avatar } from './Avatar'
import { clampCrop, cropPng, INITIAL_CROP, type PhotoCrop } from './photo-crop'
import './ProfilePhoto.css'

const CROP_FRACTION = 0.72

export function ProfilePhotoDialog() {
  const userId = useProfilePhoto((s) => s.userId)
  const me = useAccount((s) => s.status.me)
  useEffect(() => {
    if (userId && me?.id !== userId) useProfilePhoto.getState().close()
  }, [userId, me?.id])
  return userId && me?.id === userId ? <PhotoEditor key={userId} userId={userId} name={me.name} avatarUrl={me.avatarUrl} /> : null
}

function PhotoEditor({ userId, name, avatarUrl }: { userId: string; name: string; avatarUrl?: string | null }) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const [image, setImage] = useState<{ element: HTMLImageElement; url: string } | null>(null)
  const [crop, setCrop] = useState<PhotoCrop>(INITIAL_CROP)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selection = useRef(0)
  const saving = useRef(false)
  const drag = useRef<{ id: number; x: number; y: number; diameter: number; crop: PhotoCrop } | null>(null)
  useEffect(() => () => { selection.current++ }, [])
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url) }, [image])
  const size = image ? { width: image.element.naturalWidth, height: image.element.naturalHeight } : null
  const close = () => {
    if (saving.current) return
    useProfilePhoto.getState().close()
    if (useAccount.getState().status.me?.id === userId) useAccountNavigation.getState().show('profile')
  }
  const choose = async (file: File | undefined) => {
    if (!file || saving.current) return
    const run = ++selection.current
    setError(null)
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setLoading(false)
      setError(t('settings.profile.photo.unsupported'))
      return
    }
    if (file.size > 20_000_000) {
      setLoading(false)
      setError(t('settings.profile.photo.tooLarge'))
      return
    }
    setLoading(true)
    const url = URL.createObjectURL(file)
    const element = new Image()
    element.src = url
    try {
      await element.decode()
      if (run !== selection.current) { URL.revokeObjectURL(url); return }
      if (element.naturalWidth * element.naturalHeight > 40_000_000) throw new Error('Photo too large')
      setImage({ element, url })
      setCrop(INITIAL_CROP)
    } catch {
      URL.revokeObjectURL(url)
      if (run === selection.current) setError(t('settings.profile.photo.invalid'))
    } finally {
      if (run === selection.current) setLoading(false)
    }
  }
  const save = async (remove = false) => {
    if (saving.current || loading || (!remove && !image)) return
    const run = selection.current
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      const png = remove ? null : cropPng(image!.element, crop)
      await invoke('account:setAvatar', userId, png)
      if (run !== selection.current) return
      saving.current = false
      close()
    } catch {
      if (run === selection.current) setError(t(remove ? 'settings.profile.photo.removeFailed' : 'settings.profile.photo.uploadFailed'))
    } finally {
      saving.current = false
      if (run === selection.current) setBusy(false)
    }
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start || start.id !== event.pointerId || !size || busy) return
    setCrop(clampCrop(size, { ...start.crop, x: start.crop.x + (event.clientX - start.x) / start.diameter, y: start.crop.y + (event.clientY - start.y) / start.diameter }))
  }
  return (
    <Modal open onOpenChange={(open) => { if (!open) close() }} title={t('settings.profile.photo.title')} width={400}>
      <div className="profile-photo-dialog" onKeyDown={(event) => { if (event.key !== 'Tab') event.stopPropagation() }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }} onDrop={(event) => { event.preventDefault(); event.stopPropagation() }}>
        <header><h2>{t('settings.profile.photo.title')}</h2><IconButton label={t('common.close')} disabled={busy} onClick={close}><X /></IconButton></header>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void choose(file) }} />
        {image && size ? (
          <>
            <div className="profile-photo-crop" tabIndex={busy ? -1 : 0} role="group" aria-label={t('settings.profile.photo.reposition')} aria-description={t('settings.profile.photo.arrowKeys')} aria-disabled={busy}
              onPointerDown={(event) => {
                if (busy || !event.isPrimary || event.button !== 0 || drag.current) return
                event.currentTarget.setPointerCapture(event.pointerId)
                event.currentTarget.focus()
                drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, diameter: event.currentTarget.getBoundingClientRect().width * CROP_FRACTION, crop }
              }}
              onPointerMove={move}
              onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
              onKeyDown={(event) => {
                if (busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
                event.preventDefault()
                const step = event.shiftKey ? 0.1 : 0.02
                setCrop((current) => clampCrop(size, { ...current, x: current.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), y: current.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }))
              }}>
              <img src={image.url} alt="" draggable={false} style={{ width: `${size.width / Math.min(size.width, size.height) * CROP_FRACTION * crop.zoom * 100}%`, left: `${50 + crop.x * CROP_FRACTION * 100}%`, top: `calc(50% + ${crop.y * CROP_FRACTION * 128}%)` }} />
              <span className="profile-photo-mask" />
            </div>
            <div className="profile-photo-zoom"><span>{t('settings.profile.photo.zoom')}</span><Slider value={[crop.zoom]} min={1} max={3} step={0.01} disabled={busy || loading} label={t('settings.profile.photo.zoom')} onValueChange={([zoom]) => setCrop((current) => clampCrop(size, { ...current, zoom: zoom ?? 1 }))} /></div>
          </>
        ) : <div className="profile-photo-preview"><Avatar name={name} url={avatarUrl} size={112} /></div>}
        <div className="profile-photo-choose"><Button disabled={busy || loading} onClick={() => input.current?.click()}>{t(loading ? 'settings.profile.photo.loading' : image ? 'settings.profile.photo.chooseAnother' : 'settings.profile.photo.choose')}</Button></div>
        <div className="profile-photo-notice"><Globe size={16} aria-hidden /><p><strong>{t('settings.profile.photo.notice')}</strong><br />{t('settings.profile.photo.noticeDetail')}</p></div>
        {error && <p className="profile-photo-error" role="alert">{error}</p>}
        <div className="profile-photo-actions">
          {avatarUrl && !image && <Button variant="ghost" disabled={busy || loading} onClick={() => void save(true)}>{t('settings.profile.photo.remove')}</Button>}
          <span className="spacer" />
          <Button variant="ghost" disabled={busy} onClick={close}>{t('common.cancel')}</Button>
          {image && <Button variant="primary" disabled={busy || loading} onClick={() => void save()}>{t(busy ? 'settings.profile.photo.uploading' : 'settings.profile.photo.upload')}</Button>}
        </div>
      </div>
    </Modal>
  )
}
