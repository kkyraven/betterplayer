const FOCUSABLE = 'button:not(:disabled), [tabindex="0"], input:not(:disabled), select:not(:disabled), a[href]'

type Dir = 'left' | 'right' | 'up' | 'down'

const KEY_DIRS: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

function centre(r: DOMRect) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

export function nextInDirection(from: Element, candidates: Element[], dir: Dir): Element | null {
  const a = from.getBoundingClientRect()
  const ac = centre(a)
  let best: Element | null = null
  let bestScore = Infinity
  for (const el of candidates) {
    if (el === from) continue
    const b = el.getBoundingClientRect()
    if (b.width === 0 && b.height === 0) continue
    const bc = centre(b)
    const dx = bc.x - ac.x
    const dy = bc.y - ac.y
    const forward = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy
    if (forward < 4) continue
    const sideways = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx)
    const overlaps = dir === 'left' || dir === 'right' ? b.bottom > a.top && b.top < a.bottom : b.right > a.left && b.left < a.right
    const score = forward + sideways * (overlaps ? 0.5 : 3)
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  return best
}

export function navScope(container: HTMLElement): HTMLElement {
  const traps = container.querySelectorAll<HTMLElement>('[data-nav-trap]')
  return traps[traps.length - 1] ?? container
}

export function focusFirst(container: HTMLElement) {
  const scope = navScope(container)
  const active = document.activeElement
  const main = scope.querySelector<HTMLElement>(`[data-nav-main] :is(${FOCUSABLE})`)
  if (scope.contains(active) && (!main || active?.closest('[data-nav-main]'))) return
  const first = scope.querySelector<HTMLElement>('[data-nav-first]') ?? main ?? scope.querySelector<HTMLElement>(FOCUSABLE)
  first?.focus({ preventScroll: false })
}

function focusKey(el: Element, all: Element[]): string {
  const id = el.getAttribute('data-media-id')
  if (id) return `media:${id}`
  const key = el.getAttribute('data-focus-key')
  if (key) return `key:${key}`
  return `index:${all.indexOf(el)}`
}

const remembered = new Map<string, string>()

export function rememberFocus(name: string, container: HTMLElement) {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !container.contains(active) || active.closest('[data-nav-trap]')) return
  remembered.set(name, focusKey(active, Array.from(container.querySelectorAll(FOCUSABLE))))
}

export function restoreFocus(name: string, container: HTMLElement) {
  const key = remembered.get(name)
  if (key) {
    const all = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    const target = key.startsWith('media:')
      ? container.querySelector<HTMLElement>(`[data-media-id="${key.slice(6)}"]`)
      : key.startsWith('key:')
        ? container.querySelector<HTMLElement>(`[data-focus-key="${key.slice(4)}"]`)
        : all[Number(key.slice(6))]
    if (target) {
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      return
    }
  }
  focusFirst(container)
}

const READY_TIMEOUT_MS = 3000
const READY_RETRY_MS = 400

export function restoreFocusWhenReady(name: string, container: HTMLElement): () => void {
  const settled = () => {
    const main = container.querySelector('[data-nav-main]')
    return !main || main.contains(document.activeElement)
  }
  const attempt = () => {
    restoreFocus(name, container)
    if (settled()) stop()
  }
  const observer = new MutationObserver(attempt)
  const stop = () => {
    observer.disconnect()
    window.clearInterval(retry)
    window.clearTimeout(timer)
    window.removeEventListener('focus', attempt)
  }
  const retry = window.setInterval(attempt, READY_RETRY_MS)
  const timer = window.setTimeout(stop, READY_TIMEOUT_MS)
  observer.observe(container, { childList: true, subtree: true })
  window.addEventListener('focus', attempt)
  attempt()
  return stop
}

export function installSpatialNav(container: HTMLElement): () => void {
  const onKey = (e: KeyboardEvent) => {
    const dir = KEY_DIRS[e.key]
    if (!dir || e.metaKey || e.ctrlKey || e.altKey) return
    const scope = navScope(container)
    const active = document.activeElement
    if (active instanceof HTMLInputElement && (dir === 'left' || dir === 'right')) return
    if (active instanceof HTMLElement && active.dataset.navHorizontal !== undefined && (dir === 'left' || dir === 'right')) return
    if (!(active instanceof HTMLElement) || !scope.contains(active)) {
      e.preventDefault()
      focusFirst(container)
      return
    }
    const candidates = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE))
    const next = nextInDirection(active, candidates, dir)
    if (next instanceof HTMLElement) {
      e.preventDefault()
      next.focus()
      next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
