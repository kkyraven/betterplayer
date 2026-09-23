import { invoke } from '@/ipc'

export function track(feature: string): void {
  void invoke('usage:track', feature.toLowerCase()).catch(() => undefined)
}
