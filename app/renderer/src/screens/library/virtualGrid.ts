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
  shape: string
  entries: readonly unknown[]
}

export interface GridPosition {
  top: number
  anchor: { index: number; offset: number } | null
  range: VirtualRange
}

const sameRange = (a: VirtualRange, b: VirtualRange) => a.start === b.start && a.end === b.end && a.padTop === b.padTop && a.padBottom === b.padBottom

export function rowRange(count: number, cols: number, stride: number, viewTop: number, height: number): VirtualRange {
  const rows = Math.ceil(count / cols)
  const lastStart = Math.max(0, rows - Math.max(1, Math.ceil((height * (1 + OVERSCAN)) / stride)))
  const startRow = Math.min(lastStart, Math.max(0, Math.floor((viewTop - height * OVERSCAN) / stride)))
  const endRow = Math.min(rows, Math.max(startRow + 1, Math.ceil((viewTop + height * (1 + OVERSCAN)) / stride)))
  return { start: startRow * cols, end: Math.min(count, endRow * cols), padTop: startRow * stride, padBottom: (rows - endRow) * stride }
}

export function useVirtualGrid(scroll: RefObject<HTMLElement | null>, grid: RefObject<HTMLElement | null>, entries: readonly unknown[], view: string, list: number, position?: RefObject<GridPosition | null>) {
  const count = entries.length
  const [range, setRange] = useState<VirtualRange>(() => position?.current?.range ?? { start: 0, end: Math.min(count, PRIME), padTop: 0, padBottom: 0 })
  const layout = useRef<Layout | null>(null)
  const saved = useRef(position?.current ?? null)
  const pending = useRef<{ top: number; range: VirtualRange } | null>(null)
  const placed = useRef<number | null>(null)
  const shown = useRef(range)
  const shownList = useRef(list)
  const latest = useRef({ entries, view })

  useLayoutEffect(() => {
    latest.current = { entries, view }
  }, [entries, view])

  useLayoutEffect(() => {
    shown.current = range
    const p = pending.current
    if (!p || !scroll.current || !sameRange(p.range, range)) return
    scroll.current.scrollTop = p.top
    placed.current = scroll.current.scrollTop
    pending.current = null
  }, [range, scroll])

  const measure = useCallback(() => {
    const scrollEl = scroll.current
    const gridEl = grid.current
    if (!scrollEl || !gridEl) return
    const { entries, view } = latest.current
    const count = entries.length
    const kids = gridEl.children
    if (count === 0 || kids.length === 0) {
      layout.current = null
      saved.current = null
      pending.current = null
      placed.current = null
      if (position) position.current = null
      setRange((r) => (r.start === 0 && r.end === Math.min(count, PRIME) && r.padTop === 0 && r.padBottom === 0 ? r : { start: 0, end: Math.min(count, PRIME), padTop: 0, padBottom: 0 }))
      return
    }
    const style = getComputedStyle(gridEl)
    const cols = style.gridTemplateColumns === 'none' ? 1 : style.gridTemplateColumns.split(' ').length
    const measured = style.gridTemplateRows.split(' ').reduce((max, track) => Math.max(max, parseFloat(track) || 0), 0) + (parseFloat(style.rowGap) || 0)
    if (!(measured > 0)) return
    const top = gridEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
    const prev = layout.current
    const shape = `${cols} ${style.width} ${view}`
    const stride = prev?.shape === shape && prev.entries === entries ? Math.max(prev.stride, measured) : measured
    layout.current = { cols, stride, top, shape, entries }
    let scrollTop = pending.current?.top ?? scrollEl.scrollTop
    const at = saved.current
    const restore = at !== null && (!prev || prev.shape !== shape)
    const held = restore || pending.current !== null || (placed.current !== null && Math.abs(scrollTop - placed.current) < 1)
    if (!held) placed.current = null
    if (restore) scrollTop = at.anchor ? top + (Math.floor(at.anchor.index / cols) + at.anchor.offset) * stride : at.top
    const viewTop = scrollTop - top
    const next = rowRange(count, cols, stride, viewTop, scrollEl.clientHeight)
    const row = Math.min(Math.floor(viewTop / stride), Math.ceil(count / cols) - 1)
    const anchor = held && at?.anchor ? at.anchor : viewTop < 0 ? null : { index: row * cols, offset: viewTop / stride - row }
    saved.current = { top: scrollTop, anchor, range: next }
    if (position) position.current = saved.current
    if (restore || pending.current) {
      if (sameRange(shown.current, next)) {
        scrollEl.scrollTop = scrollTop
        placed.current = scrollEl.scrollTop
        pending.current = null
      } else pending.current = { top: scrollTop, range: next }
    }
    setRange((r) => (sameRange(r, next) ? r : next))
  }, [scroll, grid, position])

  useLayoutEffect(() => {
    if (shownList.current === list) return
    shownList.current = list
    saved.current = null
    pending.current = null
    placed.current = null
    if (position) position.current = null
    if (scroll.current) scroll.current.scrollTop = 0
    measure()
  }, [list, scroll, position, measure])

  useLayoutEffect(() => {
    const scrollEl = scroll.current
    const gridEl = grid.current
    measure()
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
  }, [measure, view, count])

  const scrollToIndex = useCallback(
    (index: number) => {
      const scrollEl = scroll.current
      const l = layout.current
      if (!scrollEl || !l) return
      saved.current = null
      placed.current = null
      const row = Math.floor(index / l.cols)
      pending.current = { top: Math.max(0, l.top + row * l.stride - (scrollEl.clientHeight - l.stride) / 2), range: shown.current }
      measure()
    },
    [scroll, measure],
  )

  return { range, scrollToIndex }
}
