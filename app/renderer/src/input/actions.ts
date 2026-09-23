import type { MessageKey } from '@shared/i18n'
import { enhanceCapabilities } from '@/engine/client'
import { skipGap } from '@/state/gapSkip'
import { useEditor } from '@/state/editor'
import { usePlayer } from '@/state/player'
import { useSession } from '@/state/session'
import { useSettings } from '@/state/settings'
import { t } from '@/state/i18n'
import { useUi } from '@/state/ui'

export type Where = 'player' | 'editor' | 'any'

interface Action {
  label: MessageKey
  where: Where
  run: () => void
}

function toggleUpscaling() {
  const current = useSettings.getState().settings?.upscaling.upscaler
  usePlayer.getState().setUpscaling({ upscaler: current !== 'off' ? 'off' : enhanceCapabilities.vsr ? 'rtx' : enhanceCapabilities.appleVsr ? 'apple' : 'fsr' })
}

function toggleFrameGen() {
  const current = useSettings.getState().settings?.upscaling.frameGen
  usePlayer.getState().setUpscaling({ frameGen: current !== 'off' ? 'off' : 'display' })
}

const player = (label: MessageKey, run: () => void): Action => ({ label, where: 'player', run })
const anywhere = (label: MessageKey, run: () => void): Action => ({ label, where: 'any', run })
const editor = (label: MessageKey, run: () => void): Action => ({ label, where: 'editor', run })
const ed = () => useEditor.getState()

export const ACTIONS = {
  'Media.PlayPause.Toggle': player('input.action.mediaPlayPauseToggle', () => usePlayer.getState().togglePlay()),
  'Media.Seek.Back': player('input.action.mediaSeekBack', () => usePlayer.getState().seekBy(-4)),
  'Media.Seek.Forward': player('input.action.mediaSeekForward', () => usePlayer.getState().seekBy(4)),
  'Media.Seek.BackLong': player('input.action.mediaSeekBackLong', () => usePlayer.getState().seekBy(-20)),
  'Media.Seek.ForwardLong': player('input.action.mediaSeekForwardLong', () => usePlayer.getState().seekBy(20)),
  'Media.Mark.Set': player('input.action.mediaMarkSet', () => usePlayer.getState().setMark()),
  'Media.Mark.Go': player('input.action.mediaMarkGo', () => usePlayer.getState().goToMark()),
  'Media.Gap.Skip': player('input.action.mediaGapSkip', skipGap),
  'Media.Intensity.Down': player('input.action.mediaIntensityDown', () => usePlayer.getState().adjustAmplitude(-0.05)),
  'Media.Intensity.Reset': player('input.action.mediaIntensityReset', () => usePlayer.getState().resetAmplitude()),
  'Media.Intensity.Up': player('input.action.mediaIntensityUp', () => usePlayer.getState().adjustAmplitude(0.05)),
  'Media.Volume.Up': player('input.action.mediaVolumeUp', () => usePlayer.getState().setVolume(usePlayer.getState().volume + 0.05)),
  'Media.Volume.Down': player('input.action.mediaVolumeDown', () => usePlayer.getState().setVolume(usePlayer.getState().volume - 0.05)),
  'Media.Mute.Toggle': player('input.action.mediaMuteToggle', () => usePlayer.getState().toggleMute()),
  'Media.Offset.Earlier': player('input.action.mediaOffsetEarlier', () => usePlayer.getState().setGlobalOffset(usePlayer.getState().video.globalOffsetMs - 10)),
  'Media.Offset.Later': player('input.action.mediaOffsetLater', () => usePlayer.getState().setGlobalOffset(usePlayer.getState().video.globalOffsetMs + 10)),
  'Media.Offset.EarlierLong': player('input.action.mediaOffsetEarlierLong', () => usePlayer.getState().setGlobalOffset(usePlayer.getState().video.globalOffsetMs - 100)),
  'Media.Offset.LaterLong': player('input.action.mediaOffsetLaterLong', () => usePlayer.getState().setGlobalOffset(usePlayer.getState().video.globalOffsetMs + 100)),
  'Video.Upscaling.Toggle': anywhere('input.action.videoUpscalingToggle', toggleUpscaling),
  'Video.FrameGen.Toggle': anywhere('input.action.videoFrameGenToggle', toggleFrameGen),
  'Window.Fullscreen.Toggle': anywhere('input.action.windowFullscreenToggle', () => void useUi.getState().toggleFullscreen()),
  'Window.MediaCentre.Toggle': anywhere('input.action.windowMediaCentreToggle', () => useUi.getState().setMediaCentre(!useUi.getState().mediaCentre)),
  'Session.Next': anywhere('input.action.sessionNext', () => useSession.getState().next()),
  'Session.Previous': anywhere('input.action.sessionPrevious', () => useSession.getState().previous()),
  'Session.End': anywhere('input.action.sessionEnd', () => useSession.getState().end()),

  'Editor.Play.Toggle': editor('input.action.editorPlayToggle', () => ed().togglePlay()),
  'Editor.Speed.Down': editor('input.action.editorSpeedDown', () => ed().stepSpeed(-1)),
  'Editor.Speed.Up': editor('input.action.editorSpeedUp', () => ed().stepSpeed(1)),
  'Editor.Play.FromSelection': editor('input.action.editorPlayFromSelection', () => ed().playFromSelection()),
  'Editor.Frame.Back': editor('input.action.editorFrameBack', () => ed().frameStep(-1)),
  'Editor.Frame.Forward': editor('input.action.editorFrameForward', () => ed().frameStep(1)),
  'Editor.Frame.BackTen': editor('input.action.editorFrameBackTen', () => ed().frameStep(-10)),
  'Editor.Frame.ForwardTen': editor('input.action.editorFrameForwardTen', () => ed().frameStep(10)),
  'Editor.Frame.BackSecond': editor('input.action.editorFrameBackSecond', () => ed().stepSeconds(-1)),
  'Editor.Frame.ForwardSecond': editor('input.action.editorFrameForwardSecond', () => ed().stepSeconds(1)),
  'Editor.Point.Next': editor('input.action.editorPointNext', () => ed().stepPoint(1)),
  'Editor.Point.Previous': editor('input.action.editorPointPrevious', () => ed().stepPoint(-1)),
  'Editor.Cut.Next': editor('input.action.editorCutNext', () => ed().stepCut(1)),
  'Editor.Cut.Previous': editor('input.action.editorCutPrevious', () => ed().stepCut(-1)),
  'Editor.Marker.Next': editor('input.action.editorMarkerNext', () => ed().stepMarker(1)),
  'Editor.Marker.Previous': editor('input.action.editorMarkerPrevious', () => ed().stepMarker(-1)),
  'Editor.Point.At0': editor('input.action.editorPointAt0', () => ed().placeAt(0, false)),
  'Editor.Point.At10': editor('input.action.editorPointAt10', () => ed().placeAt(10, false)),
  'Editor.Point.At20': editor('input.action.editorPointAt20', () => ed().placeAt(20, false)),
  'Editor.Point.At30': editor('input.action.editorPointAt30', () => ed().placeAt(30, false)),
  'Editor.Point.At40': editor('input.action.editorPointAt40', () => ed().placeAt(40, false)),
  'Editor.Point.At50': editor('input.action.editorPointAt50', () => ed().placeAt(50, false)),
  'Editor.Point.At60': editor('input.action.editorPointAt60', () => ed().placeAt(60, false)),
  'Editor.Point.At70': editor('input.action.editorPointAt70', () => ed().placeAt(70, false)),
  'Editor.Point.At80': editor('input.action.editorPointAt80', () => ed().placeAt(80, false)),
  'Editor.Point.At90': editor('input.action.editorPointAt90', () => ed().placeAt(90, false)),
  'Editor.Point.At100': editor('input.action.editorPointAt100', () => ed().placeAt(100, false)),
  'Editor.Point.Alternate': editor('input.action.editorPointAlternate', () => ed().alternate()),
  'Editor.Delete': editor('input.action.editorDelete', () => ed().deleteSelection()),
  'Editor.Select.All': editor('input.action.editorSelectAll', () => ed().selectAll()),
  'Editor.Select.None': editor('input.action.editorSelectNone', () => ed().selectNone()),
  'Editor.Select.Left': editor('input.action.editorSelectLeft', () => ed().selectSide('left')),
  'Editor.Select.Right': editor('input.action.editorSelectRight', () => ed().selectSide('right')),
  'Editor.Select.Tops': editor('input.action.editorSelectTops', () => ed().selectKind('top')),
  'Editor.Select.Bottoms': editor('input.action.editorSelectBottoms', () => ed().selectKind('bottom')),
  'Editor.Select.Mids': editor('input.action.editorSelectMids', () => ed().selectKind('mid')),
  'Editor.Select.BetweenCuts': editor('input.action.editorSelectBetweenCuts', () => ed().selectBetweenCuts()),
  'Editor.Select.Chapter': editor('input.action.editorSelectChapter', () => ed().selectChapter()),
  'Editor.Select.Invert': editor('input.action.editorSelectInvert', () => ed().invertSelection()),
  'Editor.Move.Up': editor('input.action.editorMoveUp', () => ed().moveSelection(1, 0)),
  'Editor.Move.Down': editor('input.action.editorMoveDown', () => ed().moveSelection(-1, 0)),
  'Editor.Move.UpTen': editor('input.action.editorMoveUpTen', () => ed().moveSelection(10, 0)),
  'Editor.Move.DownTen': editor('input.action.editorMoveDownTen', () => ed().moveSelection(-10, 0)),
  'Editor.Move.Earlier': editor('input.action.editorMoveEarlier', () => ed().moveSelection(0, -1000 / ed().fps)),
  'Editor.Move.Later': editor('input.action.editorMoveLater', () => ed().moveSelection(0, 1000 / ed().fps)),
  'Editor.Move.EarlierTen': editor('input.action.editorMoveEarlierTen', () => ed().moveSelection(0, -10_000 / ed().fps)),
  'Editor.Move.LaterTen': editor('input.action.editorMoveLaterTen', () => ed().moveSelection(0, 10_000 / ed().fps)),
  'Editor.Undo': editor('input.action.editorUndo', () => ed().undo()),
  'Editor.Redo': editor('input.action.editorRedo', () => ed().redo()),
  'Editor.Cut': editor('input.action.editorCut', () => ed().cut()),
  'Editor.Copy': editor('input.action.editorCopy', () => ed().copy()),
  'Editor.Paste': editor('input.action.editorPaste', () => ed().paste(false)),
  'Editor.PasteExact': editor('input.action.editorPasteExact', () => ed().paste(true)),
  'Editor.Invert': editor('input.action.editorInvert', () => ed().invert()),
  'Editor.Reverse': editor('input.action.editorReverse', () => ed().reverse()),
  'Editor.Flatten': editor('input.action.editorFlatten', () => ed().flatten()),
  'Editor.Simplify': editor('input.action.editorSimplify', () => ed().previewOp('simplify')),
  'Editor.ScaleDepth': editor('input.action.editorScaleDepth', () => ed().previewOp('scaleDepth')),
  'Editor.ScaleTime': editor('input.action.editorScaleTime', () => ed().previewOp('scaleTime')),
  'Editor.RangeExtend': editor('input.action.editorRangeExtend', () => ed().previewOp('rangeExtend')),
  'Editor.Loop': editor('input.action.editorLoop', () => ed().previewOp('loop')),
  'Editor.Quantise': editor('input.action.editorQuantise', () => ed().previewOp('quantise')),
  'Editor.LimitSpeed': editor('input.action.editorLimitSpeed', () => ed().previewOp('limitSpeed')),
  'Editor.Select.By': editor('input.action.editorSelectBy', () => ed().openSelectBy()),
  'Editor.Fill': editor('input.action.editorFill', () => ed().fillPattern()),
  'Editor.Fill.Card': editor('input.action.editorFillCard', () => ed().setCard(ed().card === 'pattern' ? null : 'pattern')),
  'Editor.AiFill': editor('input.action.editorAiFill', () => void ed().aiFill()),
  'Editor.AiFill.Card': editor('input.action.editorAiFillCard', () => ed().setCard(ed().card === 'fill' ? null : 'fill')),
  'Editor.Refit': editor('input.action.editorRefit', () => ed().refit()),
  'Editor.OtherAxes': editor('input.action.editorOtherAxes', () => ed().otherAxes()),
  'Editor.Record': editor('input.action.editorRecord', () => (ed().recording ? ed().stopRecord() : ed().setCard(ed().card === 'record' ? null : 'record'))),
  'Editor.Ghost.Next': editor('input.action.editorGhostNext', () => ed().ghostWalk(1)),
  'Editor.Ghost.Previous': editor('input.action.editorGhostPrevious', () => ed().ghostWalk(-1)),
  'Editor.Ghost.Earlier': editor('input.action.editorGhostEarlier', () => ed().ghostAdjust(-1000 / ed().fps, 1)),
  'Editor.Ghost.Later': editor('input.action.editorGhostLater', () => ed().ghostAdjust(1000 / ed().fps, 1)),
  'Editor.Ghost.Shallower': editor('input.action.editorGhostShallower', () => ed().ghostAdjust(0, 1 / 1.1)),
  'Editor.Ghost.Deeper': editor('input.action.editorGhostDeeper', () => ed().ghostAdjust(0, 1.1)),
  'Editor.Escape': editor('input.action.editorEscape', () => ed().escape()),
  'Editor.Loop.In': editor('input.action.editorLoopIn', () => ed().loopIn()),
  'Editor.Loop.Out': editor('input.action.editorLoopOut', () => ed().loopOut()),
  'Editor.Loop.Toggle': editor('input.action.editorLoopToggle', () => ed().toggleLoop()),
  'Editor.Bookmark': editor('input.action.editorBookmark', () => ed().addBookmark()),
  'Editor.Flag.Toggle': editor('input.action.editorFlagToggle', () => ed().toggleFlag()),
  'Editor.Flag.Next': editor('input.action.editorFlagNext', () => ed().stepFlag(1)),
  'Editor.Flag.Previous': editor('input.action.editorFlagPrevious', () => ed().stepFlag(-1)),
  'Editor.Chapter.Start': editor('input.action.editorChapterStart', () => ed().chapterStart()),
  'Editor.Chapter.End': editor('input.action.editorChapterEnd', () => ed().chapterEnd()),
  'Editor.Lane.Previous': editor('input.action.editorLanePrevious', () => ed().stepLane(-1)),
  'Editor.Lane.Next': editor('input.action.editorLaneNext', () => ed().stepLane(1)),
  'Editor.Linked.Toggle': editor('input.action.editorLinkedToggle', () => ed().toggleLinked()),
  'Editor.Snap.Toggle': editor('input.action.editorSnapToggle', () => ed().setOption('snap', !ed().snap)),
  'Editor.Tool.Select': editor('input.action.editorToolSelect', () => ed().setTool('select')),
  'Editor.Tool.Place': editor('input.action.editorToolPlace', () => ed().setTool('place')),
  'Editor.Zoom.In': editor('input.action.editorZoomIn', () => ed().zoom(1 / 1.5)),
  'Editor.Zoom.Out': editor('input.action.editorZoomOut', () => ed().zoom(1.5)),
  'Editor.Zoom.Selection': editor('input.action.editorZoomSelection', () => ed().zoomSelection()),
  'Editor.Zoom.Fit': editor('input.action.editorZoomFit', () => ed().zoomFit()),
  'Editor.Save': editor('input.action.editorSave', () => void ed().save()),
  'Editor.Export': editor('input.action.editorExport', () => ed().setSheet('export')),
  'Editor.Metadata': editor('input.action.editorMetadata', () => ed().setSheet('metadata')),
  'Editor.Shortcuts': editor('input.action.editorShortcuts', () => ed().setSheet(ed().sheet === 'shortcuts' ? null : 'shortcuts')),
} as const satisfies Record<string, Action>

export type ActionId = keyof typeof ACTIONS
export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[]

export function isActionId(id: string): id is ActionId {
  return id in ACTIONS
}

export function actionAvailable(id: ActionId): boolean {
  const where = ACTIONS[id].where
  const ui = useUi.getState()
  const screen = ui.screen
  if (id === 'Media.PlayPause.Toggle') {
    const { path, snapshot } = usePlayer.getState()
    const stripOpen = path !== null && path !== ui.stripHiddenFor
    return screen !== 'editor' && snapshot.loaded && (screen === 'player' || !snapshot.paused || stripOpen)
  }
  if (where === 'player') return screen === 'player' && usePlayer.getState().snapshot.loaded
  if (where === 'editor') return screen === 'editor' && useEditor.getState().open
  return true
}

export function runAction(id: ActionId): boolean {
  if (!actionAvailable(id)) return false
  ACTIONS[id].run()
  return true
}

export function deviceInputKey(name: string): string {
  return `device:${name.trim().toLowerCase()}`
}

export function keyboardKey(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey) parts.push('meta')
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey && (e.key.length > 1 || /^[a-z]$/i.test(e.key))) parts.push('shift')
  parts.push(e.key === ' ' ? 'space' : e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase())
  return parts.join('+')
}

export function gamepadKey(button: number): string {
  return `pad:${button}`
}

export const EDITOR_PREFIX = 'editor:'

let bindings: Record<string, ActionId> = {}
let capture: ((key: string) => void) | null = null

export function setBindings(next: Record<string, string>) {
  bindings = {}
  for (const [key, id] of Object.entries(next)) if (isActionId(id)) bindings[key] = id
}

export function bindingAction(key: string): ActionId | undefined {
  const onEditor = useUi.getState().screen === 'editor' && useEditor.getState().open
  return (onEditor ? bindings[EDITOR_PREFIX + key] : undefined) ?? bindings[key]
}

export function bindingsFor(id: ActionId): string[] {
  return Object.entries(bindings)
    .filter(([, a]) => a === id)
    .map(([k]) => k)
}

export function isCapturingBinding() { return capture !== null }

export function captureNext(fn: (key: string) => void): () => void {
  capture = fn
  return () => {
    if (capture === fn) capture = null
  }
}

export function dispatch(key: string): boolean {
  if (capture) {
    const fn = capture
    capture = null
    fn(key)
    return true
  }
  const id = bindingAction(key)
  if (!id) return false
  return runAction(id)
}

export function onDeviceInput(_output: number, name: string) {
  dispatch(deviceInputKey(name))
}

const PAD_NAMES: Record<string, string> = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'Back', 9: 'Start', 12: 'Up', 13: 'Down', 14: 'Left', 15: 'Right' }
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
const COMMON_KEY_NAMES: Record<string, string> = { space: 'Space', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', escape: 'Esc', pageup: 'PgUp', pagedown: 'PgDn', delete: 'Del' }
const KEY_NAMES: Record<string, string> = IS_MAC
  ? { ...COMMON_KEY_NAMES, enter: '↩', backspace: '⌫', tab: '⇥', meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
  : { ...COMMON_KEY_NAMES, enter: 'Enter', backspace: 'Backspace', tab: 'Tab', meta: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }

export function bindingLabel(key: string): string {
  const plain = key.startsWith(EDITOR_PREFIX) ? key.slice(EDITOR_PREFIX.length) : key
  if (plain.startsWith('pad:')) return t('input.binding.pad', { name: PAD_NAMES[plain.slice(4)] ?? plain.slice(4) })
  if (plain.startsWith('device:')) return t('input.binding.device', { name: plain.slice(7) })
  return plain
    .split('+')
    .map((p) => KEY_NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : (p[0]?.toUpperCase() ?? '') + p.slice(1)))
    .join(IS_MAC ? '' : '+')
}

export function keyLabel(id: ActionId): string {
  const key = bindingsFor(id)[0]
  return key ? bindingLabel(key) : ''
}
