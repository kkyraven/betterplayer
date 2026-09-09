const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { execFileSync } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const { Engine } = require(process.env.BP_TEST_ENGINE ?? '..')

const script = JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] })

for (const replacement of [false, true]) {
  test(`canceling a running script scan preserves ${replacement ? 'a newer local load' : 'the unloaded player'}`, { skip: process.platform === 'win32' }, async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'bp-load-cancel-'))
    const media = join(dir, 'remote.mp4')
    const pipe = join(dir, 'remote.funscript')
    const fixture = join(__dirname, '../../app/main/src/library/servers/fixtures/preview.mp4')
    fs.copyFileSync(fixture, media)
    execFileSync('mkfifo', [pipe])
    const engine = new Engine(2, 2, Array.from({ length: 3 }, () => new Uint8Array(16)))
    engine.setPresenting(false)
    let writer
    let pending
    try {
      const controller = new AbortController()
      pending = engine.load(media, 0, undefined, undefined, undefined, controller.signal)
        .then(value => ({ value }), error => ({ error }))
      // A writer can open only once the worker is already waiting inside the script scan.
      const deadline = Date.now() + 3000
      while (writer === undefined) {
        try { writer = fs.openSync(pipe, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK) }
        catch (error) {
          if (error.code !== 'ENXIO') throw error
          assert.ok(Date.now() < deadline, 'native script scan did not start')
          await delay(5)
        }
      }
      controller.abort()
      let localScript
      if (replacement) {
        const local = join(dir, 'local.mp4')
        localScript = join(dir, 'local.funscript')
        fs.copyFileSync(fixture, local)
        fs.writeFileSync(localScript, script)
        const info = await engine.load(local, 0)
        assert.equal(info.scripts[0].source, localScript)
      }
      fs.writeSync(writer, script)
      fs.closeSync(writer)
      writer = undefined
      const result = await pending
      assert.equal(result.error?.code, 'Cancelled', 'the aborted scan must reject before loading media or scripts')
      const scripts = engine.selectVariant('L0')
      if (replacement) assert.deepEqual(scripts.map(s => s.source), [localScript])
      else {
        assert.deepEqual(scripts, [])
        assert.equal(engine.state().loaded, false)
      }
    } finally {
      if (writer !== undefined) fs.closeSync(writer)
      if (pending) await pending
      engine.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
