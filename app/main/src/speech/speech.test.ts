import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpeechEar, SpeechVoice } from './engine'
import { Speech } from './index'

const CHUNK = 1600
const LOUD = 1000

function fakeEar(): SpeechEar {
  let left: number[] = []
  return {
    vad: async (pcm) => {
      left.push(...pcm)
      const probs: number[] = []
      while (left.length >= 512) {
        probs.push(Math.abs(left[0]!) >= LOUD ? 0.9 : 0.05)
        left = left.slice(512)
      }
      return Float32Array.from(probs)
    },
    reset: async () => { left = [] },
  }
}

function fakeVoice(text: () => string, hold = false) {
  const calls: { pcm: Int16Array; prompt: string }[] = []
  const pending: (() => void)[] = []
  const engine: SpeechVoice = {
    transcribe: (pcm, prompt) => {
      calls.push({ pcm, prompt })
      return hold ? new Promise((done) => pending.push(() => done(text()))) : Promise.resolve(text())
    },
  }
  return { engine, calls, release: () => pending.splice(0).forEach((done) => done()) }
}

const chunk = (value: number) => new Int16Array(CHUNK).fill(value)

function setup(text = 'VR under twenty minutes', hold = false) {
  let clock = 0
  const voice = fakeVoice(() => text, hold)
  const corrections = vi.fn(async () => [{ from: 'lighthose', to: 'lighthouse' }])
  const speech = new Speech({
    ear: fakeEar(),
    voice: voice.engine,
    vocabulary: () => ({ tags: ['Beach'], prompt: 'Beach, VR' }),
    corrections,
    replyPrompt: async () => 'red, Vale',
    now: () => clock,
  })
  let seq = 0
  const say = async (ms: number, value: number, session = 's1') => {
    let reply = null
    for (let t = 0; t < ms; t += 100) {
      clock += 100
      reply = await speech.chunk(session, seq++, chunk(value))
    }
    return reply!
  }
  return { speech, voice, corrections, say, chunks: () => seq++ }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a reply to the AI Dom', () => {
  it('keeps the words as said, makes no chips, and primes Whisper with the safeword', async () => {
    const { speech, voice, corrections, chunks } = setup('Please, slow down.')
    for (let i = 0; i < 12; i++) await speech.chunk('r1', chunks(), chunk(LOUD), 'reply')
    const final = await speech.end('r1')
    expect(final).toEqual({ words: [{ text: 'Please,', filter: false }, { text: 'slow', filter: false }, { text: 'down.', filter: false }], chips: [], text: 'Please, slow down.' })
    expect(voice.calls.at(-1)?.prompt).toBe('red, Vale')
    expect(corrections).not.toHaveBeenCalled()
  })

  it('leaves a search as it was', async () => {
    const { speech, say } = setup()
    await say(1000, LOUD)
    expect((await speech.end('s1')).text).toBeUndefined()
  })
})

describe('Speech', () => {
  it('shows live words while talking, ends on the pause, and answers chips', async () => {
    const { speech, voice, say } = setup()
    expect((await say(500, 0)).end).toBe('none')
    expect(voice.calls).toHaveLength(0)
    const talking = await say(1000, LOUD)
    expect(talking.end).toBe('none')
    expect(talking.words).toEqual([
      { text: 'VR', filter: true }, { text: 'under', filter: true }, { text: '20', filter: true }, { text: 'minutes', filter: true },
    ])
    const first = voice.calls[0]!
    expect(first.prompt).toBe('Beach, VR')
    expect([first.pcm[4607], first.pcm[4608]]).toEqual([0, LOUD])
    const ended = await say(1000, 0)
    expect(ended.end).toBe('speech')
    const final = await speech.end('s1')
    expect(final.chips).toEqual([{ id: 'v0', kind: 'vr', label: 'VR' }, { id: 'v1', kind: 'under', label: 'Under 20 minutes', n: 20 }])
    expect(final.words.every((w) => w.filter)).toBe(true)
  })

  it('re-transcribes at most every 500 ms and never while busy, without making a chunk wait', async () => {
    const { voice, say } = setup('beach', true)
    await say(300, 0)
    await say(300, LOUD)
    expect(voice.calls).toHaveLength(1)
    const reply = await say(1000, LOUD)
    expect(reply).toEqual({ words: [], end: 'none' })
    expect(voice.calls).toHaveLength(1)
    voice.release()
    await Promise.resolve()
    await say(100, LOUD)
    expect(voice.calls).toHaveLength(2)
    voice.release()
    expect((await say(100, LOUD)).words).toEqual([{ text: 'beach', filter: true }])
    expect(voice.calls).toHaveLength(2)
  })

  it('is silent when nobody speaks, and the end hears nothing', async () => {
    const { speech, voice, say } = setup()
    expect((await say(5900, 0)).end).toBe('none')
    expect((await say(200, 0)).end).toBe('silent')
    expect(await speech.end('s1')).toEqual({ words: [], chips: [] })
    expect(voice.calls).toHaveLength(0)
  })

  it('offers alts for text it is unsure of', async () => {
    const { speech, corrections, say } = setup('lighthose')
    await say(600, LOUD)
    const final = await speech.end('s1')
    expect(corrections).toHaveBeenCalledOnce()
    expect(final.chips).toEqual([{ id: 'v0', kind: 'text', label: 'lighthose', unsure: true, alts: [{ kind: 'text', label: 'lighthouse' }] }])
  })

  it('takes chunks in seq order whatever order they arrive in', async () => {
    const { speech, voice } = setup()
    await speech.chunk('s1', 0, chunk(LOUD))
    const late = speech.chunk('s1', 2, chunk(3000))
    await speech.chunk('s1', 1, chunk(2000))
    await late
    await speech.chunk('s1', 3, chunk(LOUD))
    const final = speech.end('s1')
    await final
    const pcm = voice.calls.at(-1)!.pcm
    expect([pcm[0], pcm[CHUNK], pcm[2 * CHUNK], pcm[3 * CHUNK]]).toEqual([LOUD, 2000, 3000, LOUD])
  })

  it('lets one session listen at a time; cancel and the 15 s drop end it', async () => {
    vi.useFakeTimers()
    const { speech, say } = setup()
    await say(300, LOUD, 'old')
    await speech.chunk('new', 0, chunk(LOUD))
    expect(await speech.chunk('old', 9, chunk(LOUD))).toEqual({ words: [], end: 'silent' })
    expect(await speech.end('old')).toEqual({ words: [], chips: [] })
    speech.cancel('new')
    expect((await speech.chunk('new', 1, chunk(LOUD))).end).toBe('silent')
    await speech.chunk('later', 0, chunk(LOUD))
    vi.advanceTimersByTime(15_000)
    expect((await speech.chunk('later', 1, chunk(LOUD))).end).toBe('silent')
  })

  it('ends a listen when the model fails, so the next one tries again', async () => {
    const speech = new Speech({
      ear: { ...fakeEar(), reset: () => Promise.reject(new Error('no model')) },
      voice: fakeVoice(() => '').engine,
      vocabulary: () => ({ tags: [], prompt: '' }),
      corrections: async () => [],
      replyPrompt: async () => '',
    })
    await expect(speech.chunk('s1', 0, chunk(0))).rejects.toThrow('no model')
    expect((await speech.chunk('s1', 1, chunk(0))).end).toBe('silent')
  })
})
