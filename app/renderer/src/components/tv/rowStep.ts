export interface NumberRange {
  min: number
  max: number
  step: number
}

export function stepNumber(value: number, delta: number, range: NumberRange): number {
  const { min, max, step } = range
  const snapped = Math.round((value - min) / step) * step + min
  const next = snapped + delta * step
  const clamped = Math.max(min, Math.min(max, next))
  const digits = Math.max(0, -Math.floor(Math.log10(step)))
  return Number(clamped.toFixed(digits))
}

export function stepIndex(index: number, delta: number, count: number, wrap: boolean): number {
  if (count === 0) return 0
  const next = index + delta
  if (wrap) return ((next % count) + count) % count
  return Math.max(0, Math.min(count - 1, next))
}
