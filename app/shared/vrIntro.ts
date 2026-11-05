import { ease, portalStepDeg, type Keyframe } from './portals'

export const VR_INTRO = {
  height: 0.34,
  distance: 2,
  drop: 0.15,
  approach: 0.15,
  back: 0.15,
  ms: {
    headIn: [100, 350], draw: [300, 1350], headOut: [1350, 1650], cap: [1300, 1600],
    glowUp: [1200, 1500], glowDown: [1500, 2000], settle: 1750, leave: [1800, 2150],
    buzz: 1550,
    hold: 1750, holdMax: 4000,
    shelf: 2000,
    stagger: 60, portal: 450,
    label: [150, 500], chrome: [350, 700],
    end: 2800,
    skip: 250,
  },
  glow: { from: 0.45, peak: 1, rest: 0.3 },
  settle: 0.05,
} as const

type Span = readonly [number, number]
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const at = (ms: number, [a, b]: Span) => clamp01((ms - a) / (b - a))
const lerp = (a: number, b: number, k: number) => a + (b - a) * k

export interface IntroLogo {
  draw: number
  head: number
  cap: number
  glow: number
  opacity: number
  distance: number
}

export function introLogo(ms: number): IntroLogo {
  const m = VR_INTRO.ms
  const leave = ease('inOut', at(ms, m.leave))
  const glow = ms < m.glowDown[0]
    ? lerp(VR_INTRO.glow.from, VR_INTRO.glow.peak, at(ms, m.glowUp))
    : lerp(VR_INTRO.glow.peak, VR_INTRO.glow.rest, ease('out', at(ms, m.glowDown)))
  return {
    draw: ease('inOut', at(ms, m.draw)),
    head: at(ms, m.headIn) * (1 - at(ms, m.headOut)),
    cap: ease('out', at(ms, m.cap)),
    glow,
    opacity: 1 - leave,
    distance: VR_INTRO.distance + VR_INTRO.approach * (1 - ease('out', at(ms, [0, m.settle]))) + VR_INTRO.back * leave,
  }
}

export const introRank = (azDeg: number, row: number) => Math.max(0, Math.abs(azDeg) / portalStepDeg - 0.5) + 0.5 * row

export function introEnter(shelfAt: number, rank: number, quick: boolean): Keyframe {
  const m = VR_INTRO.ms
  return quick
    ? { from: 0, to: 1, startMs: shelfAt, durationMs: m.skip, ease: 'out' }
    : { from: 0, to: 1, startMs: shelfAt + rank * m.stagger, durationMs: m.portal, ease: 'out' }
}

export function introLabel(nowMs: number, shelfAt: number, rank: number, quick: boolean): number {
  if (quick) return at(nowMs, [shelfAt, shelfAt + VR_INTRO.ms.skip])
  const start = shelfAt + rank * VR_INTRO.ms.stagger
  return at(nowMs, [start + VR_INTRO.ms.label[0], start + VR_INTRO.ms.label[1]])
}

export function introChrome(nowMs: number, shelfAt: number, quick: boolean): number {
  const [a, b] = quick ? [0, VR_INTRO.ms.skip] : VR_INTRO.ms.chrome
  return at(nowMs, [shelfAt + a, shelfAt + b])
}

export interface IntroClock {
  ms: number
  heldMs: number
  skipMs: number | null
}

export const INTRO_START: IntroClock = { ms: 0, heldMs: 0, skipMs: null }

export function introStep(c: IntroClock, dt: number, ready: boolean): IntroClock {
  if (c.skipMs != null) return { ...c, skipMs: c.skipMs + dt }
  const m = VR_INTRO.ms
  const next = c.ms + dt
  if (!ready && next >= m.hold && c.heldMs < m.holdMax) return { ...c, ms: m.hold, heldMs: c.heldMs + next - Math.max(c.ms, m.hold) }
  return { ...c, ms: Math.min(m.end, next) }
}

export const introSkip = (c: IntroClock): IntroClock => (c.skipMs == null && !introDone(c) ? { ...c, skipMs: 0 } : c)

export const introSkipped = (c: IntroClock) => (c.skipMs == null ? 0 : ease('out', clamp01(c.skipMs / VR_INTRO.ms.skip)))

export const introShelfDue = (c: IntroClock) => c.ms >= VR_INTRO.ms.shelf || c.skipMs != null

export const introDone = (c: IntroClock) => c.ms >= VR_INTRO.ms.end || (c.skipMs != null && c.skipMs >= VR_INTRO.ms.skip)

export const introBuzzes = (before: IntroClock, after: IntroClock) => after.skipMs == null && before.ms < VR_INTRO.ms.buzz && after.ms >= VR_INTRO.ms.buzz

export const INTRO_BOX = (() => {
  const centre = [63, 55.5] as const
  const glyphHeight = 115
  const [w, h] = [188, 201]
  const scale = 4
  return { x: centre[0] - w / 2, y: centre[1] - h / 2, w, h, scale, width: w * scale, height: h * scale, metres: (w * VR_INTRO.height) / glyphHeight }
})()

export const MARK_STROKE = 'M49 28L104 60Q111 64 104 68L38 106Q26 113 26 99V10.291831'
export const MARK_CAP = 'M15 0.708109A3 3 0 0 1 19.508681 -1.884936L37 8.291831V11.291831H15Z'
export const MARK_WIDTH = 22
export const MARK_CAP_PIVOT = [26, 5] as const
