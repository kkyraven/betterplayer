import type { MessageKey } from '@shared/i18n'
import type { Upscaler } from '@shared/settings'

export const STEPS = [
  { id: 'welcome', label: 'firstStart.step.welcome', optional: false },
  { id: 'folders', label: 'firstStart.step.folders', optional: false },
  { id: 'upscaling', label: 'firstStart.step.upscaling', optional: true },
  { id: 'tagging', label: 'firstStart.step.tagging', optional: true },
  { id: 'account', label: 'firstStart.step.account', optional: true },
] as const satisfies ReadonlyArray<{ id: string; label: MessageKey; optional: boolean }>
export type StepId = (typeof STEPS)[number]['id']

export interface Capabilities {
  appleVsr: boolean
  dlss: boolean
  vsr: boolean
}

export function bestUpscaler(caps: Capabilities | undefined, platform: string): Upscaler {
  if (caps?.vsr) return 'rtx'
  if (platform === 'darwin' && caps?.appleVsr) return 'apple'
  return 'fsr'
}

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
