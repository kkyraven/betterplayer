import * as Popover from '@radix-ui/react-popover'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '@/state/i18n'
import { IconButton } from './IconButton'
import './Sheet.css'

interface Props {
  trigger: ReactNode
  title: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: 'start' | 'center' | 'end'
  width?: number
  children: ReactNode
}

export function Sheet({ trigger, title, open, onOpenChange, align = 'end', width = 320, children }: Props) {
  const t = useT()
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="sheet" align={align} sideOffset={8} collisionPadding={12} style={{ width }}>
          <div className="sheet-hd">
            <h2>{title}</h2>
            <Popover.Close asChild>
              <IconButton label={t('common.close')} size="sm">
                <X />
              </IconButton>
            </Popover.Close>
          </div>
          <div className="sheet-body">{children}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
