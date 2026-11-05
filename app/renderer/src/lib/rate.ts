export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export const RATE_MIN = 0.25
export const RATE_MAX = 3
export const RATE_STEP = 0.1
export const RATE_GRID_MIN = 0.2

export function stepRate(rate: number, dir: -1 | 1): number {
  const tenths = rate * 10
  const stop = dir > 0 ? Math.floor(tenths + 0.001) + 1 : Math.ceil(tenths - 0.001) - 1
  return Math.max(RATE_MIN, Math.min(RATE_MAX, stop / 10))
}
