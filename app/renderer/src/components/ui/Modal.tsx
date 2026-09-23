import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import './Modal.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  width?: number
  children: ReactNode
}

export function Modal({ open, onOpenChange, title, width = 760, children }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim" />
        <Dialog.Content className="modal" style={{ width }} aria-describedby={undefined}>
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
