const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-native-host-'))
app.setPath('userData', path.join(scratch, 'profile'))
function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  new Function('require', 'exports', code)((name) => dependencies[name] ?? require(name), exports)
  return exports
}
const shared = load(path.resolve(__dirname, '../../../../shared/eroscripts.ts'))
const { BrowserDownloads } = load(path.resolve(__dirname, '../downloads.ts'), { '@shared/eroscripts': shared })
const url = 'https://mega.nz/file/localFixture#localFixture'
const filename = 'mega-calibration.funscript'
const html = `<html><body><div class="dl-header"><div class="fileinfo"><span class="filename">${filename}</span></div><div class="actions"><button onclick="setTimeout(()=>{const a=document.createElement('a');a.id='dllink';a.download='${filename}';a.href=window.URL.createObjectURL(new Blob([JSON.stringify({version:'2.0',actions:[{at:0,pos:0},{at:1000,pos:100}]})],{type:'application/json'}));document.body.append(a);a.click();a.remove();},1000)"><i class="icon-arrow-down-circle-thin-outline"></i>Download</button></div></div></body></html>`
app.whenReady().then(async () => {
  const browserSession = session.fromPartition('native-host-fixture')
  browserSession.protocol.handle('https', () => new Response(html, { headers: { 'Content-Type': 'text/html' } }))
  const win = new BrowserWindow({ show: false, webPreferences: { partition: 'native-host-fixture', contextIsolation: true, sandbox: true, preload: path.resolve(__dirname, '../../../../out/preload/browser.js') } })
  const wc = win.webContents
  wc.on('console-message', (_event, level, message) => console.log('PAGE', level, message))
  for (const channel of [shared.ERO_CHANNELS.hostPrepared, shared.ERO_CHANNELS.hostDownload, shared.ERO_CHANNELS.hostWaiting]) {
    ipcMain.on(channel, (event, payload) => console.log('IPC', channel, event.sender.id, event.senderFrame === wc.mainFrame, payload))
  }
  const downloads = new BrowserDownloads(browserSession, ipcMain, {
    topic: () => null, contents: () => wc, openRelated: () => ({ id: 1 }), openTransfer: () => ({ id: 1 }), activate: () => {},
    ordinaryDownload: (item) => { console.log('ORDINARY', item.getURLChain()); item.cancel() },
  })
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    console.log('REQUEST', details.id, details.url, details.webContentsId)
    callback(downloads.allowRequest(details) ? {} : { cancel: true })
  })
  browserSession.on('will-download', (_event, item, contents) => console.log('NATIVE', contents?.id, item.getURLChain(), item.getFilename()))
  const loaded = new Promise(resolve => wc.once('did-stop-loading', resolve))
  await win.loadURL(url)
  await loaded
  const controller = new AbortController()
  const timeout = setTimeout(() => { console.log('TIMEOUT'); controller.abort() }, 8_000)
  const staging = path.join(scratch, '.bp-downloads-00000000-0000-0000-0000-000000000001', 'file.part')
  fs.mkdirSync(path.dirname(staging), { recursive: true })
  const result = await downloads.start({
    attemptId: 'test-attempt', fileId: 'test-file', batchId: '00000000-0000-0000-0000-000000000001',
    topic: { tabId: 1, generation: 1, url: 'https://discuss.eroscripts.com/t/fixture/123' },
    candidate: { id: 'source', url, host: 'mega.nz', label: filename, fileName: filename, kind: 'script', postNumber: 1, controlId: null, mirrorKey: null },
    directUrl: null, stagingPath: staging, signal: controller.signal,
    onProgress: (progress) => console.log('PROGRESS', progress), onControl: () => {},
  })
  clearTimeout(timeout)
  console.log('RESULT', JSON.stringify(result))
  if (result.status === 'complete') console.log('BYTES', fs.readFileSync(staging, 'utf8'))
  downloads.destroy()
  win.destroy()
  app.exit(result.status === 'complete' ? 0 : 1)
})
