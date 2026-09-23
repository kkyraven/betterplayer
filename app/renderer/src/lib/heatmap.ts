const STOPS: ReadonlyArray<[number, [number, number, number]]> = [
  [0, [59, 130, 246]],
  [0.35, [34, 197, 94]],
  [0.65, [234, 179, 8]],
  [1, [239, 68, 68]],
]

export const HEAT_MAX_SPEED = 500

export function heatColor(speed: number): string {
  if (speed <= 0) return 'rgba(255, 255, 255, 0.08)'
  const v = Math.min(1, speed / HEAT_MAX_SPEED)
  let a = STOPS[0]
  let b = STOPS[STOPS.length - 1]
  for (let i = 0; i < STOPS.length - 1; i++) {
    const lo = STOPS[i]
    const hi = STOPS[i + 1]
    if (lo && hi && v >= lo[0] && v <= hi[0]) {
      a = lo
      b = hi
    }
  }
  if (!a || !b) return 'rgba(255, 255, 255, 0.08)'
  const t = (v - a[0]) / (b[0] - a[0] || 1)
  const c = a[1].map((x, i) => Math.round(x + ((b[1][i] ?? x) - x) * t))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

export function heatGradient(buckets: readonly number[]): string | undefined {
  const n = buckets.length
  if (n === 0) return undefined
  const stops: string[] = []
  for (let i = 0; i < n; i++) {
    const speed = buckets[i] ?? 0
    stops.push(`${heatColor(speed)} ${((i / n) * 100).toFixed(2)}% ${(((i + 1) / n) * 100).toFixed(2)}%`)
  }
  return `linear-gradient(to right, ${stops.join(', ')})`
}
