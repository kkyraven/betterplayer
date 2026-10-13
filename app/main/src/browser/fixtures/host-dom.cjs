const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function compile(file) {
  return ts.transpileModule(fs.readFileSync(path.resolve(__dirname, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
}
const sharedSource = compile('../../../../shared/eroscripts.ts')
const hostSource = compile('../../../../preload/src/download-host.ts')
const topicSource = compile('../../../../preload/src/eroscripts.ts')
const archivePasswordSource = compile('../../../../shared/archive-passwords.ts')
const archivePostSource = compile('../../../../preload/src/archive-passwords.ts')
const header = '<div class="dl-header"><div class="fileinfo"><div class="filename">test.mp4</div></div><div class="actions"><button id="download"><i class="icon-arrow-down-circle-thin-outline"></i>Download</button></div></div>'
const gofile = '<div class="fm-row" data-id="fixture" data-type="file"><button data-action="open-file"><p>test.mp4</p></button><button id="download" data-action="download">Download</button></div>'
const pixel = '<meta property="og:title" content="test.mp4"><meta property="og:url" content="https://pixeldrain.com/u/fyGa97Ty"><div class="file_viewer"><div class="headerbar"><div class="file_viewer_headerbar_title">test.mp4</div><button id="toggle" title="Open or close the toolbar">Menu</button></div><div class="toolbar toolbar_visible"><button id="download" class="toolbar_button" title="Save this file to your computer">Download</button></div></div>'
const cases = [
  { name: 'Pixeldrain detached native anchor', provider: 'pixeldrain', url: 'https://pixeldrain.com/u/fyGa97Ty', html: pixel, expect: 'complete' },
  { name: 'Pixeldrain closed native toolbar', provider: 'pixeldrain', url: 'https://pixeldrain.com/u/fyGa97Ty', html: pixel.replace('toolbar toolbar_visible', 'toolbar'), expect: 'complete' },
  { name: 'Pixeldrain metadata mismatch', provider: 'pixeldrain', url: 'https://pixeldrain.com/u/fyGa97Ty', html: pixel.replace('content="test.mp4"', 'content="other.mp4"'), expect: 'waiting' },
  { name: 'Pixeldrain CAPTCHA handoff', provider: 'pixeldrain', url: 'https://pixeldrain.com/u/fyGa97Ty', html: pixel.replace('</div></div>', '</div><div class="background" role="dialog"><div class="window" role="dialog" aria-modal="true"><div class="body"><div class="captcha_container">CAPTCHA</div></div></div></div></div>'), expect: 'waiting', reason: 'CAPTCHA' },
  { name: 'MEGA decrypted Blob', provider: 'mega', url: 'https://mega.nz/file/fixture#key', html: header, expect: 'complete' },
  { name: 'MEGA ZIP footer download', provider: 'mega', url: 'https://mega.nz/file/fixture#key', actualFileName: 'test-pack.zip', html: '<div class="download download-page"><div class="dl-header"><div class="fileinfo"><div class="filename">test-pack.zip</div></div><div class="actions"><button><i class="icon-more-vertical-thin-outline"></i>More</button></div></div><div class="nv-container"><div class="footer"><button id="download"><i class="icon-arrow-down-circle-thin-outline"></i>Download</button></div></div></div>', expect: 'complete' },
  { name: 'GoFile single selected file', provider: 'gofile', url: 'https://gofile.io/d/fixture', html: gofile, expect: 'complete' },
  { name: 'MEGA missing key', provider: 'mega', url: 'https://mega.nz/file/fixture', html: '<div class="dl-access-box"><input name="decrypt-link" type="text"></div>', expect: 'waiting', reason: 'file key' },
  { name: 'MEGA quota before action', provider: 'mega', url: 'https://mega.nz/file/fixture#key', html: header + '<div class="limited-bandwidth-dialog">Quota</div>', expect: 'waiting', reason: 'quota' },
  { name: 'MEGA quota after action', provider: 'mega', url: 'https://mega.nz/file/fixture#key', html: header, expect: 'waiting', reason: 'quota', quotaAfter: true },
  { name: 'Wrong filename refused', provider: 'mega', url: 'https://mega.nz/file/fixture#key', html: header, expect: 'waiting', fileName: 'other.mp4' },
  { name: 'Ambiguous GoFile folder', provider: 'gofile', url: 'https://gofile.io/d/fixture', html: gofile + gofile.replaceAll('fixture', 'fixture2').replaceAll('test.mp4', 'other.mp4').replace('id="download"', ''), expect: 'waiting', fileName: null, reason: 'Choose one file' },
  { name: 'Exact named anchor, ad excluded', provider: 'anchor', url: 'https://files.example/page', html: '<div class="advertisement"><a download="test.mp4" href="https://advert.example/test.mp4">Ad</a></div><a id="download" download="test.mp4" href="https://files.example/test.mp4">Download</a>', expect: 'complete' },
  { name: 'Topic posts, replies and creator mirrors', provider: 'topic', url: 'https://discuss.eroscripts.com/t/fixture/123', html: '<aside><a href="https://advert.example/ad.mp4">Advertisement</a><a href="/c/scripts/5">Scripts</a></aside><article id="post_1"><div class="cooked"><p><a class="attachment" href="/uploads/test.funscript">test.funscript</a></p><p>Video mirrors:</p><ul><li><a href="https://mega.nz/file/fixture#key">Mirror 1</a></li><li><a href="https://pixeldrain.com/u/fixture">Mirror 2</a></li></ul></div></article><article id="post_2"><div class="cooked"><a href="https://files.example/reply.funscript">reply.funscript</a></div></article>', expect: 'topic' },
  { name: 'Author ZIP password beside a provider onebox', provider: 'topic', url: 'https://discuss.eroscripts.com/t/fixture/123', html: '<article id="post_1"><div class="cooked"><h3>Script</h3><h4>Get from Pixeldrain</h4><aside class="onebox"><header class="source"><a href="https://pixeldrain.com/u/archive">pixeldrain.com</a></header><article class="onebox-body"><h3><a href="https://pixeldrain.com/u/archive">test-pack.zip</a></h3><p>Provider preview</p></article></aside><h4>Unzip Password</h4><p><font>AuthorTestToken</font></p><h3>Video</h3><p><a href="https://mega.nz/file/video#fixture">Video</a></p></div></article>', expect: 'passwords', password: 'AuthorTestToken', label: 'pixeldrain.com', count: 2 },
  { name: 'Archive password from the same known author', provider: 'topic', url: 'https://discuss.eroscripts.com/t/fixture/123', html: '<article id="post_1"><div class="names"><span class="username"><a data-user-card="ExampleAuthor">ExampleAuthor</a></span></div><div class="cooked"><p><a href="https://files.example/test-pack.zip">test-pack.zip</a></p><p>Archive Password: my username</p><blockquote><p>ZIP Password: QuotedTest</p></blockquote></div></article>', expect: 'passwords', password: 'ExampleAuthor', label: 'test-pack.zip', count: 1 },
  { name: 'Provider preview passwords and replies do not contaminate archives', provider: 'topic', url: 'https://discuss.eroscripts.com/t/fixture/123', html: '<article id="post_1"><div class="cooked"><h3>Script</h3><aside class="onebox"><h3><a href="https://pixeldrain.com/u/archive">test-pack.zip</a></h3><p>Archive Password: ProviderTest</p></aside><aside class="quote"><p>ZIP Password: QuotedTest</p></aside></div></article><article id="post_2"><div class="cooked"><p>Archive Password: ReplyTest</p></div></article>', expect: 'passwords', password: null, label: 'test-pack.zip', count: 1 },
  { name: 'Dedicated code password preserves spaces and quote bytes', provider: 'topic', url: 'https://discuss.eroscripts.com/t/fixture/123', html: '<article id="post_1"><div class="cooked"><p><a href="https://files.example/test-pack.zip">test-pack.zip</a></p><h4>Unzip Password</h4><p><code>  &quot;token&quot;  </code></p></div></article>', expect: 'passwords', password: '  "token"  ', label: 'test-pack.zip', count: 1 },
  { name: 'Inline code archive password preserves its literal value', provider: 'topic', url: 'https://discuss.eroscripts.com/t/fixture/123', html: '<article id="post_1"><div class="cooked"><p><a href="https://files.example/test-pack.zip">test-pack.zip</a></p><p>ZIP Password: <code> &quot;token&quot; </code></p></div></article>', expect: 'passwords', password: ' "token" ', label: 'test-pack.zip', count: 1 },
  { name: 'A quoted password blocks consumption of later prose', provider: 'topic', url: 'https://discuss.eroscripts.com/t/fixture/123', html: '<article id="post_1"><div class="cooked"><p><a href="https://files.example/test-pack.zip">test-pack.zip</a></p><h4>Archive Password</h4><blockquote><p>QuotedToken</p></blockquote><p>Version 2</p></div></article>', expect: 'passwords', password: null, label: 'test-pack.zip', count: 1 },
  { name: 'A login form blocks consumption of later prose', provider: 'topic', url: 'https://discuss.eroscripts.com/t/fixture/123', html: '<article id="post_1"><div class="cooked"><p><a href="https://files.example/test-pack.zip">test-pack.zip</a></p><h4>Archive Password</h4><form><input type="password" value="LoginToken"></form><p>Version 2</p></div></article>', expect: 'passwords', password: null, label: 'test-pack.zip', count: 1 },
  { name: 'Crawler post body keeps archive password and reply boundaries', provider: 'topic', url: 'https://discuss.eroscripts.com/t/fixture/123', html: '<div id="post_1" class="topic-body crawler-post"><div class="crawler-post-meta"><span itemprop="position">1</span></div><div class="post" itemprop="text"><h3>Script</h3><aside class="onebox"><header><a href="https://pixeldrain.com/u/archive">pixeldrain.com</a></header><h3><a href="https://pixeldrain.com/u/archive">test-pack.zip</a></h3></aside><h4>Unzip Password</h4><p>CrawlerToken</p><div class="advertisement"><a href="https://files.example/ad.zip">ad.zip</a></div></div></div><div id="post_2" class="crawler-post"><span itemprop="position">2</span><div class="post" itemprop="text"><p><a href="https://files.example/reply.zip">reply.zip</a></p></div></div>', expect: 'passwords', password: 'CrawlerToken', label: 'pixeldrain.com', count: 2, postNumber: 1 },
  { name: 'Crawler author username uses original metadata and post ID fallback', provider: 'topic', url: 'https://discuss.eroscripts.com/t/fixture/123', html: '<div id="post_4" class="topic-body crawler-post"><div class="crawler-post-meta"><span class="creator" itemprop="author"><span itemprop="name">CrawlerAuthor</span></span></div><div class="post" itemprop="text"><p><a href="https://files.example/test-pack.zip">test-pack.zip</a></p><p>Archive Password: my username</p><blockquote><p>ZIP Password: QuotedToken</p></blockquote></div></div>', expect: 'passwords', password: 'CrawlerAuthor', label: 'test-pack.zip', count: 1, postNumber: 4 },
  { name: 'Adjacent PW code label targets its archive and preserves literal bytes', provider: 'topic', url: 'https://discuss.eroscripts.com/t/fixture/123', html: '<article id="post_1"><div class="cooked"><p>PW: <code>  Token  </code></p><aside class="onebox"><a href="https://files.example/test-pack.zip">test-pack.zip</a></aside><form><p>PW: LoginToken</p></form></div></article>', expect: 'passwords', password: '  Token  ', label: 'test-pack.zip', count: 1 },
]

function bootstrap() {
  const test = window.fixtureCase
  const actualFileName = test.actualFileName ?? 'test.mp4'
  const fakeLocation = new URL(test.url)
  const handlers = new Map()
  const state = { armed: false, captured: false, released: false, clicks: 0, waiting: '', report: null, expectedUrl: null }
  const shared = {}
  new Function('exports', window.parent.sharedSource)(shared)
  const archivePasswords = {}
  new Function('exports', window.parent.archivePasswordSource)(archivePasswords)
  const archivePost = {}
  new Function('require', 'exports', window.parent.archivePostSource)((name) => name === '@shared/archive-passwords' ? archivePasswords : shared, archivePost)
  const channels = shared.ERO_CHANNELS
  const call = (channel, value) => { for (const handler of handlers.get(channel) ?? []) handler({}, value) }
  const ipc = {
    on(channel, handler) { handlers.set(channel, [...(handlers.get(channel) ?? []), handler]) },
    send(channel, value) {
      if (channel === channels.hostPrepared) {
        if (value.status === 'waiting') state.waiting = value.reason
        else { state.armed = true; state.expectedUrl = value.url; call(channels.hostActivate, { requestId: value.requestId }) }
      }
      if (channel === channels.hostDownload) {
        if (!state.armed) throw new Error('A host clicked before attribution was armed')
        state.captured = true
        setTimeout(() => call(channels.hostRelease, { requestId: value.requestId }), 0)
      }
      if (channel === channels.hostWaiting) {
        state.waiting = value.reason
        call(channels.hostCancel, { requestId: value.requestId })
      }
      if (channel === channels.topic) state.report = value
    },
  }
  const exports = {}
  const require = (name) => name === 'electron' ? { ipcRenderer: ipc } : name === './archive-passwords' ? archivePost : shared
  const clock = (callback, delay) => setTimeout(callback, delay >= 8000 ? 25 : delay)
  new Function('require', 'exports', 'process', 'location', 'setTimeout', test.provider === 'topic' ? window.parent.topicSource : window.parent.hostSource)(require, exports, { isMainFrame: true }, fakeLocation, clock)
  if (test.provider === 'topic') {
    exports.observeEroScripts()
    call(channels.observe, { generation: 11, url: test.url })
  } else {
    exports.installDownloadHost()
    const toggle = document.getElementById('toggle')
    if (toggle) toggle.onclick = () => document.querySelector('.toolbar').classList.add('toolbar_visible')
    if (test.provider === 'pixeldrain') {
      const dispatch = HTMLAnchorElement.prototype.dispatchEvent
      HTMLAnchorElement.prototype.dispatchEvent = function(event) {
        if (event.type !== 'click') return dispatch.call(this, event)
        if (!state.armed) throw new Error('Native provider click before attribution')
        state.released = !this.isConnected && this.href === state.expectedUrl && this.download === 'test.mp4'
        event.preventDefault()
        return false
      }
    }
    const button = document.getElementById('download')
    if (button && test.provider !== 'anchor') button.onclick = () => {
      state.clicks++
      if (test.provider === 'pixeldrain') {
        const anchor = document.createElement('a')
        anchor.href = 'https://pixeldrain.com/api/file/fyGa97Ty?download'
        anchor.download = 'test.mp4'
        anchor.dispatchEvent(new MouseEvent('click'))
        return
      }
      if (test.quotaAfter) {
        const quota = document.createElement('div')
        quota.className = 'limited-bandwidth-dialog'
        quota.textContent = 'Quota'
        document.body.append(quota)
        return
      }
      const anchor = document.createElement('a')
      anchor.id = test.provider === 'mega' ? 'dllink' : ''
      anchor.href = test.provider === 'mega' ? 'blob:https://mega.nz/fixture' : 'https://store1.gofile.io/download/web/fixture/test.mp4'
      if (test.provider === 'mega') anchor.download = actualFileName
      anchor.rel = 'noopener'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    }
    document.addEventListener('click', (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!anchor) return
      if (!event.defaultPrevented) {
        if (!state.armed) throw new Error('Unattributed native save')
        state.released = true
      }
      event.preventDefault()
    }, true)
    call(channels.hostPrepare, { requestId: 1, sourceUrl: test.url, fileName: test.fileName === undefined ? actualFileName : test.fileName })
  }
  setTimeout(() => {
    let passed = false
    if (test.expect === 'complete') passed = state.armed && state.released && (test.provider === 'anchor' || test.provider === 'pixeldrain' || state.captured)
    if (test.expect === 'waiting') passed = !!state.waiting && !state.released && (!test.reason || state.waiting.includes(test.reason))
    if (test.expect === 'topic') {
      const sources = state.report?.sources ?? []
      const mirrors = sources.filter((source) => source.mirrorKey === 'post-1-mirror-1')
      passed = sources.length === 4 && mirrors.length === 2 && mirrors.every((source) => source.kind === 'video')
        && sources.some((source) => source.postNumber === 2 && source.kind === 'script')
        && !sources.some((source) => source.host === 'advert.example') && state.report.generation === 11
    }
    if (test.expect === 'passwords') {
      const sources = state.report?.sources ?? []
      const selected = sources.find((source) => source.label === test.label)
      passed = sources.length === test.count && Boolean(selected)
        && JSON.stringify(selected.archivePasswords ?? []) === JSON.stringify(test.password ? [test.password] : [])
        && (test.postNumber === undefined || selected.postNumber === test.postNumber)
        && sources.filter((source) => source !== selected).every((source) => !source.archivePasswords?.length)
    }
    window.parent.postMessage({ fixture: test.name, passed, reason: state.waiting, state }, '*')
  }, 100)
}

const safe = (value) => JSON.stringify(value).replace(/<\//g, '<\\/')
const html = `<!doctype html><html><head><style>body{background:#11151b;color:#ddd;font:14px system-ui;margin:20px}iframe{width:700px;height:160px;border:1px solid #444;margin:5px}li{padding:3px}.pass{color:#80d5a0}.fail{color:#ff8c8c}</style></head><body><h1>Browser preload fixtures</h1><ul id="results"></ul><div id="fixtures"></div><script>
(()=>{window.sharedSource=${safe(sharedSource)};window.hostSource=${safe(hostSource)};window.topicSource=${safe(topicSource)};window.archivePasswordSource=${safe(archivePasswordSource)};window.archivePostSource=${safe(archivePostSource)};
const cases=${safe(cases)};const bootstrap=${bootstrap.toString()};const results=[];
window.addEventListener('message',event=>{if(!event.data.fixture)return;results.push(event.data);const li=document.createElement('li');li.className=event.data.passed?'pass':'fail';li.textContent=(event.data.passed?'PASS ':'FAIL ')+event.data.fixture+(event.data.reason?' / '+event.data.reason:'');document.querySelector('#results').append(li);if(results.length===cases.length)console.log('PRELOAD_FIXTURES '+JSON.stringify(results));});
for(const test of cases){const frame=document.createElement('iframe');frame.srcdoc='<html><head><base href="'+test.url+'"><style>body{font:14px system-ui}button,input,a{display:inline-block;min-height:24px;min-width:30px}div{min-height:20px}</style></head><body>'+test.html+'<script>window.fixtureCase='+JSON.stringify(test)+';('+bootstrap.toString()+')();<'+ '/script></body></html>';document.querySelector('#fixtures').append(frame);}
})();</script></body></html>`
process.stdout.write(html)
