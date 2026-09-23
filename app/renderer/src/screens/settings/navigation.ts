import type { MessageKey } from '@shared/i18n'
import { Cable, CircleUser, Info, Library, MonitorPlay, Palette, Plug, Wrench, type LucideIcon } from 'lucide-react'

export const SETTINGS_CATEGORIES = [
  { id: 'general', label: 'settings.category.general', icon: Palette, pages: ['appearance', 'media-centre', 'shortcuts'] },
  { id: 'playback', label: 'settings.category.playback', icon: MonitorPlay, pages: ['playback', 'video', 'subtitles', 'gooner'] },
  { id: 'library', label: 'settings.category.library', icon: Library, pages: ['sources', 'tagging'] },
  { id: 'motion', label: 'settings.category.motion', icon: Cable, pages: ['devices', 'axes', 'estim', 'tracking', 'models'] },
  { id: 'connections', label: 'settings.category.connections', icon: Plug, pages: ['sharing', 'source', 'headsets', 'intiface', 'chaster'] },
  { id: 'account', label: 'settings.category.account', icon: CircleUser, pages: ['profile', 'friends', 'privacy', 'support'] },
  { id: 'advanced', label: 'settings.category.advanced', icon: Wrench, pages: ['technical', 'maintenance', 'telemetry'] },
  { id: 'about', label: 'settings.category.about', icon: Info, pages: ['about'] },
] as const satisfies readonly { id: string; label: MessageKey; icon: LucideIcon; pages: readonly string[] }[]

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]['id']
export type SettingsPageId = (typeof SETTINGS_CATEGORIES)[number]['pages'][number]
export const PAGE_LABELS: Record<SettingsPageId, MessageKey> = {
  appearance: 'settings.page.appearance',
  'media-centre': 'settings.page.media-centre',
  shortcuts: 'settings.page.shortcuts',
  playback: 'settings.page.playback',
  video: 'settings.page.video',
  subtitles: 'settings.page.subtitles',
  gooner: 'settings.page.gooner',
  sources: 'settings.page.sources',
  tagging: 'settings.page.tagging',
  devices: 'settings.page.devices',
  axes: 'settings.page.axes',
  estim: 'settings.page.estim',
  tracking: 'settings.page.tracking',
  models: 'settings.page.models',
  sharing: 'settings.page.sharing',
  source: 'settings.page.source',
  headsets: 'settings.page.headsets',
  intiface: 'settings.page.intiface',
  chaster: 'settings.page.chaster',
  profile: 'settings.page.profile',
  friends: 'settings.page.friends',
  privacy: 'settings.page.privacy',
  support: 'settings.page.support',
  technical: 'settings.page.technical',
  maintenance: 'settings.page.maintenance',
  telemetry: 'settings.page.telemetry',
  about: 'settings.page.about',
}
export const PAGE_TITLES: Partial<Record<SettingsPageId, MessageKey>> = { support: 'settings.pageTitle.support' }
export function categoryFor(page: SettingsPageId) {
  return SETTINGS_CATEGORIES.find((category) => category.pages.some((id) => id === page))!
}
export function settingTarget(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
export interface SettingDescriptor {
  id: string
  page: SettingsPageId
  label: string
  aliases: readonly string[]
  advanced?: boolean
}
