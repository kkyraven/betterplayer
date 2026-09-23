import { describe, expect, it } from 'vitest'
import { coverRank, looksLikeText } from './scanner'

describe('coverRank', () => {
  it('prefers <stem>.cover.<ext> over <stem>.<ext>', () => {
    expect(coverRank('clip.cover.jpg', 'clip')).toBe(0)
    expect(coverRank('clip.jpg', 'clip')).toBe(1)
    expect(coverRank('clip.PNG', 'clip')).toBe(1)
    expect(coverRank('clip.cover.webp', 'clip')).toBe(0)
  })

  it('ignores other files that share the prefix', () => {
    expect(coverRank('clip2.jpg', 'clip')).toBeNull()
    expect(coverRank('clip.poster.jpg', 'clip')).toBeNull()
    expect(coverRank('clip.funscript', 'clip')).toBeNull()
    expect(coverRank('clip.cover.gif', 'clip')).toBeNull()
  })

  it('handles stems that contain dots', () => {
    expect(coverRank('a.b.jpg', 'a.b')).toBe(1)
    expect(coverRank('a.b.cover.jpg', 'a.b')).toBe(0)
    expect(coverRank('a.jpg', 'a.b')).toBeNull()
  })
})

describe('looksLikeText', () => {
  const packets = (stride: number, count: number) => {
    const out = new Uint8Array(stride * count).fill(0xff)
    for (let i = 0; i < count; i++) out[i * stride] = 0x47
    return out
  }

  it('treats TypeScript source as text', () => {
    expect(looksLikeText(new TextEncoder().encode("export const queue = 'G'.repeat(188)\n"))).toBe(true)
  })

  it('keeps a transport stream of null packets at either stride', () => {
    expect(looksLikeText(packets(188, 3))).toBe(false)
    expect(looksLikeText(packets(192, 3))).toBe(false)
  })

  it('keeps a stream with leading junk, and anything with a NUL byte', () => {
    expect(looksLikeText(new Uint8Array([...new TextEncoder().encode('junk'), ...packets(188, 3)]))).toBe(false)
    expect(looksLikeText(new Uint8Array([0x41, 0x00, 0x42]))).toBe(false)
  })
})
