const FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

export type ZoomStep = -1 | 0 | 1

export function zoomStep(input: Pick<Electron.Input, 'type' | 'key' | 'control' | 'meta' | 'alt'>, mac = process.platform === 'darwin'): ZoomStep | null {
  if (input.type !== 'keyDown' || input.alt || !(mac ? input.meta : input.control)) return null
  if (input.key === '=' || input.key === '+') return 1
  if (input.key === '-' || input.key === '_') return -1
  if (input.key === '0') return 0
  return null
}

export function nextZoom(current: number, step: ZoomStep): number {
  if (step === 0) return 1
  const next = step > 0 ? FACTORS.find((f) => f > current + 0.001) : [...FACTORS].reverse().find((f) => f < current - 0.001)
  return next ?? current
}
