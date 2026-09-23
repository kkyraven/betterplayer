import type { Upscaler } from '@shared/settings'
import * as client from './client'

type VideoPlayer = InstanceType<(typeof import('bp-engine'))['VideoPlayer']>

export class Side {
  private readonly player: VideoPlayer
  private buffers: Uint8Array[]
  private width: number
  private height: number

  constructor(path: string, startSeconds: number) {
    this.width = client.width
    this.height = client.height
    this.buffers = client.makeBuffers(this.width, this.height)
    this.player = client.createVideoPlayer(this.width, this.height, this.buffers)
    this.player.load(path, startSeconds)
  }

  resize(w: number, h: number) {
    if (w === this.width && h === this.height) return
    const buffers = client.makeBuffers(w, h)
    this.player.resize(w, h, buffers)
    this.width = w
    this.height = h
    this.buffers = buffers
  }

  acquireFrame(): Uint8Array | null {
    const index = this.player.acquire()
    return index >= 0 ? (this.buffers[index] ?? null) : null
  }

  setUpscaler(upscaler: Upscaler) {
    this.player.setEnhance({ upscaler })
  }

  play() {
    this.player.play()
  }

  pause() {
    this.player.pause()
  }

  seek(seconds: number) {
    try {
      this.player.seek(seconds)
    } catch (e) {
      console.debug(`side seek: ${String(e)}`)
    }
  }

  setRate(rate: number) {
    this.player.setRate(rate)
  }

  timePos(): number {
    return this.player.timePos()
  }

  setPresenting(on: boolean) {
    this.player.setPresenting(on)
  }

  close() {
    this.player.close()
  }
}

export let side: Side | null = null

export function setSide(next: Side | null) {
  side = next
}
