// Run after building the native addon: node --test tests/browser-restim.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createSocket } = require('node:dgram')
const { setTimeout: delay } = require('node:timers/promises')
const { Engine, axes } = require('..')

async function until(check) {
  const deadline = Date.now() + 3000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'engine state did not settle')
    await delay(10)
  }
}

test('browser tracking excludes player scripts and controls the Restim ramp independently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-browser-restim-'))
  const receiver = createSocket('udp4')
  let engine
  try {
    await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve))
    const script = JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] })
    await writeFile(join(dir, 'video.funscript'), script)
    await writeFile(join(dir, 'video.volume.funscript'), script)
    engine = new Engine(2, 2, Array.from({ length: 3 }, () => new Uint8Array(16)))
    engine.setPresenting(false)
    const id = engine.connect({ kind: 'udp', host: '127.0.0.1', port: receiver.address().port, profile: 'restim' })
    await until(() => engine.state().outputs.find((o) => o.id === id)?.status === 'connected')
    await engine.loadScripts(join(dir, 'video.mp4'))
    const index = (axis) => axes().findIndex((a) => a.id === axis)
    const scripted = (axis) => Boolean(engine.state().axisFlags[index(axis)] & 1)
    await until(() => scripted('L0') && scripted('EA') && scripted('EV'))

    engine.setOutputRamp(id, { enabled: true, start: 0.3, max: 1, durationMs: 1000 })
    engine.trackStart(null, null, false)
    await until(() => !scripted('L0') && !scripted('EA') && !scripted('EV'))
    assert.equal(engine.state().paused, true, 'the player stays paused')
    const progress = () => engine.state().outputs.find((o) => o.id === id).ramp
    engine.trackPlayback(25000, true, 1)
    await until(() => progress().elapsedMs > 100)
    assert.ok(progress().value > 0.3, 'browser playback advances the ramp with the player paused')

    engine.trackPlayback(25150, false, 1)
    await delay(40)
    const pausedAt = progress().elapsedMs
    await delay(100)
    assert.equal(progress().elapsedMs, pausedAt, 'pausing the browser freezes the ramp')
    engine.trackPlayback(25150, true, 2)
    await until(() => progress().elapsedMs > pausedAt + 50)

    engine.trackStop()
    await until(() => scripted('L0') && scripted('EA') && scripted('EV'))
    await delay(40)
    const stoppedAt = progress().elapsedMs
    await delay(100)
    assert.equal(progress().elapsedMs, stoppedAt, 'returning to the paused player stops the ramp')
  } finally {
    engine?.close()
    receiver.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Restim sends a two-second volume fade and scales manual volume into adjustable limits', async () => {
  const receiver = createSocket('udp4')
  const volumes = []
  receiver.on('message', (message) => {
    const match = message.toString().match(/(?:^| )V0(\d{4})I/)
    if (match) volumes.push({ at: performance.now(), value: Number(match[1]) })
  })
  let engine
  try {
    await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve))
    engine = new Engine(2, 2, Array.from({ length: 3 }, () => new Uint8Array(16)))
    engine.setPresenting(false)
    const id = engine.connect({ kind: 'udp', host: '127.0.0.1', port: receiver.address().port, profile: 'restim' })
    await until(() => engine.state().outputs.find((o) => o.id === id)?.status === 'connected' && volumes.length > 0)
    assert.equal(volumes.at(-1).value, 0, 'idle connection starts muted')
    assert.equal(engine.estim().volumeFloor, 0.75)
    engine.setLive('EA', 0.8)
    engine.setLive('EV', 0.1)
    const started = performance.now()
    await until(() => volumes.at(-1).value > 0)
    assert.ok(volumes.at(-1).value < 1000, 'start fades up from silence')
    await until(() => volumes.at(-1).value === 7749)
    assert.ok(performance.now() - started >= 1800, 'reaches scaled volume after the two-second fade')
    engine.setEstim({ contrast: 0, params: false, volumeFloor: 0.4 })
    assert.equal(engine.estim().volumeFloor, 0.4)
    await until(() => volumes.at(-1).value === 4600)
    engine.setLive('EA', null)
    engine.setLive('EV', null)
    await until(() => volumes.at(-1).value === 0)
    engine.setLive('EA', 0.8)
    engine.setLive('EV', 0.1)
    await until(() => volumes.at(-1).value > 0)
    assert.ok(volumes.at(-1).value < 1000, 'a new start fades again')
  } finally {
    engine?.close()
    receiver.close()
  }
})

test('Restim boosts beyond normal volume limits only while the chosen axis is driven', async () => {
  const receiver = createSocket('udp4')
  let volume = -1
  receiver.on('message', (message) => {
    const match = message.toString().match(/(?:^| )V0(\d{4})I/)
    if (match) volume = Number(match[1])
  })
  let engine
  try {
    await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve))
    engine = new Engine(2, 2, Array.from({ length: 3 }, () => new Uint8Array(16)))
    engine.setPresenting(false)
    const options = { contrast: 0, params: false, volumeFloor: 0.75, volumeMax: 0.85, volumeBoost: { enabled: true, axis: 'L1', amount: 0.2 } }
    engine.setEstim(options)
    assert.deepEqual(engine.estim(), options)
    const id = engine.connect({ kind: 'udp', host: '127.0.0.1', port: receiver.address().port, profile: 'restim' })
    await until(() => engine.state().outputs.find((o) => o.id === id)?.status === 'connected' && volume === 0)
    engine.setLive('EA', 0.8)
    engine.setLive('EV', 0.5)
    await until(() => volume === 7999)
    engine.setLive('L1', 1)
    await until(() => volume === 9999)
    options.volumeBoost.axis = 'L2'
    engine.setEstim(options)
    await until(() => volume === 7999)
    engine.setLive('L2', 0.5)
    await until(() => volume === 8999)
    engine.setLive('L2', null)
    await until(() => volume === 7999)
    options.volumeBoost.enabled = false
    engine.setEstim(options)
    engine.setLive('L2', 0.5)
    await delay(50)
    assert.equal(volume, 7999, 'disabled boost does not change volume')
    engine.setLive('EV', 0)
    await until(() => volume === 0)
  } finally {
    engine?.close()
    receiver.close()
  }
})
