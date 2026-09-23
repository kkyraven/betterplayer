import { Globe } from 'lucide-react'
import type { Me } from '@shared/account'
import { Button } from '@/components/ui/Button'
import { useT } from '@/state/i18n'
import { useProfilePhoto } from '@/state/profilePhoto'
import { Avatar } from './Avatar'
import './ProfilePhoto.css'

export function ProfilePhotoRow({ me }: { me: Me }) {
  const t = useT()
  return (
    <div className="prow profile-photo-row">
      <Avatar name={me.name} url={me.avatarUrl} size={56} />
      <div className="profile-photo-label"><div className="lbl">{t('settings.profile.photo.title')}</div><div className="sub"><Globe size={12} aria-hidden />{t('settings.profile.photo.public')}</div></div>
      <Button onClick={() => useProfilePhoto.getState().show(me.id)}>{t(me.avatarUrl ? 'settings.profile.photo.change' : 'settings.profile.photo.choose')}</Button>
    </div>
  )
}
