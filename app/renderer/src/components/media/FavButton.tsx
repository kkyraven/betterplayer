import { Heart } from 'lucide-react'
import { cx } from '@/lib/cx'
import { IconButton } from '@/components/ui/IconButton'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import './FavButton.css'

interface Props {
  id: number
  favourite: boolean
  size?: 'sm' | 'md'
  className?: string
}

export function FavButton({ id, favourite, size = 'sm', className }: Props) {
  const t = useT()
  return (
    <IconButton
      label={favourite ? t('media.unfavourite') : t('media.favourite')}
      size={size}
      aria-pressed={favourite}
      className={cx('fav', favourite && 'on', className)}
      onClick={(e) => {
        e.stopPropagation()
        void useLibrary.getState().setFavourite([id], !favourite)
      }}
    >
      <Heart />
    </IconButton>
  )
}
