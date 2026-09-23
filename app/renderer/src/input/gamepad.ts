const REPEAT_MS = 220
const FIRST_REPEAT_MS = 400

export const TV_BUTTONS: Readonly<Record<number, string>> = {
  0: 'Enter',
  1: 'Escape',
  2: 'ContextMenu',
  3: ' ',
  4: '[',
  5: ']',
  9: 'ContextMenu',
  12: 'ArrowUp',
  13: 'ArrowDown',
  14: 'ArrowLeft',
  15: 'ArrowRight',
}

export const TV_DIRECT = { seekBack: 6, seekForward: 7, power: 8 } as const

export type PadKind = 'xbox' | 'playstation' | 'generic' | 'none'

export function padKind(id: string | null): PadKind {
  if (id === null) return 'none'
  if (/045e|xbox/i.test(id)) return 'xbox'
  if (/054c|dualsense|dualshock|playstation/i.test(id)) return 'playstation'
  return 'generic'
}

function press(key: string, repeat = false) {
  const target = document.activeElement ?? document.body
  const init = { key, bubbles: true, cancelable: true, repeat }
  const ok = target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  if (key === 'Enter' && ok && target instanceof HTMLElement && target.matches('button:not(:disabled), a[href]')) target.click()
}

const pads = () => navigator.getGamepads().filter((p): p is Gamepad => p !== null && p.connected)
const anyPad = () => pads().length > 0

let padId: string | null = null
const padListeners = new Set<() => void>()
function setPadId(next: string | null) {
  if (next === padId) return
  padId = next
  for (const fn of padListeners) fn()
}
if (typeof window !== 'undefined') {
  window.addEventListener('gamepadconnected', () => setPadId(pads()[0]?.id ?? null))
  window.addEventListener('gamepaddisconnected', () => setPadId(pads()[0]?.id ?? null))
}

export const padStore = {
  subscribe(fn: () => void) {
    padListeners.add(fn)
    return () => {
      padListeners.delete(fn)
    }
  },
  get: () => padId,
}

function whileConnected(poll: () => void): () => void {
  let handle = 0
  const tick = () => {
    poll()
    handle = anyPad() ? requestAnimationFrame(tick) : 0
  }
  const start = () => {
    if (handle === 0) handle = requestAnimationFrame(tick)
  }
  const stop = () => {
    if (anyPad()) return
    cancelAnimationFrame(handle)
    handle = 0
  }
  window.addEventListener('gamepadconnected', start)
  window.addEventListener('gamepaddisconnected', stop)
  if (anyPad()) start()
  return () => {
    window.removeEventListener('gamepadconnected', start)
    window.removeEventListener('gamepaddisconnected', stop)
    cancelAnimationFrame(handle)
    handle = 0
  }
}

export interface TvPadHandlers {
  seek: (seconds: number) => void
  power: () => void
}

export function installGamepad(handlers: TvPadHandlers): () => void {
  const held = new Map<string, number>()
  const down = new Set<number>()
  return whileConnected(() => {
    const now = performance.now()
    const pressed = new Set<string>()
    for (const pad of pads()) {
      pad.buttons.forEach((b, i) => {
        const key = TV_BUTTONS[i]
        if (key && b.pressed) pressed.add(key)
        if (i === TV_DIRECT.seekBack || i === TV_DIRECT.seekForward || i === TV_DIRECT.power) {
          if (b.pressed && !down.has(i)) {
            down.add(i)
            if (i === TV_DIRECT.power) handlers.power()
            else handlers.seek(i === TV_DIRECT.seekBack ? -30 : 30)
          } else if (!b.pressed) down.delete(i)
        }
      })
      const x = pad.axes[0] ?? 0
      const y = pad.axes[1] ?? 0
      if (x < -0.6) pressed.add('ArrowLeft')
      if (x > 0.6) pressed.add('ArrowRight')
      if (y < -0.6) pressed.add('ArrowUp')
      if (y > 0.6) pressed.add('ArrowDown')
    }
    for (const key of pressed) {
      const since = held.get(key)
      if (since === undefined) {
        held.set(key, now + FIRST_REPEAT_MS)
        press(key)
      } else if (key.startsWith('Arrow') && now >= since) {
        held.set(key, now + REPEAT_MS)
        press(key, true)
      }
    }
    for (const key of [...held.keys()]) if (!pressed.has(key)) held.delete(key)
  })
}

export function installGamepadActions(dispatch: (key: string) => boolean): () => void {
  const down = new Set<string>()
  return whileConnected(() => {
    for (const pad of pads()) {
      pad.buttons.forEach((b, i) => {
        const key = `pad:${i}`
        if (b.pressed && !down.has(key)) {
          down.add(key)
          dispatch(key)
        } else if (!b.pressed) down.delete(key)
      })
    }
  })
}
