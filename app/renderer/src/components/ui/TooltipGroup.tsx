import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import './TooltipGroup.css'

const GroupContext = createContext(false)
export const useTooltipGroup = () => useContext(GroupContext)

interface Props extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'nav' | 'aside'
  side?: 'top' | 'right' | 'bottom'
  onHoverChange?: (hovered: boolean) => void
}

export function TooltipGroup({ as: Tag = 'div', side = 'top', children, onHoverChange, ...props }: Props) {
  const warm = useRef(false)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const target = useRef<HTMLElement | null>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const clear = useCallback(() => {
    clearTimeout(pending.current)
    target.current = null
    setAnchor(null)
  }, [])
  const reset = useCallback(() => {
    clear()
    warm.current = false
  }, [clear])

  useEffect(() => () => onHoverChange?.(false), [onHoverChange])

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') reset() }
    window.addEventListener('blur', reset)
    window.addEventListener('resize', reset)
    window.addEventListener('scroll', reset, true)
    document.addEventListener('visibilitychange', reset)
    window.addEventListener('keydown', escape, true)
    return () => {
      clearTimeout(pending.current)
      window.removeEventListener('blur', reset)
      window.removeEventListener('resize', reset)
      window.removeEventListener('scroll', reset, true)
      document.removeEventListener('visibilitychange', reset)
      window.removeEventListener('keydown', escape, true)
    }
  }, [reset])

  useLayoutEffect(() => {
    if (!anchor || !tip.current) return
    if (!anchor.isConnected || getComputedStyle(anchor).visibility === 'hidden') {
      reset()
      return
    }
    tip.current.textContent = anchor.dataset.tooltip ?? anchor.getAttribute('aria-label')
    const bounds = anchor.getBoundingClientRect()
    const { width, height } = tip.current.getBoundingClientRect()
    let left = side === 'right' ? bounds.right + 9 : bounds.left + (bounds.width - width) / 2
    let top = side === 'right' ? bounds.top + (bounds.height - height) / 2 : side === 'top' ? bounds.top - height - 9 : bounds.bottom + 9
    if (side === 'right' && left + width > window.innerWidth - 8) left = bounds.left - width - 9
    if (side === 'top' && top < 8) top = bounds.bottom + 9
    tip.current.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`
    tip.current.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`
  })

  return (
    <GroupContext.Provider value>
      <Tag
        {...props}
        onPointerEnter={(event) => {
          props.onPointerEnter?.(event)
          if (event.pointerType !== 'touch') onHoverChange?.(true)
        }}
        onPointerLeave={(event) => {
          props.onPointerLeave?.(event)
          reset()
          onHoverChange?.(false)
        }}
        onPointerDownCapture={(event) => { props.onPointerDownCapture?.(event); clear() }}
        onPointerOver={(event) => {
          props.onPointerOver?.(event)
          if (event.pointerType === 'touch' || event.buttons) return
          const element = event.target instanceof Element ? event.target.closest<HTMLElement>('button[aria-label], [data-tooltip]') : null
          const next = element && event.currentTarget.contains(element) && element.dataset.state !== 'open' ? element : null
          if (target.current === next) return
          clear()
          target.current = next
          if (!next) return
          const show = () => {
            if (!next.isConnected) return
            warm.current = true
            setAnchor(next)
          }
          if (warm.current) show()
          else pending.current = setTimeout(show, 1000)
        }}
        onPointerOut={(event) => {
          props.onPointerOut?.(event)
          if (target.current && (!(event.relatedTarget instanceof Node) || !target.current.contains(event.relatedTarget))) clear()
        }}
      >
        {children}
      </Tag>
      {anchor && createPortal(<div ref={tip} className="frost-tooltip" role="tooltip">{anchor.dataset.tooltip ?? anchor.getAttribute('aria-label')}</div>, document.body)}
    </GroupContext.Provider>
  )
}
