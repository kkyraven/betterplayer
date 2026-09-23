import type { HeroFlourish } from '@shared/tracking'

const POINTS: Record<HeroFlourish, string> = {
  none: '0,17 15,3 30,17 48,8',
  hold: '0,17 15,3 30,17 38,17 48,10',
  vibrate: '0,17 15,3 30,17 32,13 34,17 36,13 38,17 40,13 42,17 48,12',
  double: '0,17 8,3 15,17 23,3 30,17 48,8',
  triple: '0,17 5,3 10,17 15,3 20,17 25,3 30,17 48,8',
  slam: '0,17 10,3 24,3 30,17 48,8',
  bounce: '0,17 15,3 30,17 35,10 40,17 48,10',
  rise: '0,3 15,17 30,3 48,12',
  whip: '0,17 15,3 30,17 34,20 40,17 48,10',
  shake: '0,17 15,3 30,17 34,1 38,19 42,1 46,17 48,14',
  grind: '0,17 15,3 30,17 33,12 36,17 39,12 42,17 45,12 48,17',
}

function curve(points: string, s: number) {
  const P = points.split(' ').map((t) => t.split(',').map(Number) as [number, number])
  let d = `M${P[0]![0]},${P[0]![1]}`
  for (let i = 1; i < P.length - 1; i++) {
    const [a, b, c] = [P[i - 1]!, P[i]!, P[i + 1]!]
    const inX = b[0] - (s * (b[0] - a[0])) / 2
    const inY = b[1] - (s * (b[1] - a[1])) / 2
    const outX = b[0] + (s * (c[0] - b[0])) / 2
    const outY = b[1] + (s * (c[1] - b[1])) / 2
    d += ` L${inX},${inY} Q${b[0]},${b[1]} ${outX},${outY}`
  }
  const l = P[P.length - 1]!
  return `${d} L${l[0]},${l[1]}`
}

export function FlourishGlyph({ flourish, smooth = 0, width = 32 }: { flourish: HeroFlourish; smooth?: number; width?: number }) {
  return (
    <svg className="glyph" viewBox="0 0 48 20" width={width} height={Math.round((width * 20) / 48)} fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="30" y1="0" x2="30" y2="20" stroke="currentColor" strokeOpacity=".25" strokeWidth="1" />
      <path d={curve(POINTS[flourish], smooth)} stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}
