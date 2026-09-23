import type { ImgHTMLAttributes } from 'react'
import mark from '@/assets/brand/mark.svg'
import lockup from '@/assets/brand/lockup-dark.svg'
import lightLockup from '@/assets/brand/lockup.svg'
import { useSystemDark } from '@/state/theme'
import { useSettings } from '@/state/settings'
import { resolveMode } from '@shared/theme'

const assets = {
  mark: { src: mark, width: 24, height: 24 },
  lockup: { src: lockup, width: 125.62, height: 22 },
}

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { variant?: keyof typeof assets; scheme?: 'light' | 'dark' }

export function Logo({ alt = 'Better Player', variant = 'mark', scheme, ...props }: Props) {
  const mode = useSettings((s) => s.settings?.appearance.theme.mode ?? 'dark')
  const systemDark = useSystemDark()
  const dark = (scheme ?? resolveMode(mode, systemDark)) !== 'light'
  return <img {...assets[variant]} src={variant === 'lockup' && !dark ? lightLockup : assets[variant].src} alt={alt} draggable={false} {...props} />
}
