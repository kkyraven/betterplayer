import type { ImgHTMLAttributes, SyntheticEvent } from 'react'

export function ThumbnailImage({ onError, onLoad, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const hide = (e: SyntheticEvent<HTMLImageElement>) => {
    e.currentTarget.style.visibility = 'hidden'
    onError?.(e)
  }
  const show = (e: SyntheticEvent<HTMLImageElement>) => {
    e.currentTarget.style.removeProperty('visibility')
    onLoad?.(e)
  }

  return <img {...props} onError={hide} onLoad={show} />
}
