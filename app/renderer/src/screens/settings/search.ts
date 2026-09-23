import { LANGUAGE_CHOICE, type MessageKey } from '@shared/i18n'
import { t } from '@/state/i18n'
import { categoryFor, PAGE_LABELS, settingTarget, type SettingDescriptor, type SettingsPageId } from './navigation'

const fields: Partial<Record<SettingsPageId, readonly [readonly MessageKey[], readonly MessageKey[]]>> = {
  appearance: [[...(LANGUAGE_CHOICE ? (['settings.appearance.language'] as const) : []), 'settings.appearance.mode', 'settings.appearance.reduceTransparency', 'settings.appearance.startInMediaCentre', 'settings.appearance.accent', 'settings.appearance.tint', 'settings.appearance.continueRow', 'settings.appearance.axisBadges'], []],
  'media-centre': [['settings.mediaCentre.buttonHints', 'settings.mediaCentre.backdrop'], []],
  shortcuts: [['settings.search.shortcutBindings', 'settings.shortcuts.reset'], []],
  playback: [['settings.playback.gapSkip'], []],
  video: [
    ['settings.video.upscaling', 'settings.video.frameGeneration', 'settings.video.compareWith'],
    [
      'settings.video.hardwareDecode',
      'settings.video.preset',
      'settings.video.style',
      'settings.video.intensity',
      'settings.video.localTone',
      'settings.video.localStructure',
      'settings.video.skinStructure',
      'settings.video.autoMask',
      'settings.video.modelPreset',
      'settings.video.scalingMode',
      'settings.video.processingHeight',
      'settings.video.frameRate',
      'settings.video.motionGuides',
      'settings.video.playbackBuffer',
    ],
  ],
  subtitles: [['settings.subtitles.show', 'settings.subtitles.size', 'settings.subtitles.colour', 'settings.subtitles.style', 'settings.subtitles.height'], []],
  gooner: [
    [
      'settings.gooner.hide',
      'settings.gooner.style',
      'settings.gooner.strength',
      'settings.gooner.denial',
      'settings.gooner.while',
      'settings.gooner.clothing',
      'settings.search.axisRules',
      'settings.gooner.holdFor',
      'settings.gooner.lock',
    ],
    [],
  ],
  sources: [['settings.sources.folders', 'settings.sources.scriptMatching', 'settings.sources.otherFolders', 'settings.sources.mediaServers', 'settings.sources.stashPreviews', 'settings.sources.stashApp'], []],
  axes: [
    [
      'settings.search.axes.enabled',
      'settings.axes.invert',
      'settings.axes.range',
      'settings.axes.amplitude',
      'settings.axes.speedLimit',
      'settings.axes.resetAll',
    ],
    [
      'settings.axes.rangeExtender',
      'settings.axes.curve',
      'settings.axes.autoHomeDelay',
      'settings.axes.autoHomeTime',
      'settings.axes.motion',
      'settings.axes.targets',
      'settings.axes.period',
      'settings.axes.blend',
    ],
  ],
  estim: [
    [
      'settings.search.axes.enabled',
      'settings.axes.invert',
      'settings.axes.range',
      'settings.axes.amplitude',
      'settings.axes.speedLimit',
      'settings.estim.contrast',
      'settings.estim.volumeLimits',
      'settings.estim.volumeBoost',
      'settings.estim.boostAxis',
    ],
    [
      'settings.estim.frequenciesLabel',
      'settings.axes.rangeExtender',
      'settings.axes.curve',
      'settings.axes.autoHomeDelay',
      'settings.axes.autoHomeTime',
      'settings.axes.motion',
      'settings.axes.targets',
      'settings.axes.period',
      'settings.axes.blend',
    ],
  ],
  devices: [['settings.devices.stopOnPause', 'settings.devices.manage'], []],
  models: [
    ['settings.models.regionModel', 'settings.models.musicModel', 'settings.search.modelDownloads'],
    ['settings.search.provider', 'settings.search.warmUp'],
  ],
  tracking: [
    [
      'settings.tracking.paceStart',
      'settings.tracking.motionDefault',
      'settings.tracking.regionStart',
      'settings.tracking.sensitivity',
      'settings.tracking.flourishes',
      'settings.tracking.beat',
      'settings.tracking.bottomBounce',
      'settings.tracking.bounceDepth',
      'settings.tracking.bounceSpeed',
      'settings.tracking.depthByVolume',
    ],
    [
      'settings.tracking.redetectEvery',
      'settings.tracking.regionPadding',
      'settings.tracking.showBox',
      'settings.tracking.cutSensitivity',
      'settings.tracking.easeAfterCut',
      'settings.tracking.clampJumps',
      'settings.tracking.generatedDefaults',
      'settings.search.tracking.allFromL0',
      'tracking.axesTable.source',
      'tracking.axesTable.limits',
      'tracking.intensity',
      'tracking.axesTable.smoothing',
      'settings.axes.invert',
    ],
  ],
  sharing: [['settings.sharing.serve'], ['settings.sharing.port']],
  source: [['settings.source.librarySource', 'settings.source.follow'], []],
  headsets: [['settings.headsets.player', 'settings.headsets.address', 'settings.headsets.follow', 'settings.headsets.stopFollowing'], []],
  intiface: [['settings.intiface.actAs'], []],
  chaster: [['settings.search.chaster.connection', 'settings.chaster.status'], []],
  profile: [['settings.profile.signIn', 'settings.profile.signOut', 'settings.profile.displayName', 'settings.profile.friendCode'], []],
  friends: [['settings.friends.add', 'settings.friends.requests', 'settings.friends.friends'], []],
  privacy: [['settings.privacy.syncVideo'], []],
  telemetry: [['settings.privacy.sendUsageStats'], []],
  support: [['settings.support.become'], []],
  maintenance: [['settings.maintenance.settingsFile', 'settings.maintenance.firstTimeSetup'], []],
  about: [['settings.search.version', 'settings.about.checkForUpdates', 'settings.about.restartToUpdate', 'settings.support.recentReleases'], []],
  tagging: [['settings.tagging.autoTagging', 'settings.tagging.tagServers', 'settings.tagging.taggerDownload'], ['settings.tagging.recalculateTags']],
}
const aliases: Partial<Record<SettingsPageId, readonly MessageKey[]>> = {
  axes: ['devices.output.axes', 'settings.search.alias.tcode', 'settings.search.alias.outputDefaults'],
  tracking: ['browser.addr.tracking', 'editor.fill.source.aiMotion'],
  video: ['firstStart.step.upscaling', 'settings.search.alias.picture', 'settings.search.alias.dlss'],
  sharing: ['devices.screen.headsets', 'settings.search.alias.libraryServer'],
  source: ['settings.search.alias.remote', 'settings.page.source'],
  tagging: ['settings.search.alias.tagger'],
  models: ['settings.search.alias.downloads', 'settings.search.alias.trackingModels'],
  support: ['firstStart.supporter.eyebrow', 'admin.premium', 'export.support.subscribe', 'settings.search.alias.subscription'],
  about: ['settings.search.alias.releaseNotes'],
}
const fieldAliases: Partial<Record<`${SettingsPageId}:${MessageKey}`, readonly MessageKey[]>> = {
  'video:settings.video.preset': ['settings.search.alias.neuralPreset', 'settings.search.alias.dlssPreset'],
  'video:settings.video.style': ['settings.search.alias.neuralStyle'],
  'tracking:settings.tracking.generatedDefaults': ['settings.search.alias.defaultAxes', 'settings.search.alias.trackingAxes'],
  'tracking:settings.tracking.redetectEvery': ['settings.search.alias.detectionInterval', 'settings.search.alias.redetection'],
  'estim:settings.estim.volumeLimits': ['settings.search.alias.volumeFloor', 'settings.search.alias.volumeMaximum'],
  'axes:settings.axes.motion': ['settings.search.alias.motionProvider', 'devices.restim.sweep.random', 'devices.restim.sweep.sine'],
  'estim:settings.axes.motion': ['settings.search.alias.motionProvider', 'devices.restim.sweep.random', 'devices.restim.sweep.sine'],
}
export function settingsSearchIndex(): SettingDescriptor[] {
  return Object.entries(PAGE_LABELS).flatMap(([key, label]) => {
    const page = key as SettingsPageId
    const [basic, advanced] = fields[page] ?? [[], []]
    return [
      { id: 'page', page, label: t(label), aliases: (aliases[page] ?? []).map((key) => t(key)) },
      ...[...basic.map((key) => ({ key, advanced: false })), ...advanced.map((key) => ({ key, advanced: true }))].map(({ key, advanced }) => {
        const label = t(key)
        return { id: settingTarget(label), page, label, advanced, aliases: (fieldAliases[`${page}:${key}`] ?? []).map((key) => t(key)) }
      }),
    ]
  })
}
export function searchSettings(query: string): SettingDescriptor[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/)
  return settingsSearchIndex().map((setting, index) => {
    const label = setting.label.toLowerCase()
    const path = `${t(categoryFor(setting.page).label)} ${t(PAGE_LABELS[setting.page])}`.toLowerCase()
    const alias = setting.aliases.join(' ').toLowerCase()
    const score =
      label === q
        ? 0
        : label.startsWith(q)
          ? 1
          : label.includes(q)
            ? 2
            : terms.every((term) => `${label} ${path}`.includes(term))
              ? 3
              : terms.every((term) => `${label} ${path} ${alias}`.includes(term))
                ? 4
                : -1
    return { setting, score, index }
  })
    .filter(({ score }) => score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ setting }) => setting)
}

export function locateSetting(root: HTMLElement, target: string): HTMLElement {
  const exact = Array.from(root.querySelectorAll<HTMLElement>('[data-setting]')).find((row) => row.dataset.setting === target)
  if (exact && !exact.closest('[inert]')) return exact.matches('.lbl') ? (exact.closest<HTMLElement>('.prow') ?? exact) : exact
  const controls = Array.from(root.querySelectorAll<HTMLElement>('[aria-label], button, h3, .eyebrow'))
  const control = controls.find((el) => {
    const name = settingTarget(el.getAttribute('aria-label') ?? el.textContent ?? '')
    return name === target || name.endsWith(`-${target}`) || (target === 'limits' && name.endsWith('-limit-min')) || (target === 'invert' && name.startsWith('invert-'))
  })
  const locked = (exact ?? control)?.closest('[inert]')
  if (locked) {
    const before = locked.previousElementSibling
    return root.querySelector<HTMLElement>('[data-setting="dlss"]') ?? (before instanceof HTMLElement ? before : root)
  }
  if (control) return control.closest<HTMLElement>('.prow, .rng, .estim-boost') ?? control
  if (['targets', 'period', 'blend'].includes(target)) return root.querySelector<HTMLElement>('[data-setting="provider"]') ?? root
  const axes = root.querySelector<HTMLElement>('[data-setting="generated-motion-defaults"]')
  if (axes && ['source', 'limits', 'intensity', 'smoothing', 'invert', 'all-from-l0'].includes(target)) return axes
  if (['sign-in', 'sign-out', 'display-name', 'friend-code', 'sync-video-settings', 'add-friend', 'requests', 'friends'].includes(target))
    return root.querySelector<HTMLElement>('[data-setting="account-state"], [data-setting="link-profile"]') ?? root.querySelector<HTMLElement>('h1') ?? root
  if (target === 'stop-following') return root.querySelector<HTMLElement>('[data-setting="headset-unavailable"]') ?? root
  if (target === 'restart-to-update') return root.querySelector<HTMLElement>('[data-setting="version"]') ?? root
  if (target === 'page') return root.querySelector<HTMLElement>('h1') ?? root
  return root.querySelector<HTMLElement>('[data-setting="dlss"]') ?? root.querySelector<HTMLElement>('[data-setting="advanced"]') ?? root.querySelector<HTMLElement>('h1') ?? root
}

export function markSettingRows(root: HTMLElement) {
  for (const row of root.querySelectorAll<HTMLElement>('.prow, .rng, .settings-link, .dev-follow, .dev-intiface')) {
    if (!row.dataset.setting) {
      const label = row.querySelector<HTMLElement>('[aria-label]') ?? row.querySelector<HTMLElement>('.lbl, .k, .field-label, .eyebrow')
      const name = label?.getAttribute('aria-label') ?? label?.textContent
      if (name) row.dataset.setting = settingTarget(name.trim())
      row.tabIndex = -1
    }
    const output = row.querySelector<HTMLElement>('.val, .v')
    if (output) {
      output.id ||= `settings-${settingTarget(root.getAttribute('aria-label') ?? '')}-${row.dataset.setting}-value`
      for (const slider of row.querySelectorAll('[role="slider"]')) slider.setAttribute('aria-describedby', output.id)
    }
  }
}
export function focusSetting(root: HTMLElement, target: string) {
  const row = locateSetting(root, target)
  const direct = row.matches('input:not(:disabled), button:not(:disabled), select:not(:disabled), [tabindex="0"]') && !row.closest('[inert], [aria-disabled="true"]') ? row : null
  const control =
    direct ??
    Array.from(row.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), select:not(:disabled), [tabindex="0"]')).find(
      (el) => !el.closest('[inert], [aria-disabled="true"]'),
    )
  const focus = control ?? row
  if (!control) focus.tabIndex = -1
  focus.scrollIntoView({ block: focus.clientHeight > root.clientHeight ? 'start' : 'center' })
  focus.focus({ preventScroll: true })
}
