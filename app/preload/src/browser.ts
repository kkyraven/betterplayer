import { ipcRenderer } from 'electron'
import { CAPTURE_WIDTH, SNAPSHOT_WIDTH, TAB_CHANNELS, type BrowserVideo, type Rect, type Region, type RegionBox, type TabFrame, type TabHandoff } from '@shared/browser'

const MIN_STEP_S = 1 / 45
const MIN_STEP_MS = 1000 / 45
const MIN_AREA = 120 * 80
const MIN_REGION = 0.05
const ACCENT = '#b7a3ff'
const INK = '#15102a'
const ZONE = '#7ee2a8'
const ZONE_INK = '#0b2418'

let video: HTMLVideoElement | null = null
let present = false
let capturing = false
let failed = false

function box(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function largestVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null
  let bestArea = MIN_AREA
  for (const el of document.querySelectorAll('video')) {
    const rect = el.getBoundingClientRect()
    const area = rect.width * rect.height
    if (area <= bestArea) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
    best = el
    bestArea = area
  }
  return best
}

function report() {
  if (!video && !present) return
  present = video !== null
  const state: BrowserVideo = video
    ? { present: true, playing: !video.paused && !video.ended, mediaTime: video.currentTime, rate: video.playbackRate }
    : { present: false, playing: false, mediaTime: 0, rate: 1 }
  ipcRenderer.send(TAB_CHANNELS.video, state)
}

function useVideo(next: HTMLVideoElement | null) {
  if (next === video) return
  unschedule()
  video?.removeEventListener('play', report)
  video?.removeEventListener('pause', report)
  video?.removeEventListener('ended', report)
  video?.removeEventListener('ratechange', report)
  video?.removeEventListener('seeked', report)
  video = next
  lastMediaTime = -1
  video?.addEventListener('play', report)
  video?.addEventListener('pause', report)
  video?.addEventListener('ended', report)
  video?.addEventListener('ratechange', report)
  video?.addEventListener('seeked', report)
  report()
  place()
  if (capturing) schedule()
}

const contexts = new Map<number, OffscreenCanvasRenderingContext2D>()
let gray: Uint8Array | null = null
let rgb: Uint8Array | null = null
let pending = 0
let usedRaf = false
let lastMediaTime = -1
let lastFrame = 0

function schedule() {
  const el = video
  if (!el || !capturing || failed || pending) return
  if (typeof el.requestVideoFrameCallback === 'function') {
    usedRaf = false
    pending = el.requestVideoFrameCallback((_now, meta) => {
      pending = 0
      grab(el, meta.mediaTime)
    })
  } else {
    usedRaf = true
    pending = requestAnimationFrame(() => {
      pending = 0
      const now = performance.now()
      if (now - lastFrame < MIN_STEP_MS) return schedule()
      lastFrame = now
      grab(el, el.currentTime)
    })
  }
}

function unschedule() {
  if (!pending) return
  if (usedRaf) cancelAnimationFrame(pending)
  else video?.cancelVideoFrameCallback(pending)
  pending = 0
}

function grab(el: HTMLVideoElement, mediaTime: number) {
  if (!capturing || el !== video) return
  if (!el.videoWidth || !el.videoHeight) return schedule()
  const step = mediaTime - lastMediaTime
  if (step >= 0 && step < MIN_STEP_S) return schedule()
  lastMediaTime = mediaTime
  const read = readback(el, CAPTURE_WIDTH)
  if (!read) return
  send(read, 1, mediaTime)
  schedule()
}

function contextFor(width: number, height: number): OffscreenCanvasRenderingContext2D | null {
  const kept = contexts.get(width)
  if (kept && kept.canvas.height === height) return kept
  const ctx = new OffscreenCanvas(width, height).getContext('2d')
  if (ctx) contexts.set(width, ctx)
  return ctx
}

interface Readback {
  rgba: Uint8ClampedArray
  width: number
  height: number
}

function readback(el: HTMLVideoElement, width: number): Readback | null {
  const height = Math.max(2, Math.round((width * el.videoHeight) / el.videoWidth / 2) * 2)
  const ctx = contextFor(width, height)
  if (!ctx) return fail('canvas')
  try {
    ctx.drawImage(el, 0, 0, width, height)
    return { rgba: ctx.getImageData(0, 0, width, height).data, width, height }
  } catch {
    return fail('drm')
  }
}

function fail(error: string): null {
  failed = true
  capturing = false
  unschedule()
  if (error === 'drm') {
    drmVideo = video
    place()
  }
  ipcRenderer.send(TAB_CHANNELS.error, error)
  return null
}

function send({ rgba, width, height }: Readback, channels: 1 | 3, mediaTime: number) {
  const n = width * height * channels
  let out = channels === 1 ? gray : rgb
  if (!out || out.length !== n) {
    out = new Uint8Array(n)
    if (channels === 1) gray = out
    else rgb = out
  }
  if (channels === 1) {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      out[i] = ((rgba[p] ?? 0) * 77 + (rgba[p + 1] ?? 0) * 150 + (rgba[p + 2] ?? 0) * 29) >> 8
    }
  } else {
    for (let i = 0, p = 0; i < n; i += 3, p += 4) {
      out[i] = rgba[p] ?? 0
      out[i + 1] = rgba[p + 1] ?? 0
      out[i + 2] = rgba[p + 2] ?? 0
    }
  }
  const frame: TabFrame = { bytes: out, channels, width, height, mediaTime, capturedAt: performance.timeOrigin + performance.now() }
  ipcRenderer.send(TAB_CHANNELS.frame, frame)
}

type Corner = 'nw' | 'ne' | 'sw' | 'se'

interface Box {
  region: Region | null
  auto: boolean
  label: string | null
  colour: string
  ink: string
  fallback: string
  editChannel: string
  frame: HTMLDivElement | null
  labelEl: HTMLDivElement | null
  handles: HTMLDivElement[]
}

let overlay: HTMLDivElement | null = null
let drmVideo: HTMLVideoElement | null = null
let drmNotice: HTMLDivElement | null = null
let drag: { box: Box; corner: Corner | null; x: number; y: number; from: Region; rect: Rect } | null = null

const regionBox: Box = { region: null, auto: false, label: null, colour: ACCENT, ink: INK, fallback: 'Region', editChannel: TAB_CHANNELS.regionEdit, frame: null, labelEl: null, handles: [] }
const zoneBox: Box = { region: null, auto: false, label: null, colour: ZONE, ink: ZONE_INK, fallback: 'Zone', editChannel: TAB_CHANNELS.zoneEdit, frame: null, labelEl: null, handles: [] }
const boxes = [regionBox, zoneBox]

function style(el: HTMLElement, css: Partial<CSSStyleDeclaration>) {
  Object.assign(el.style, css)
}

function placeDrmNotice() {
  if (!video || video !== drmVideo) {
    drmNotice?.remove()
    drmNotice = null
    return
  }
  if (!drmNotice?.isConnected) {
    const fullscreen = document.fullscreenElement
    const root = (fullscreen instanceof HTMLVideoElement ? null : fullscreen) ?? document.body ?? document.documentElement
    if (!root) return
    const host = document.createElement('div')
    const shadow = host.attachShadow({ mode: 'closed' })
    const css = document.createElement('style')
    css.textContent = `
      :host {
        all: initial !important;
        position: fixed !important;
        inset: var(--notice-top) auto auto var(--notice-left) !important;
        width: max-content !important;
        max-width: var(--notice-width) !important;
        transform: translateX(-100%) !important;
      }
      :host::backdrop { background: transparent; pointer-events: none; }
      .notice {
        display: flex; align-items: center; gap: 10px; box-sizing: border-box;
        padding: 8px 8px 8px 12px; border-radius: 10px;
        background: #14171f; color: #eef0f4; font: 500 13px/18px system-ui, sans-serif;
        box-shadow: 0 4px 16px #0005;
      }
      .message { min-width: 0; overflow-wrap: anywhere; }
      button {
        display: grid; place-items: center; flex: none; width: 28px; height: 28px;
        padding: 0; border: 0; border-radius: 4px; background: transparent;
        color: inherit; font: 20px/1 system-ui, sans-serif; cursor: pointer;
      }
      button:hover { background: rgba(255, 255, 255, 0.06); }
      button:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 1px; }
    `
    const notice = document.createElement('div')
    notice.className = 'notice'
    const message = document.createElement('span')
    message.className = 'message'
    message.setAttribute('role', 'alert')
    message.textContent = "⚠ DRM - betterplayer can't capture"
    const close = document.createElement('button')
    close.type = 'button'
    close.setAttribute('aria-label', 'Close')
    close.textContent = '×'
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      drmVideo = null
      placeDrmNotice()
    })
    notice.append(message, close)
    shadow.append(css, notice)
    host.popover = 'manual'
    root.appendChild(host)
    drmNotice = host
  }
  const rect = box(video)
  drmNotice.style.setProperty('--notice-top', `${rect.y + 12}px`)
  drmNotice.style.setProperty('--notice-left', `${rect.x + rect.w - 12}px`)
  drmNotice.style.setProperty('--notice-width', `${Math.max(0, rect.w - 24)}px`)
  if (!drmNotice.matches(':popover-open')) drmNotice.showPopover()
}

function buildOverlay(): boolean {
  const root = document.body ?? document.documentElement
  if (!root) return false
  if (overlay?.isConnected) return true
  overlay = document.createElement('div')
  style(overlay, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' })
  root.appendChild(overlay)
  for (const box of boxes) box.frame = null
  return true
}

function buildBox(box: Box): HTMLDivElement | null {
  if (!buildOverlay() || !overlay) return null
  if (box.frame?.isConnected) return box.frame
  const frame = document.createElement('div')
  style(frame, { position: 'absolute', boxSizing: 'border-box', border: `1.5px dashed ${box.colour}`, cursor: 'move', pointerEvents: 'auto' })
  const label = document.createElement('div')
  style(label, {
    position: 'absolute',
    top: '-17px',
    left: '-1.5px',
    padding: '1px 5px',
    borderRadius: '3px 3px 0 0',
    background: box.colour,
    color: box.ink,
    font: '600 10px/14px system-ui, sans-serif',
    letterSpacing: '.02em',
  })
  frame.appendChild(label)
  const corners: ReadonlyArray<{ id: Corner; css: Partial<CSSStyleDeclaration> }> = [
    { id: 'nw', css: { top: '-4px', left: '-4px', cursor: 'nwse-resize' } },
    { id: 'ne', css: { top: '-4px', right: '-4px', cursor: 'nesw-resize' } },
    { id: 'sw', css: { bottom: '-4px', left: '-4px', cursor: 'nesw-resize' } },
    { id: 'se', css: { bottom: '-4px', right: '-4px', cursor: 'nwse-resize' } },
  ]
  box.handles = []
  for (const corner of corners) {
    const handle = document.createElement('div')
    style(handle, { position: 'absolute', width: '8px', height: '8px', background: box.colour, pointerEvents: 'auto', ...corner.css })
    handle.addEventListener('pointerdown', (event) => startDrag(box, event, corner.id))
    frame.appendChild(handle)
    box.handles.push(handle)
  }
  frame.addEventListener('pointerdown', (event) => startDrag(box, event, null))
  overlay.appendChild(frame)
  box.frame = frame
  box.labelEl = label
  return frame
}

function removeBox(box: Box) {
  box.frame?.remove()
  box.frame = null
  box.labelEl = null
  box.handles = []
}

function place() {
  placeDrmNotice()
  if (!video) {
    for (const b of boxes) removeBox(b)
    return
  }
  const rect = box(video)
  for (const b of boxes) {
    if (!b.region) {
      removeBox(b)
      continue
    }
    const frame = buildBox(b)
    if (!frame) continue
    const { region, auto } = b
    style(frame, {
      left: `${rect.x + region.x * rect.w}px`,
      top: `${rect.y + region.y * rect.h}px`,
      width: `${region.w * rect.w}px`,
      height: `${region.h * rect.h}px`,
      borderStyle: auto ? 'solid' : 'dashed',
      cursor: auto ? 'default' : 'move',
      boxShadow: auto || b === zoneBox ? 'none' : '0 0 0 9999px rgba(0,0,0,.18)',
    })
    if (b.labelEl) b.labelEl.textContent = auto ? (b.label ?? 'Auto') : b.fallback
    for (const h of b.handles) h.style.display = auto ? 'none' : ''
  }
}

function startDrag(b: Box, event: PointerEvent, corner: Corner | null) {
  if (!b.region || !video || b.auto || event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  drag = { box: b, corner, x: event.clientX, y: event.clientY, from: b.region, rect: box(video) }
  window.addEventListener('pointermove', onDrag, true)
  window.addEventListener('pointerup', endDrag, true)
}

function onDrag(event: PointerEvent) {
  if (!drag) return
  const dx = (event.clientX - drag.x) / (drag.rect.w || 1)
  const dy = (event.clientY - drag.y) / (drag.rect.h || 1)
  const from = drag.from
  if (!drag.corner) {
    drag.box.region = { ...from, x: clamp(from.x + dx, 0, 1 - from.w), y: clamp(from.y + dy, 0, 1 - from.h) }
  } else {
    const west = drag.corner === 'nw' || drag.corner === 'sw'
    const north = drag.corner === 'nw' || drag.corner === 'ne'
    const left = west ? clamp(from.x + dx, 0, from.x + from.w - MIN_REGION) : from.x
    const top = north ? clamp(from.y + dy, 0, from.y + from.h - MIN_REGION) : from.y
    const right = west ? from.x + from.w : clamp(from.x + from.w + dx, from.x + MIN_REGION, 1)
    const bottom = north ? from.y + from.h : clamp(from.y + from.h + dy, from.y + MIN_REGION, 1)
    drag.box.region = { x: left, y: top, w: right - left, h: bottom - top }
  }
  place()
}

function endDrag() {
  window.removeEventListener('pointermove', onDrag, true)
  window.removeEventListener('pointerup', endDrag, true)
  const d = drag
  drag = null
  if (d?.box.region) ipcRenderer.send(d.box.editChannel, d.box.region)
}

ipcRenderer.on(TAB_CHANNELS.capture, (_event, on: boolean) => {
  capturing = on && !failed
  lastMediaTime = -1
  if (capturing) schedule()
  else unschedule()
})

ipcRenderer.on(TAB_CHANNELS.snapshot, (_event, width?: number) => {
  const el = video
  if (!el || failed || !el.videoWidth || !el.videoHeight) return
  const read = readback(el, width ?? SNAPSHOT_WIDTH)
  if (read) send(read, 3, el.currentTime)
})

ipcRenderer.on(TAB_CHANNELS.handoff, (_event, requestId: number) => {
  const el = video?.isConnected ? video : null
  const result: TabHandoff = {
    requestId,
    url: el && !el.mediaKeys ? el.currentSrc || null : null,
    position: el?.currentTime ?? 0,
    rate: el?.playbackRate ?? 1,
  }
  ipcRenderer.send(TAB_CHANNELS.handoff, result)
})

ipcRenderer.on(TAB_CHANNELS.pause, () => video?.pause())
ipcRenderer.on(TAB_CHANNELS.play, () => void video?.play().catch(() => {}))

const FADE_MS = 200
let fadeTimer = 0

ipcRenderer.on(TAB_CHANNELS.region, (_event, next: RegionBox | null) => {
  clearTimeout(fadeTimer)
  const fade = next === null && regionBox.region !== null && regionBox.frame?.isConnected
  regionBox.auto = next?.auto ?? false
  regionBox.label = next?.label ?? null
  if (regionBox.frame) style(regionBox.frame, { transition: fade ? `opacity ${FADE_MS}ms ease` : '', opacity: fade ? '0' : '', pointerEvents: fade ? 'none' : 'auto' })
  if (fade) {
    fadeTimer = window.setTimeout(() => {
      regionBox.region = null
      place()
    }, FADE_MS)
    return
  }
  regionBox.region = next?.region ?? null
  place()
})

ipcRenderer.on(TAB_CHANNELS.zone, (_event, next: Region | null) => {
  zoneBox.region = next
  place()
})

function start() {
  useVideo(largestVideo())
  let rescanning = false
  const rescan = () => {
    if (rescanning) return
    rescanning = true
    setTimeout(() => {
      rescanning = false
      useVideo(largestVideo())
    }, 300)
  }
  const root = document.documentElement
  if (root) new MutationObserver(rescan).observe(root, { childList: true, subtree: true })
  setInterval(() => useVideo(largestVideo()), 1000)
  setInterval(() => {
    report()
    place()
  }, 500)
  for (const event of ['scroll', 'resize'] as const) {
    window.addEventListener(event, place, true)
  }
  document.addEventListener('fullscreenchange', () => {
    drmNotice?.remove()
    drmNotice = null
    place()
    rescan()
  }, true)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
else start()
