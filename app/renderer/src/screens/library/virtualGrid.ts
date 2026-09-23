import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const OVERSCAN = 1
const PRIME = 24

export interface VirtualRange {
  start: number
  end: number
  padTop: number
  padBottom: number
}

interface Layout {
  cols: number
  stride: number
  top: number
}

export function useVirtualGrid(scroll: RefObject<HTMLElement | null>, grid: RefObject<HTMLElement | null>, count: number, view: string) {
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: Math.min(count, PRIME), padTop: 0, padBottom: 0 })
  const layout = useRef<Layout | null>(null)

  const measure = useCallback(() => {
    const scrollEl = scroll.current
    const gridEl = grid.current
    if (!scrollEl || !gridEl) return
    const kids = gridEl.children
    if (count === 0 || kids.length === 0) {
      layout.current = null
      setRange((r) => (r.start === 0 && r.end === Math.min(count, PRIME) && r.padTop === 0 && r.padBottom === 0 ? r : { start: 0, end: Math.min(count, PRIME), padTop: 0, padBottom: 0 }))
      return
    }
    const style = getComputedStyle(gridEl)
    const cols = style.gridTemplateColumns === 'none' ? 1 : style.gridTemplateColumns.split(' ').length
    const first = kids[0] as HTMLElement
    const nextRow = kids[cols] as HTMLElement | undefined
    const stride = nextRow ? nextRow.offsetTop - first.offsetTop : first.offsetHeight + (parseFloat(style.rowGap) || 0)
    if (stride <= 0) return
    const top = gridEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
    layout.current = { cols, stride, top }
    const viewTop = scrollEl.scrollTop - top
    const height = scrollEl.clientHeight
    const rows = Math.ceil(count / cols)
    const startRow = Math.min(rows, Math.max(0, Math.floor((viewTop - height * OVERSCAN) / stride)))
    const endRow = Math.min(rows, Math.max(startRow, Math.ceil((viewTop + height * (1 + OVERSCAN)) / stride)))
    const next = { start: startRow * cols, end: Math.min(count, endRow * cols), padTop: startRow * stride, padBottom: (rows - endRow) * stride }
    setRange((r) => (r.start === next.start && r.end === next.end && r.padTop === next.padTop && r.padBottom === next.padBottom ? r : next))
  }, [scroll, grid, count])

  useLayoutEffect(() => {
    measure()
    const scrollEl = scroll.current
    const gridEl = grid.current
    if (!scrollEl || !gridEl) return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(onScroll)
    ro.observe(scrollEl)
    ro.observe(gridEl)
    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [measure, view])

  const scrollToIndex = useCallback(
    (index: number) => {
      const scrollEl = scroll.current
      const l = layout.current
      if (!scrollEl || !l) return
      const row = Math.floor(index / l.cols)
      scrollEl.scrollTop = Math.max(0, l.top + row * l.stride - (scrollEl.clientHeight - l.stride) / 2)
      measure()
    },
    [scroll, measure],
  )

  return { range, scrollToIndex }
}
