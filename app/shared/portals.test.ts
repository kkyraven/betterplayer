import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  VR_PORTAL, PORTAL_SIZE, RETURN_SIZE, bandDirection, bandLayout, bandTexel, chipText, chipsQuery, columnAz, diveElDeg, diveFrame,
  ease, edgeDeg, edgeFade, elapsed, fadeInDeg, fadeOutDeg, keyframeAt, portalAngles, portalHit, portalPose, portalStepDeg,
  readPortalHeaders, portalPath, resultCell, retarget, returnAz, reverse, scrollMax, shelfRows, startTransition, stillUv, textChips,
  turnedAngles, worldTurn, type Chip, type DiveSpec, type Keyframe, type PortalSize, type Transition, type Vec3,
} from './portals'

const DEG = Math.PI / 180
const FIXTURE = fileURLToPath(new URL('./portals.fixture.json', import.meta.url))
const dir = (azDeg: number, elDeg: number): Vec3 => [Math.cos(elDeg * DEG) * Math.sin(azDeg * DEG), Math.sin(elDeg * DEG), -Math.cos(elDeg * DEG) * Math.cos(azDeg * DEG)]
const sizes: Record<'portal' | 'return', PortalSize> = { portal: PORTAL_SIZE, return: RETURN_SIZE }

const kf = (from: number, to: number, startMs: number, durationMs: number, e: Keyframe['ease']): Keyframe => ({ from, to, startMs, durationMs, ease: e })
const keyframeCases = [
  [kf(0, 1, 1000, 200, 'linear'), 900], [kf(0, 1, 1000, 200, 'linear'), 1050], [kf(0, 1, 1000, 200, 'linear'), 1300],
  [kf(0, 1, 1000, 200, 'out'), 1050], [kf(0, 1, 1000, 200, 'out'), 1100], [kf(1, 0, 1000, 200, 'out'), 1150],
  [kf(0, 16.2, 0, 240, 'inOut'), 60], [kf(0, 16.2, 0, 240, 'inOut'), 120], [kf(0, 16.2, 0, 240, 'inOut'), 200],
  [kf(0.4, 0.4, 0, 0, 'linear'), 5], [kf(3, 7, 50, 0, 'out'), 0], [kf(-2, 2, 10, 100, 'inOut'), 110],
] as const
const keyframes = () => keyframeCases.map(([k, nowMs]) => ({ keyframe: k, nowMs, value: keyframeAt(k, nowMs), retargeted: retarget(k, 0.5, nowMs, 200) }))

const bandSamples = (name: 'rows' | 'strip') => {
  const b = VR_PORTAL.bands[name]
  const els = name === 'rows' ? [VR_PORTAL.el.label1, VR_PORTAL.el.row1, VR_PORTAL.el.row2, -18] : [VR_PORTAL.el.strip, VR_PORTAL.el.hint, -22]
  return [-30, -12, 0, 7.5, 31].flatMap((az) => els.map((el) => { const [x, y] = bandTexel(b, az, el); return { az, el, x, y } }))
}
const bands = () => (['rows', 'strip'] as const).map((band) => ({ band, spec: VR_PORTAL.bands[band], layout: bandLayout(VR_PORTAL.bands[band]), texels: bandSamples(band) }))

const poseCases = [
  [0, 2.5, 0, 'portal', 0], [columnAz(0), VR_PORTAL.el.row1, 1, 'portal', 0], [columnAz(3), VR_PORTAL.el.row2, 0.5, 'portal', 0],
  [-8.1, -13.7, 0, 'portal', 0.15], [20, 10.4, 1, 'return', 0], [12, -20, 0.25, 'portal', 0.05],
] as const
const poses = () => poseCases.map(([az, el, h, size, dz]) => ({ az, el, h, size, dz, pose: portalPose(az, el, h, sizes[size], dz) }))

const R = VR_PORTAL.radius, P = VR_PORTAL.portal
const halfArc = (m: number, r: number = R) => m / r / DEG
const hitCases: { name: string; az: number; el: number; h: number; size: 'portal' | 'return'; o: Vec3; v: Vec3 }[] = [
  { name: 'centre', az: 0, el: 2.5, h: 0, size: 'portal', o: [0, 0, 0], v: dir(0, 2.5) },
  { name: 'inside right edge', az: 0, el: 2.5, h: 0, size: 'portal', o: [0, 0, 0], v: dir(halfArc(P.w / 2 - 0.002), 2.5) },
  { name: 'past right edge', az: 0, el: 2.5, h: 0, size: 'portal', o: [0, 0, 0], v: dir(halfArc(P.w / 2 + 0.002), 2.5) },
  { name: 'inside top edge', az: 8.1, el: -13.7, h: 0, size: 'portal', o: [0, 0, 0], v: dir(8.1, -13.7 + halfArc(P.h / 2 - 0.002, R / Math.cos(13.7 * DEG))) },
  { name: 'corner cut', az: 0, el: 2.5, h: 0, size: 'portal', o: [0, 0, 0], v: dir(halfArc(P.w / 2 - 0.1 * P.corner), 2.5 + halfArc(P.h / 2 - 0.1 * P.corner, R / Math.cos(2.5 * DEG))) },
  { name: 'inside corner', az: 0, el: 2.5, h: 0, size: 'portal', o: [0, 0, 0], v: dir(halfArc(P.w / 2 - 0.3 * P.corner), 2.5 + halfArc(P.h / 2 - 0.3 * P.corner, R / Math.cos(2.5 * DEG))) },
  { name: 'lifted grows 12.5%', az: -24.35, el: 2.5, h: 1, size: 'portal', o: [0, 0, 0], v: dir(-24.35 + 1.12 * halfArc(P.w / 2), 2.5) },
  { name: 'rest misses there', az: -24.35, el: 2.5, h: 0, size: 'portal', o: [0, 0, 0], v: dir(-24.35 + 1.12 * halfArc(P.w / 2), 2.5) },
  { name: 'between columns', az: columnAz(1), el: 2.5, h: 0, size: 'portal', o: [0, 0, 0], v: dir((columnAz(1) + columnAz(2)) / 2, 2.5) },
  { name: 'eye offset', az: 8.1, el: 2.5, h: 0, size: 'portal', o: [0.032, 0.01, -0.02], v: dir(8.6, 2.2) },
  { name: 'behind', az: 0, el: 2.5, h: 0, size: 'portal', o: [0, 0, 0], v: dir(180, -2.5) },
  { name: 'return picture', az: 26, el: 10.4, h: 1, size: 'return', o: [0, 0, 0], v: dir(26.5, 10.6) },
]
const hits = () => hitCases.map((c) => ({ ...c, pose: portalPose(c.az, c.el, c.h, sizes[c.size]), hit: portalHit(c.o, c.v, portalPose(c.az, c.el, c.h, sizes[c.size]), sizes[c.size]) }))

const layout = () => ({
  columnAz: [0, 1, 2, 3, 5].map((i) => ({ i, az: columnAz(i) })),
  resultCell: [[0, 3], [2, 3], [0, 9], [1, 9], [5, 9], [8, 9]].map(([i, n]) => ({ i, count: n, cell: resultCell(i!, n!) })),
  scrollMax: [0, 3, 4, 9, 24].map((columns) => ({ columns, deg: scrollMax(columns) })),
  edgeFade: [0, 20, fadeInDeg, 30, 35, fadeOutDeg, 45, -30].map((az) => ({ az, k: edgeFade(az) })),
  returnAz: [0.1, 0.19].map((labelW) => ({ labelW, az: returnAz(labelW) })),
  turns: [[0, 2.5, dir(0, 2.5)], [-24.35, -13.7, dir(-20, -10)], [16.2, 2.5, dir(16.2, -1.909)], [8, 0, dir(0, 0)]].map(([az, el, v]) => {
    const turn = worldTurn(az as number, el as number)
    const angles = turnedAngles(v as Vec3, turn)
    return { az, el, v, turn, angles, uv: stillUv(angles[0], angles[1], 36 * DEG, 27 * DEG) }
  }),
  portalAngles: [portalAngles(0, -0.05 * 1.4 / R, 1.4, 1.05, PORTAL_SIZE), portalAngles(20 * DEG, 0.27, R, 1, RETURN_SIZE)],
})

const yAt = (el: number, r: number = R) => r * Math.tan(el * DEG)
const fromOf = (az: number, el: number, h: number, same: boolean) => {
  const r = R - P.lift * h, s = 1 + P.grow * h
  return same ? portalAngles(az * DEG, yAt(el, r), r, s, PORTAL_SIZE) : portalAngles(0, (VR_PORTAL.diveDrop * r) / R, r, s, PORTAL_SIZE)
}
const slideSpec: DiveSpec = {
  kind: 'vr', startMs: 10_000, slideMs: 160 + 4 * Math.hypot(-8.1, -13.7 - diveElDeg), same: false, full: 180, from: fromOf(-8.1, -13.7, 1, false),
  slideFrom: { az: -8.1, y: yAt(-13.7, R - P.lift), r: R - P.lift, s: 1 + P.grow, h: 1 },
}
const noSlideSpec: DiveSpec = { kind: 'vr', startMs: 0, slideMs: 0, same: false, full: 360, from: fromOf(0, diveElDeg, 1, false) }
const sameSpec: DiveSpec = { kind: 'vr', startMs: 0, slideMs: 0, same: true, full: 180, from: fromOf(24.35, 2.5, 0, true) }
const backSpec: DiveSpec = { kind: 'back', startMs: 0, slideMs: 0, same: true, full: 180, from: fromOf(-8.1, -13.7, 0, true) }
const tile = { a: 8.1, y: yAt(2.5, R - P.lift), r: R - P.lift, w: P.w * 1.05, h: P.h * 1.05, crop: 1.6 / (16 / 9), bend: 1 / Math.hypot(R - P.lift, yAt(2.5, R - P.lift)), tilt: Math.atan2(yAt(2.5, R - P.lift), R - P.lift), rad: P.corner * 1.05 }
const screen = { a: 0, y: 0, r: 3, w: 3 * 50 * DEG, h: (3 * 50 * DEG * 9) / 16, crop: 1, bend: 1 / 3, tilt: 0, rad: 0.03 }
const flatSpec: DiveSpec = { kind: 'flat', startMs: 0, slideMs: 0, same: false, full: 180, from: fromOf(8.1, 2.5, 1, true), tile, screen }
const flatBackSpec: DiveSpec = { ...flatSpec, kind: 'flatBack', same: true, tile: { ...tile, r: R, y: yAt(2.5), w: P.w, h: P.h, rad: P.corner } }

type DiveCase = { name: string; t: Transition; nowMs: number; dim: number }
const live = (t: Transition, liveAtMs: number): Transition => ({ ...t, liveAtMs })
const end = slideSpec.slideMs + VR_PORTAL.ms.grow
const diveCases = (): DiveCase[] => {
  const s = startTransition(slideSpec), at = (e: number) => slideSpec.startMs + e
  return [
    { name: 'dive start', t: s, nowMs: at(0), dim: 0.32 },
    { name: 'mid slide', t: s, nowMs: at(slideSpec.slideMs / 2), dim: 0.32 },
    { name: 'grow 25%', t: s, nowMs: at(slideSpec.slideMs + 125), dim: 0.32 },
    { name: 'grow end, no live yet', t: s, nowMs: at(end), dim: 0.32 },
    { name: 'live early: mid crossfade', t: live(s, at(100)), nowMs: at(end + 60 + 150), dim: 0.32 },
    { name: 'live early: done', t: live(s, at(100)), nowMs: at(end + 60 + 300), dim: 0.32 },
    { name: 'slow: grace', t: s, nowMs: at(end + 250), dim: 0.32 },
    { name: 'slow: loading shown', t: s, nowMs: at(end + 500), dim: 0.32 },
    { name: 'slow: live arrives', t: live(s, at(end + 900)), nowMs: at(end + 1000), dim: 0.32 },
    { name: 'reversed in slow wait', t: reverse(s, at(end + 1000), false), nowMs: at(end + 1000), dim: 0.32 },
    { name: 'reversed: no second flash', t: reverse(s, at(300), true), nowMs: at(590), dim: 0.32 },
    { name: 'reversed: undone', t: reverse(s, at(300), true), nowMs: at(700), dim: 0.32 },
    { name: 'held', t: { ...live(s, at(100)), held: true }, nowMs: at(end + 400), dim: 0.32 },
    { name: 'no slide 360 fade', t: startTransition(noSlideSpec), nowMs: 60, dim: 1 },
    { name: 'same: start', t: startTransition(sameSpec), nowMs: 0, dim: 0.32 },
    { name: 'same: mid', t: startTransition(sameSpec), nowMs: 300, dim: 0.32 },
    { name: 'same: done', t: startTransition(sameSpec), nowMs: 500, dim: 0.32 },
    { name: 'back start', t: startTransition(backSpec), nowMs: 0, dim: 0.32 },
    { name: 'back mid', t: startTransition(backSpec), nowMs: 250, dim: 0.32 },
    { name: 'back end', t: startTransition(backSpec), nowMs: 500, dim: 0.32 },
    { name: 'flat mid', t: startTransition(flatSpec), nowMs: 250, dim: 0.32 },
    { name: 'flat waiting', t: startTransition(flatSpec), nowMs: 800, dim: 0.32 },
    { name: 'flatBack mid', t: startTransition(flatBackSpec), nowMs: 250, dim: 0.32 },
    { name: 'flatBack end', t: startTransition(flatBackSpec), nowMs: 500, dim: 0.32 },
  ]
}
const dives = () => diveCases().map((c) => ({ ...c, frame: diveFrame(c.t, c.nowMs, c.dim) }))

const TAGS = ['Rain', 'Night', 'Sunset Balcony', 'pov', 'Point of View', 'Golden  Hour']
const chipCases = [
  'vr with rain tag under 20 minutes', 'rain room in 2d', 'fastest', 'show me sunset balcony tag', 'Over 10 min FAVORITES pov tag',
  'under 5 coast', '', 'a:b -x OR say "hi"', 'point of view tag in vr', 'golden hour tag',
]
const chips = () => chipCases.map((text) => {
  const c = textChips(text, TAGS)
  return { text, tags: TAGS, chips: c, chipText: chipText(c), query: chipsQuery(c) }
})

const r = (...ids: number[]) => ids.map((id) => ({ id }))
const rowCases = [
  { name: 'dedupe', continueRows: r(1, 2), vrRows: r(5), recommended: r(2, 3, 4), playing: null },
  { name: 'playing moved first', continueRows: r(1, 2, 3), vrRows: [], recommended: r(3, 4), playing: { id: 3 } },
  { name: 'playing prepended', continueRows: r(1, 2), vrRows: [], recommended: r(9, 4), playing: { id: 9 } },
  { name: 'empty continue gives VR', continueRows: [], vrRows: r(5, 6), recommended: r(6, 7), playing: null },
  { name: 'empty continue while playing', continueRows: [], vrRows: r(5), recommended: r(8, 5), playing: { id: 8 } },
]
const rows = () => rowCases.map(({ name, ...input }) => ({ name, input, output: shelfRows(input) }))

const fixture = () => ({
  constants: VR_PORTAL,
  derived: { stepDeg: portalStepDeg, edgeDeg, fadeInDeg, fadeOutDeg, diveElDeg },
  keyframes: keyframes(), bands: bands(), poses: poses(), hits: hits(), layout: layout(), dives: dives(), chips: chips(), rows: rows(),
})

function expectClose(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Math.abs(actual - expected) > 1e-9 * Math.max(1, Math.abs(expected))) expect.fail(`${path}: ${actual} != ${expected}`)
    return
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) expect.fail(`${path}: length differs`)
    expected.forEach((e, i) => expectClose(actual[i], e, `${path}[${i}]`))
    return
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') expect.fail(`${path}: not an object`)
    const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>
    expect(Object.keys(a).sort(), path).toEqual(Object.keys(e).sort())
    for (const k of Object.keys(e)) expectClose(a[k], e[k], `${path}.${k}`)
    return
  }
  expect(actual, path).toEqual(expected)
}

describe('portals fixture', () => {
  it('matches portals.fixture.json (UPDATE_PORTAL_FIXTURE=1 rewrites it)', () => {
    const now = JSON.parse(JSON.stringify(fixture())) as unknown
    if (process.env.UPDATE_PORTAL_FIXTURE === '1') writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + '\n')
    expectClose(now, JSON.parse(readFileSync(FIXTURE, 'utf8')))
  })
})

describe('keyframes', () => {
  it('eases and clamps', () => {
    expect(ease('out', 0.5)).toBeCloseTo(0.875)
    expect(ease('inOut', 0.25)).toBeCloseTo(0.0625)
    expect(ease('linear', 2)).toBe(1)
    expect(keyframeAt(kf(0, 10, 100, 0, 'out'), 0)).toBe(10)
  })

  it('retargets from where it is, without a jump', () => {
    const k = kf(0, 1, 0, 200, 'out')
    const r2 = retarget(k, 0, 80, 200)
    expect(keyframeAt(r2, 80)).toBeCloseTo(keyframeAt(k, 80), 12)
    expect(keyframeAt(r2, 280)).toBe(0)
  })
})

describe('layout', () => {
  it('derives the mock numbers', () => {
    expect(portalStepDeg).toBeCloseTo(16.234, 3)
    expect(edgeDeg).toBeCloseTo(31.23, 2)
    expect(fadeInDeg).toBeCloseTo(25.35, 2)
    expect(fadeOutDeg).toBeCloseTo(38.58, 2)
    expect(diveElDeg).toBeCloseTo(-1.909, 3)
    expect(bandLayout(VR_PORTAL.bands.rows)).toMatchObject({ width: 2073, height: 1083, metres: 1.7275 })
    expect(bandLayout(VR_PORTAL.bands.strip)).toMatchObject({ width: 2073, height: 249 })
  })

  it('fills results down each column past four', () => {
    expect(resultCell(3, 4)).toEqual({ column: 3, row: 'row1' })
    expect([0, 1, 2, 3].map((i) => resultCell(i, 9))).toEqual([{ column: 0, row: 'row1' }, { column: 0, row: 'row2' }, { column: 1, row: 'row1' }, { column: 1, row: 'row2' }])
  })

  it('fades portals between fade in and fade out', () => {
    expect(edgeFade(columnAz(3))).toBe(1)
    expect(edgeFade(-fadeOutDeg - 1)).toBe(0)
    expect(edgeFade(32)).toBeGreaterThan(0)
    expect(edgeFade(32)).toBeLessThan(1)
  })
})

describe('bands', () => {
  it.each(['rows', 'strip'] as const)('round trips the %s band within 0.01 degrees', (name) => {
    const b = VR_PORTAL.bands[name]
    for (let i = 0; i < 9; i++) {
      for (let j = 0; j < 7; j++) {
        const az = -32 + (64 * i) / 8, el = b.fromDeg + ((b.toDeg - b.fromDeg) * j) / 6
        const [x, y] = bandTexel(b, az, el)
        const [az2, el2] = bandDirection(b, x, y)
        expect(Math.abs(az2 - az)).toBeLessThan(0.01)
        expect(Math.abs(el2 - el)).toBeLessThan(0.01)
      }
    }
  })

  it('puts the band centre at its middle texel and its edges on its rows', () => {
    const b = VR_PORTAL.bands.rows, { width, height } = bandLayout(b)
    expect(bandDirection(b, width, height / 2)[0]).toBeGreaterThan(b.halfArcDeg - 1)
    const [x, y] = bandTexel(b, 0, b.centreDeg)
    expect(x).toBeCloseTo(width / 2, 6)
    expect(y).toBeCloseTo(height / 2, 6)
    expect(bandTexel(b, 0, b.toDeg)[1]).toBeCloseTo(0, 0)
    expect(bandTexel(b, 0, b.fromDeg)[1]).toBeCloseTo(height, 0)
  })
})

describe('portalPose and portalHit', () => {
  const hit = (name: string) => hits().find((h) => h.name === name)!.hit

  it('hits the centre at the sphere distance', () => {
    const h = hit('centre')!
    expect(h.t).toBeCloseTo(R / Math.cos(2.5 * DEG), 9)
    expect(Math.abs(h.x) + Math.abs(h.y)).toBeLessThan(1e-9)
  })

  it('stops at the edges and the rounded corners', () => {
    expect(hit('inside right edge')).not.toBeNull()
    expect(hit('past right edge')).toBeNull()
    expect(hit('inside top edge')).not.toBeNull()
    expect(hit('corner cut')).toBeNull()
    expect(hit('inside corner')).not.toBeNull()
    expect(hit('between columns')).toBeNull()
    expect(hit('behind')).toBeNull()
  })

  it('grows a lifted portal 12.5% as seen', () => {
    const lifted = portalPose(0, 0, 1, PORTAL_SIZE), rest = portalPose(0, 0, 0, PORTAL_SIZE)
    expect((lifted.s / lifted.hr) / (rest.s / rest.hr)).toBeCloseTo(1.125, 9)
    expect(hit('lifted grows 12.5%')).not.toBeNull()
    expect(hit('rest misses there')).toBeNull()
  })

  it('turns a portal so its front faces out through it', () => {
    const [az, el] = turnedAngles(dir(-24.35, 2.5), worldTurn(-24.35, 2.5))
    expect(az).toBeCloseTo(0, 9)
    expect(el).toBeCloseTo(diveElDeg * DEG, 9)
    expect(stillUv(0, 0, 36 * DEG, 27 * DEG)).toEqual([0.5, 0.5])
    expect(stillUv(37 * DEG, 0, 36 * DEG, 27 * DEG)).toBeNull()
  })
})

describe('diveFrame', () => {
  const frame = (name: string) => dives().find((d) => d.name === name)!.frame
  const fullHw = 105 * DEG

  it('flashes at the press and slides straight ahead', () => {
    const f = frame('dive start')
    expect(f).toMatchObject({ flash: 1, libF: 1, sliding: true, aperture: null })
    expect(f.portal).toMatchObject({ az: -8.1, hover: 1, op: 1 })
    const mid = frame('mid slide')
    expect(mid.portal!.az).toBeCloseTo(-8.1 / 2, 9)
    expect(mid.portal!.hover).toBeCloseTo(0.5, 9)
  })

  it('grows the window in log size after the slide', () => {
    const f = frame('grow 25%'), k = 1 - 0.75 ** 1.6
    expect(f.sliding).toBe(false)
    expect(f.portal).toBeNull()
    expect(f.aperture!.hw).toBeCloseTo(slideSpec.from.hw * (fullHw / slideSpec.from.hw) ** k, 9)
    expect(frame('grow end, no live yet')).toMatchObject({ live: 0, loading: 0, done: false })
    expect(frame('grow end, no live yet').aperture!.hw).toBeCloseTo(fullHw, 9)
  })

  it('crossfades to live no sooner than 60 ms after the grow', () => {
    expect(frame('live early: mid crossfade').live).toBeCloseTo(0.5, 9)
    expect(frame('live early: done').done).toBe(true)
  })

  it('shows Loading only past the grace on a slow start', () => {
    expect(frame('slow: grace').loading).toBe(0)
    expect(frame('slow: loading shown').loading).toBeGreaterThan(0.99)
    expect(frame('slow: live arrives').loading).toBeLessThan(1)
    expect(frame('held')).toMatchObject({ live: 0, loading: 0, done: false })
  })

  it('reverses a slow wait from the end of the grow, and flashes once', () => {
    const t = reverse(startTransition(slideSpec), slideSpec.startMs + end + 1000, false)
    expect(elapsed(t, slideSpec.startMs + end + 1000)).toBe(end)
    expect(frame('reversed: no second flash').flash).toBe(0)
    expect(frame('reversed: no second flash').e).toBe(10)
    expect(frame('reversed: undone').undone).toBe(true)
  })

  it('fades the library fast with no slide and dims back in for the same video', () => {
    expect(frame('no slide 360 fade').libF).toBeCloseTo(1 - 0.5, 9)
    expect(frame('same: start')).toMatchObject({ live: 1, outA: 1, outB: 0.32 })
    expect(frame('same: done')).toMatchObject({ outB: 1, done: true })
  })

  it('runs back into the portal: library late, dim once the edge is in view', () => {
    expect(frame('back start')).toMatchObject({ libF: 0, outB: 1, flash: 0 })
    expect(frame('back start').aperture!.hw).toBeCloseTo(fullHw, 9)
    expect(frame('back end')).toMatchObject({ libF: 1, done: true })
    expect(frame('back end').outB).toBeCloseTo(0.32, 12)
    expect(frame('back end').portal!.op).toBe(1)
    expect(frame('back end').aperture!.hw).toBeCloseTo(backSpec.from.hw, 9)
  })

  it('moves a flat poster to the screen and back', () => {
    expect(frame('flat mid').tile!.r).toBeCloseTo(tile.r + (3 - tile.r) * 0.875, 9)
    expect(frame('flat waiting')).toMatchObject({ done: false, live: 0 })
    expect(frame('flatBack end').tile).toEqual(flatBackSpec.tile)
  })
})

describe('chips', () => {
  const ids = (cs: Chip[]) => cs.map((c) => [c.kind, c.label, c.n])

  it('reads typed text as chips', () => {
    expect(ids(textChips('vr with rain tag under 20 minutes', TAGS))).toEqual([['vr', 'VR', undefined], ['tag', 'Rain', undefined], ['under', 'Under 20 minutes', 20]])
    expect(ids(textChips('rain room in 2d', TAGS))).toEqual([['text', 'rain room', undefined], ['2d', '2D', undefined]])
    expect(ids(textChips('fastest', TAGS))).toEqual([['fastest', 'Fastest', undefined]])
    expect(textChips('show me sunset balcony tag', TAGS)).toEqual([{ id: 'k2', kind: 'tag', label: 'Sunset Balcony' }])
  })

  it('turns chips back into text that reads the same', () => {
    for (const text of chipCases) {
      const cs = textChips(text, TAGS)
      expect(textChips(chipText(cs), TAGS).map(({ kind, label, n }) => ({ kind, label, n }))).toEqual(cs.map(({ kind, label, n }) => ({ kind, label, n })))
    }
  })

  it('reads a tag of three or more words back from its chip', () => {
    const tag: Chip = { id: 't', kind: 'tag', label: 'Point of View' }
    expect(textChips(chipText([tag, { id: 'v', kind: 'vr', label: 'VR' }]), TAGS)).toEqual([{ id: 'k0', kind: 'tag', label: 'Point of View' }, { id: 'k4', kind: 'vr', label: 'VR' }])
  })

  it('matches a tag whose name has extra spaces', () => {
    expect(textChips('golden hour tag', TAGS)).toEqual([{ id: 'k0', kind: 'tag', label: 'Golden  Hour' }])
  })

  it.each([
    ['', { section: 'all', sort: 'recommended', filters: {} }],
    ['vr with rain tag under 20 minutes', { filters: { type: 'vr', tags: ['Rain'], maxDurationMs: 1_200_000 } }],
    ['rain room in 2d', { search: 'rain room', filters: { type: '2d' } }],
    ['Over 10 min FAVORITES pov tag', { section: 'favourites', search: 'duration:>10', filters: { tags: ['pov'] } }],
    ['fastest', { sort: 'speed', desc: true }],
    ['a:b -x OR say "hi"', { search: '"a:b" "-x" or say "\\"hi\\""' }],
  ])('queries %j', (text, want) => {
    expect(chipsQuery(textChips(text, TAGS))).toMatchObject({ desc: true, limit: VR_PORTAL.rows.results, offset: 0, ...want })
  })

  it('quotes words the search grammar reads as syntax', () => {
    expect(chipsQuery([{ id: 'x', kind: 'text', label: 'OR tag:x' }]).search).toBe('"OR" "tag:x"')
  })
})

describe('rows', () => {
  const out = (name: string) => rows().find((c) => c.name === name)!.output
  const idsOf = (rs: { id: number }[]) => rs.map((x) => x.id)

  it('puts the playing video first and keeps Recommended clear of the top row', () => {
    expect(idsOf(out('dedupe').bottomRows)).toEqual([3, 4])
    expect(idsOf(out('playing moved first').topRows)).toEqual([3, 1, 2])
    expect(idsOf(out('playing prepended').topRows)).toEqual([9, 1, 2])
    expect(idsOf(out('playing prepended').bottomRows)).toEqual([4])
  })

  it('shows VR on top only when nothing is continued or playing', () => {
    expect(out('empty continue gives VR')).toMatchObject({ top: 'vr', topRows: [{ id: 5 }, { id: 6 }], bottomRows: [{ id: 7 }] })
    expect(out('empty continue while playing')).toMatchObject({ top: 'continue', topRows: [{ id: 8 }], bottomRows: [{ id: 5 }] })
  })
})

describe('still headers', () => {
  it('builds paths and reads headers', () => {
    expect(portalPath(7, 1024, null)).toBe('portal/7?w=1024')
    expect(portalPath(7, 2048, 25_000.4)).toBe('portal/7?w=2048&ms=25000')
    const h: Record<string, string> = { 'X-Portal-Kind': 'equirect', 'X-Portal-Half': '36,27', 'X-Portal-Arc': '180', 'X-Portal-Ms': '20000.000', 'X-Portal-Censor': 'off' }
    expect(readPortalHeaders((n) => h[n] ?? null)).toEqual({ kind: 'equirect', halfDeg: [36, 27], arcDeg: 180, ms: 20000, censor: 'off' })
    expect(readPortalHeaders(() => null)).toBeNull()
  })
})
