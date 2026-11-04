import type { ImgHTMLAttributes, SyntheticEvent } from 'react'
import { cx } from '@/lib/cx'
import './ThumbnailImage.css'

export function ThumbnailImage({ onError, onLoad, keyed, className, ...props }: ImgHTMLAttributes<HTMLImageElement> & { keyed?: boolean }) {
  const hide = (e: SyntheticEvent<HTMLImageElement>) => {
    e.currentTarget.style.visibility = 'hidden'
    onError?.(e)
  }
  const show = (e: SyntheticEvent<HTMLImageElement>) => {
    e.currentTarget.style.removeProperty('visibility')
    onLoad?.(e)
  }

  return <img {...props} className={cx(className, keyed && 'keyed') || undefined} onError={hide} onLoad={show} />
}
