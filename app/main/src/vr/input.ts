import type { VrOverlayEvent } from 'bp-engine'
import type { MouseInputEvent, MouseWheelInputEvent } from 'electron'

type Button = 'left' | 'right' | 'middle'

const BUTTONS: Record<number, Button> = { 1: 'left', 2: 'right', 4: 'middle' }
const HELD: Record<Button, 'leftbuttondown' | 'rightbuttondown' | 'middlebuttondown'> = { left: 'leftbuttondown', right: 'rightbuttondown', middle: 'middlebuttondown' }

export const SCROLL_PX = 100

export const JITTER_TEXELS = 6

export class PanelPointer {
  private x = 0
  private y = 0
  private held: Button | null = null
  private usedAt: { x: number; y: number } | null = null
  private width = 0
  private height = 0
  private scale = 1

  constructor(width: number, height: number, texels = width) {
    this.fit(width, height, texels)
  }

  fit(width: number, height: number, texels: number) {
    this.width = width
    this.height = height
    this.scale = width / texels
  }

  used(e: VrOverlayEvent): boolean {
    if (e.kind === 'scroll') return true
    if (e.kind === 'leave') this.usedAt = null
    if (e.kind !== 'move' && e.kind !== 'down' && e.kind !== 'up') return false
    const last = this.usedAt
    if (e.kind === 'move' && last && Math.hypot(e.x - last.x, e.y - last.y) <= JITTER_TEXELS) return false
    this.usedAt = { x: e.x, y: e.y }
    return true
  }

  get holding(): boolean {
    return this.held !== null
  }

  release(): MouseInputEvent[] {
    const { x, y, held } = this
    this.held = null
    this.usedAt = null
    const leave: MouseInputEvent = { type: 'mouseLeave', x, y }
    return held ? [{ type: 'mouseUp', x, y, button: held, clickCount: 1 }, leave] : [leave]
  }

  input(e: VrOverlayEvent): MouseInputEvent | MouseWheelInputEvent | null {
    if (e.kind === 'scroll') return { type: 'mouseWheel', x: this.x, y: this.y, deltaX: e.dx ? -e.dx * SCROLL_PX : 0, deltaY: e.dy * SCROLL_PX, canScroll: true }
    if (e.kind === 'leave') return { type: 'mouseLeave', x: this.x, y: this.y }
    if (e.kind !== 'move' && e.kind !== 'down' && e.kind !== 'up') return null
    this.x = Math.min(this.width - 1, Math.max(0, Math.round(e.x * this.scale)))
    this.y = Math.min(this.height - 1, Math.max(0, Math.round(e.y * this.scale)))
    const { x, y } = this
    if (e.kind === 'move') return { type: 'mouseMove', x, y, ...(this.held ? { modifiers: [HELD[this.held]] } : {}) }
    const button = BUTTONS[e.button] ?? 'left'
    this.held = e.kind === 'down' ? button : null
    return { type: e.kind === 'down' ? 'mouseDown' : 'mouseUp', x, y, button, clickCount: 1 }
  }
}
