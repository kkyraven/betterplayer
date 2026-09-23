const assert = require('node:assert/strict')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { setTimeout: delay } = require('node:timers/promises')
const { Engine, beatAnalyseAsync, beatGenerate } = require('..')

test('playback repairs a raw selection and matches editor strokes, including accents and silence', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'bp-beat-strokes-'))
  const rate = 22050
  const samples = new Float32Array(rate * 8)
  for (let beat = 0; beat < 16; beat++) {
    const start = Math.round(beat * rate / 2)
    const amplitude = beat === 8 ? 1 : 0.45
    for (let k = 0; k < rate / 20; k++) {
      const t = k / rate
      samples[start + k] = amplitude * Math.sin(2 * Math.PI * 80 * t) * Math.exp(-t * 30)
    }
  }
  const pcm = Buffer.from(samples.buffer)
  const raw = join(dir, 'audio.f32')
  fs.writeFileSync(raw, pcm)
  const media = join(__dirname, '../../app/main/src/library/servers/fixtures/preview.mp4')
  const engine = new Engine(2, 2, Array.from({ length: 3 }, () => new Uint8Array(16)))
  engine.setPresenting(false)
  const waitForBeats = async () => {
    const until = Date.now() + 5000
    while (engine.beatState().status === 'analysing') {
      assert.ok(Date.now() < until, 'audio analysis must finish')
      await delay(10)
    }
    assert.equal(engine.beatState().status, 'ready')
  }
  try {
    await engine.load(media, 0)
    const axes = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2'].map(axis => ({ axis, source: axis === 'L0' ? 'beat' : 'off', intensity: 1, min: 0.1, max: 0.9, smoothingMs: 0, invert: false }))
    engine.trackStart({ flourishes: true }, axes, false)
    engine.setBeatOptions({ style: 'raw', volumeDepth: false, tempoFactor: 1 })
    engine.beatLoad(raw)
    await waitForBeats()
    assert.equal(engine.beatState().style, 'strokes')
    const track = await beatAnalyseAsync(raw)
    const options = { style: 'strokes', volumeDepth: false, flourishes: true, min: 10, max: 90, fps: engine.videoFps() || 60 }
    const editor = beatGenerate(track, options)
    const plain = beatGenerate(track, { ...options, flourishes: false })
    assert.ok(editor.length > plain.length, 'the loud accent must bounce')
    const bounceStart = editor.findIndex((p, i) => p.pos === 10 && editor[i + 1]?.pos === 23 && editor[i + 2]?.pos === 10)
    assert.ok(bounceStart >= 0, 'the bounce keeps its one-sixth depth')
    assert.equal(editor[bounceStart + 2].at - editor[bounceStart].at, 16, 'the small bounce must be fast')
    const exported = await engine.generate()
    assert.deepEqual(JSON.parse(exported.find(s => s.axis === 'L0').json).actions, editor)
    for (let i = 1; i < editor.length; i++) {
      const previous = editor[i - 1]
      const next = editor[i]
      assert.ok(next.at > previous.at)
      const speedLimit = i === bounceStart + 1 || i === bounceStart + 2 ? 1800 : 600
      assert.ok(Math.abs(next.pos - previous.pos) * 1000 / (next.at - previous.at) <= speedLimit + 1e-8)
    }
    assert.ok(beatGenerate(track, { style: 'raw' }).every(p => p.pos === 0))
    engine.setBeatOptions({ style: 'strokes', volumeDepth: false, tempoFactor: 1, bounce: false })
    const withoutBounce = await engine.generate()
    assert.deepEqual(JSON.parse(withoutBounce.find(s => s.axis === 'L0').json).actions, plain)
    for (const custom of [{ bounceDepth: 0.1, bounceSpeed: 0.5 }, { bounceDepth: 0.5, bounceSpeed: 6 }, { bounceDepth: 1, bounceSpeed: 0.5 }]) {
      engine.setBeatOptions({ style: 'strokes', volumeDepth: false, tempoFactor: 1, bounce: true, ...custom })
      const adjusted = await engine.generate()
      const expected = beatGenerate(track, { ...options, ...custom })
      if (custom.bounceDepth === 1) assert.deepEqual(expected, plain, 'skip a bounce that cannot fit before the next peak')
      else assert.notDeepEqual(expected, editor, 'custom depth and speed must change the generated bounce')
      assert.deepEqual(JSON.parse(adjusted.find(s => s.axis === 'L0').json).actions, expected)
    }
    engine.setBeatOptions({ style: 'strokes', volumeDepth: false, tempoFactor: 1, bounce: true })
    for (const intensity of [0.5, 1, 2]) {
      engine.setTrackAxes(axes.map(axis => axis.axis === 'R0' ? { ...axis, source: 'beat', intensity } : axis))
      const scripts = await engine.generate()
      assert.deepEqual(JSON.parse(scripts.find(s => s.axis === 'L0').json).actions, editor, 'Twist speed must not change the stroke')
      assert.deepEqual(JSON.parse(scripts.find(s => s.axis === 'R0').json).actions, beatGenerate(track, { ...options, alternate: true, tempoFactor: intensity }))
    }
    const silence = join(dir, 'silence.f32')
    const complete = await engine.generate()
    const token = engine.beatWindowBegin(true)
    assert.equal(engine.beatState().status, 'analysing')
    assert.equal(engine.beatState().fullStatus, 'ready')
    assert.equal(engine.beatSetWindow({ ...track, beats: [500, 1000, 1500], loudness: [0.5, 0.5, 0.5] }, 1_740_000, token, false), true)
    assert.equal(engine.beatState().beats, 3)
    assert.deepEqual(await engine.generate(), complete, 'a playback window must never truncate full-file export')
    const newer = engine.beatWindowBegin(false)
    assert.equal(engine.beatSetWindow(track, 0, token, true), false, 'an older seek cannot overwrite the window')
    engine.beatWindowError(token, 'stale error')
    assert.equal(engine.beatState().status, 'ready')
    assert.equal(engine.beatSetWindow({ ...track, beats: [], loudness: [], envelope: [], onset: [] }, 1_752_000, newer, true), true)
    assert.equal(engine.beatState().beats, 0)
    assert.deepEqual(await engine.generate(), complete, 'a silent playback window also leaves export intact')
    engine.beatClear()
    fs.writeFileSync(silence, Buffer.alloc(rate * 4))
    engine.beatLoad(silence)
    await waitForBeats()
    assert.equal(engine.beatState().beats, 0)
    assert.deepEqual(await engine.generate(), [])
    const beforeLoad = engine.beatWindowBegin(true)
    await engine.load(media, 0)
    assert.equal(engine.beatSetWindow(track, 0, beforeLoad, false), false)
    const beforeUnload = engine.beatWindowBegin(true)
    engine.unload()
    assert.equal(engine.beatSetWindow(track, 0, beforeUnload, false), false)
  } finally {
    engine.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
