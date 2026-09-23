const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { Engine } = require(process.env.BP_TEST_ENGINE ?? '..')

const media = readFileSync(join(__dirname, '../../app/main/src/library/servers/fixtures/preview.mp4'))

async function fixture(run) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ path: req.url, referer: req.headers.referer })
    if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><head><title>Fixture</title></head><body><video src="/video.mp4"></video></body></html>')
    } else if (req.url === '/invalid') {
      setTimeout(() => { res.writeHead(403); res.end('Denied') }, 100)
    } else {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': media.length })
      res.end(media)
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`, requests) }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}

function player(mpvOptions) {
  return new Engine(64, 64, Array.from({ length: 3 }, () => new Uint8Array(64 * 64 * 4)), { mpvOptions })
}

async function firstFrame(engine) {
  const deadline = Date.now() + 10_000
  engine.play()
  while (engine.acquire() < 0 || engine.state().videoWidth === 0) {
    assert.equal(engine.state().error, undefined)
    assert.ok(Date.now() < deadline, 'video did not produce a frame')
    await delay(5)
  }
}

test('direct browser media forwards Referer and reports a delayed load failure through state', async () => {
  await fixture(async (base, requests) => {
    const engine = player()
    try {
      await engine.load(`${base}/video.mp4`, 0, undefined, undefined, `Referer: ${base}/page`)
      await firstFrame(engine)
      assert.ok(requests.some(req => req.path === '/video.mp4' && req.referer === `${base}/page`))
      await engine.load(`${base}/invalid`, 0, undefined, undefined, '')
      assert.equal(engine.state().error, undefined, 'load resolves before the HTTP response')
      const deadline = Date.now() + 3000
      while (!engine.state().error) {
        assert.ok(Date.now() < deadline, 'HTTP failure was not reported')
        await delay(5)
      }
      await engine.load(`${base}/video.mp4`, 0, undefined, undefined, '')
      assert.equal(engine.state().error, undefined, 'a replacement clears the previous failure')
    } finally { engine.close() }
  })
})

test('a page URL still uses yt-dlp after a direct browser media load', { skip: !process.env.BP_TEST_YTDLP }, async () => {
  await fixture(async (base, requests) => {
    const engine = player({ ytdl: 'yes', 'script-opts': `ytdl_hook-ytdl_path=${process.env.BP_TEST_YTDLP}` })
    try {
      await engine.load(`${base}/video.mp4`, 0, undefined, undefined, '')
      await firstFrame(engine)
      engine.unload()
      await delay(100)
      while (engine.acquire() >= 0) {}
      requests.length = 0
      await engine.load(`${base}/page`, 0)
      await firstFrame(engine)
      assert.ok(requests.some(req => req.path === '/page'))
      assert.ok(requests.some(req => req.path === '/video.mp4'), 'the page extractor must resolve its video')
    } finally { engine.close() }
  })
})
