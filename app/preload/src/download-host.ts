import { ipcRenderer } from 'electron'
import { ERO_CHANNELS, sourceKind, sourceUrl } from '@shared/eroscripts'
import { intermediaryDownloadUrl, matchingVideoFileNames, unavailableHostFile } from '@shared/download-host'
import { MEGA_PREPARE_TIMEOUT_MS, megaDownloadName } from '@shared/mega'

interface HostRequest { requestId: number; sourceUrl: string; fileName: string | null; scriptFileNames?: readonly string[] }
interface Selection { request: HostRequest; control: HTMLElement; fileName: string; provider: 'mega' | 'gofile' | 'pixeldrain' | 'anchor'; url: string | null }

export function installDownloadHost() {
  if (!process.isMainFrame) return
  let selected: Selection | null = null
  let active: Selection | null = null
  let captured: { requestId: number; url: string; fileName: string } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let observation: MutationObserver | null = null
  let preparingRequestId: number | null = null
  let monitor: MutationObserver | null = null
  let monitorTimer: ReturnType<typeof setTimeout> | null = null

  const visible = (element: Element) => {
    const style = getComputedStyle(element)
    return element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
      && style.display !== 'none' && style.visibility !== 'hidden'
  }
  const named = (name: string, expected: string | null) => name.length > 0 && name.length <= 256 && !/[/\\\x00-\x1f]/.test(name)
    && sourceKind(name) !== 'unknown' && (expected === null || name === expected)
  const samePage = (original: string) => {
    try {
      const source = new URL(original)
      const current = new URL(location.href)
      if (/^(?:www\.)?mega\.(?:nz|co\.nz|io)$/.test(source.hostname)) {
        if (!/^(?:www\.)?mega\.(?:nz|co\.nz|io)$/.test(current.hostname)) return false
        if (source.hash.startsWith('#P!')) return current.hash === source.hash
        if (source.pathname.startsWith('/folder/') || source.hash.startsWith('#F!')) return current.pathname === source.pathname && current.hash === source.hash
        const handle = /\/file\/([\w-]+)/.exec(source.pathname)?.[1] ?? /^#!([\w-]+)!/.exec(source.hash)?.[1]
        return !!handle && (current.pathname === `/file/${handle}` || current.hash.startsWith(`#!${handle}!`))
      }
      const gofile = /^(?:www\.)?gofile\.io$/
      const pixeldrain = /^(?:www\.)?pixeldrain\.com$/
      if (gofile.test(source.hostname)) {
        if (!gofile.test(current.hostname)) return false
      } else if (pixeldrain.test(source.hostname)) {
        if (!pixeldrain.test(current.hostname)) return false
      } else if (source.origin !== current.origin) return false
      return source.pathname === current.pathname && source.search === current.search
    } catch { return false }
  }
  function stopPrepare() { observation?.disconnect(); observation = null; if (timer) clearTimeout(timer); timer = null }
  function stopMonitor() { monitor?.disconnect(); monitor = null; if (monitorTimer) clearTimeout(monitorTimer); monitorTimer = null }
  function waiting(requestId: number, reason: string) {
    if (preparingRequestId !== requestId) return
    stopPrepare()
    preparingRequestId = null
    ipcRenderer.send(ERO_CHANNELS.hostPrepared, { requestId, status: 'waiting', reason })
  }
  function unavailable(requestId: number) {
    if (preparingRequestId !== requestId) return
    stopPrepare()
    preparingRequestId = null
    ipcRenderer.send(ERO_CHANNELS.hostPrepared, { requestId, status: 'failed', unavailable: true, reason: 'Source is unavailable' })
  }
  function redirect(requestId: number, url: string) {
    if (preparingRequestId !== requestId) return
    stopPrepare()
    preparingRequestId = null
    ipcRenderer.send(ERO_CHANNELS.hostPrepared, { requestId, status: 'redirect', url })
  }
  function ready(selection: Selection) {
    if (preparingRequestId !== selection.request.requestId) return
    stopPrepare()
    preparingRequestId = null
    selected = selection
    ipcRenderer.send(ERO_CHANNELS.hostPrepared, { requestId: selection.request.requestId, status: 'ready', fileName: selection.fileName, url: selection.url, provider: selection.provider })
  }

  ipcRenderer.on(ERO_CHANNELS.hostPrepare, (_event, request: HostRequest) => {
    stopPrepare()
    stopMonitor()
    selected = null
    active = null
    captured = null
    preparingRequestId = request.requestId
    let openedMenu = false
    let revealedLinks: Element | null = null
    function scan() {
      if (preparingRequestId !== request.requestId) return
      if (!samePage(request.sourceUrl)) return waiting(request.requestId, 'The source page changed. Reopen the original link')
      const host = location.hostname
      if (host === 'drive.google.com' && document.title === 'Page not found'
        && /^\/file\/d\/[A-Za-z0-9_-]+(?:\/(?:view|preview))?\/?$/.test(location.pathname)) {
        const error = Array.from(document.querySelectorAll('#outerContainer #innerContainer > div[align="center"] > p.errorMessage'))
          .find(element => visible(element) && unavailableHostFile(host, element.textContent ?? ''))
        if (error) return unavailable(request.requestId)
      }
      if (host === 'keep2porn.net') {
        const article = /^\/(\d+)-[a-z0-9-]+\.html$/i.exec(location.pathname)?.[1]
        if (!article) return
        revealedLinks ??= document.getElementById(article)?.querySelector('.scont.oblozhka > center') ?? null
        const buttons = Array.from(document.querySelectorAll<HTMLElement>('.click_show.linkk2s')).filter(button => button.dataset.id === article && visible(button))
        if (!openedMenu && buttons.length === 1 && buttons[0]) {
          openedMenu = true
          revealedLinks = buttons[0].parentElement
          buttons[0].click()
        }
        const links = Array.from(revealedLinks?.querySelectorAll<HTMLAnchorElement>('.info-discription-link a[href]') ?? []).map(link => intermediaryDownloadUrl(request.sourceUrl, link.href)).filter((url): url is string => url !== null)
        const targets = [...new Set(links)]
        if (targets.length === 1 && targets[0]) return redirect(request.requestId, targets[0])
        return
      }
      if (/^(?:www\.)?(?:k2s|keep2share)\.cc$/.test(host)
        && document.title === 'Keep2Share - This file is no longer available') {
        const error = Array.from(document.querySelectorAll('#wrapper div')).find(element => !element.childElementCount && visible(element) && unavailableHostFile(host, element.textContent ?? ''))
        if (error) return unavailable(request.requestId)
      }
      if (/^(?:www\.)?pixeldrain\.com$/.test(host)) {
        const id = /^\/u\/([A-Za-z0-9]{8})$/.exec(location.pathname)?.[1]
        if (!id) return waiting(request.requestId, 'Choose a single file link on Pixeldrain')
        const step = pixeldrainStep()
        if (step) return waiting(request.requestId, step)
        const fileName = document.querySelector('.file_viewer > .headerbar > .file_viewer_headerbar_title')?.textContent?.trim() ?? ''
        const metaName = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content
        const metaUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content
        let identified = false
        try {
          const canonical = new URL(metaUrl ?? '')
          identified = canonical.protocol === 'https:' && /^(?:www\.)?pixeldrain\.com$/.test(canonical.hostname)
            && canonical.pathname === `/u/${id}` && !canonical.search && !canonical.hash
        } catch { identified = false }
        if (!identified || metaName !== fileName || !named(fileName, request.fileName)) return
        const controls = Array.from(document.querySelectorAll<HTMLElement>('.file_viewer .toolbar.toolbar_visible button.toolbar_button[title="Save this file to your computer"]')).filter((control) => {
          const rect = control.getBoundingClientRect()
          return visible(control) && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
        })
        if (controls.length === 1 && controls[0]) return ready({ request, control: controls[0], fileName, provider: 'pixeldrain', url: new URL(`/api/file/${id}?download`, location.origin).href })
        const toggles = Array.from(document.querySelectorAll<HTMLElement>('.file_viewer > .headerbar button[title="Open or close the toolbar"]')).filter(visible)
        if (!openedMenu && !document.querySelector('.file_viewer .toolbar.toolbar_visible') && toggles.length === 1 && toggles[0]) { openedMenu = true; toggles[0].click() }
        return
      }
      if (/^(?:www\.)?mega\.(?:nz|co\.nz|io)$/.test(host)) {
        const fileName = megaDownloadName(document.querySelector('.dl-header .fileinfo .filename')?.textContent?.trim() ?? '')
        const step = megaStep()
        if (step) return waiting(request.requestId, step)
        const error = document.querySelector('.dl-access-box .file-folder-view h2')
        if (error && visible(error) && unavailableHostFile(host, error.textContent ?? '')) return unavailable(request.requestId)
        const source = new URL(request.sourceUrl)
        if (source.pathname.startsWith('/folder/') || source.hash.startsWith('#F!')) return waiting(request.requestId, 'Choose a single file link from the MEGA folder')
        if (!named(fileName, request.fileName === null ? null : megaDownloadName(request.fileName))) return
        const controls = Array.from(document.querySelectorAll<HTMLElement>('.dl-header .actions button:has(.icon-arrow-down-circle-thin-outline), .context-section button:has(.icon-arrow-down-circle-thin-outline), .download.download-page .nv-container .footer button:has(.icon-arrow-down-circle-thin-outline)')).filter(visible)
        if (controls.length === 1 && controls[0]) return ready({ request, control: controls[0], fileName, provider: 'mega', url: null })
        const menus = Array.from(document.querySelectorAll<HTMLElement>('.dl-header .actions button:has(.icon-more-vertical-thin-outline)')).filter(visible)
        if (!openedMenu && menus.length === 1 && menus[0]) { openedMenu = true; menus[0].click() }
        return
      }
      if (host === 'gofile.io' || host === 'www.gofile.io') {
        const error = document.querySelector('#page h1')
        if (error && visible(error) && unavailableHostFile(host, error.textContent ?? '')) return unavailable(request.requestId)
        const panel = document.querySelector('section.panel')
        if (panel && /cold storage and cannot be downloaded directly/.test(panel.textContent ?? '')) return waiting(request.requestId, 'GoFile has this file in cold storage')
        if (panel && /free downloads are temporarily paused/.test(panel.textContent ?? '')) return waiting(request.requestId, 'GoFile has paused free downloads for this file')
        const rows = Array.from(document.querySelectorAll<HTMLElement>('.fm-row[data-id][data-type="file"]'))
        const matchingNames = matchingVideoFileNames(rows.map(row => row.querySelector('[data-action="open-file"] p')?.textContent?.trim() ?? ''), request.scriptFileNames ?? [])
        const selectedRows = rows.filter(row => row.dataset.selected === 'true')
        const eligible = rows.filter((row) => {
          const name = row.querySelector('[data-action="open-file"] p')?.textContent?.trim() ?? ''
          return named(name, request.fileName) && (request.fileName !== null || rows.length === 1 && !document.querySelector('.fm-row[data-type="folder"]')
            || (selectedRows.length ? row.dataset.selected === 'true' : matchingNames.length === 1 && matchingNames[0] === name))
        })
        if (eligible.length === 1 && eligible[0]) {
          const row = eligible[0]
          const control = row.querySelector<HTMLElement>('button[data-action="download"]')
          const fileName = row.querySelector('[data-action="open-file"] p')?.textContent?.trim() ?? ''
          if (control && visible(control)) return ready({ request, control, fileName, provider: 'gofile', url: null })
        }
        const fileName = document.querySelector('section.panel h1')?.textContent?.trim() ?? ''
        const controls = Array.from(document.querySelectorAll<HTMLElement>('section.panel button[data-action="download"]')).filter(visible)
        if (named(fileName, request.fileName) && controls.length === 1 && controls[0]) return ready({ request, control: controls[0], fileName, provider: 'gofile', url: null })
        if (rows.length > 1 && request.fileName === null) return waiting(request.requestId, 'Choose one file on GoFile, then Continue')
        return
      }
      if (request.fileName !== null) {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[download][href]')).filter((anchor) =>
          visible(anchor) && named(anchor.download, request.fileName) && sourceUrl(anchor.href) !== null
          && !anchor.closest('.advertisement, [data-ad-slot], iframe'))
        if (anchors.length === 1 && anchors[0]) return ready({ request, control: anchors[0], fileName: request.fileName, provider: 'anchor', url: anchors[0].href })
      }
    }
    observation = new MutationObserver(scan)
    observation.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'style', 'href', 'download', 'content', 'data-selected'] })
    const timeout = /^(?:www\.)?mega\.(?:nz|co\.nz|io)$/.test(new URL(request.sourceUrl).hostname) ? MEGA_PREPARE_TIMEOUT_MS : 8_000
    timer = setTimeout(() => waiting(request.requestId, 'A verified download control was not available. Complete the host step, then Continue'), timeout)
    scan()
  })

  ipcRenderer.on(ERO_CHANNELS.hostActivate, (_event, request: { requestId: number }) => {
    if (!selected || selected.request.requestId !== request.requestId) return
    if (!selected.control.isConnected || !samePage(selected.request.sourceUrl)) {
      selected = null
      ipcRenderer.send(ERO_CHANNELS.hostWaiting, { requestId: request.requestId, reason: 'The source page changed. Continue to refresh it' })
      return
    }
    active = selected
    selected = null
    stopMonitor()
    if (active.provider === 'mega' || active.provider === 'pixeldrain') {
      let lastProgress = 0
      let staleError = active.provider === 'mega' ? megaWidget(active.fileName)?.querySelector('.status.error') ?? null : null
      if (staleError && !visible(staleError)) staleError = null
      const staleErrorText = staleError?.textContent
      const check = () => {
        if (!active || active.request.requestId !== request.requestId || !samePage(active.request.sourceUrl)) return
        if (active.provider === 'pixeldrain') {
          const reason = pixeldrainStep()
          if (reason) {
            stopMonitor()
            ipcRenderer.send(ERO_CHANNELS.hostWaiting, { requestId: request.requestId, reason })
          }
          return
        }
        const widget = megaWidget(active.fileName)
        const error = widget?.querySelector('.status.error')
        const reason = megaStep() ?? (error && visible(error) && (error !== staleError || error.textContent !== staleErrorText)
          ? 'The transfer was interrupted' : null)
        if (reason) {
          stopMonitor()
          ipcRenderer.send(ERO_CHANNELS.hostWaiting, { requestId: request.requestId, reason })
          return
        }
        if (error && visible(error)) return
        staleError = null
        if (monitorTimer) { clearTimeout(monitorTimer); monitorTimer = null }
        const width = widget?.querySelector<HTMLElement>('.progress-bar > .bar')?.style.width ?? ''
        const match = /^(\d+(?:\.\d+)?)%$/.exec(width)
        const percent = match ? Number(match[1]) : NaN
        if (percent > lastProgress && percent <= 100) {
          lastProgress = percent
          ipcRenderer.send(ERO_CHANNELS.hostActivity, { requestId: request.requestId, fileName: active.fileName })
        }
      }
      monitor = new MutationObserver(check)
      monitor.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] })
      if (staleError) monitorTimer = setTimeout(() => { staleError = null; monitorTimer = null; check() }, 5_000)
      active.control.click()
      check()
    } else active.control.click()
  })

  function megaWidget(fileName: string): Element | null {
    const widgets = Array.from(document.querySelectorAll('.dl-widget.progress')).filter(widget => visible(widget)
      && megaDownloadName(widget.querySelector('.filename')?.textContent?.trim() ?? '') === fileName)
    return widgets.length === 1 ? widgets[0] ?? null : null
  }

  function megaStep(): string | null {
    const checks = [
      { selector: '.limited-bandwidth-dialog, .quota-dialog.transfer-quota.overquota', reason: 'MEGA reached its transfer quota' },
      { selector: '.quota-dialog.transfer-quota.almost-overquota', reason: 'Confirm MEGA download' },
      { selector: '.megasync-overlay', reason: 'MEGA requires a browser or desktop-app choice' },
      { selector: '.dl-access-box input[name="decrypt-link"][type="text"]', reason: 'MEGA needs the file key' },
      { selector: '.dl-access-box input[name="decrypt-link"][type="password"]', reason: 'MEGA needs the link password' },
    ]
    for (const step of checks) {
      if (Array.from(document.querySelectorAll(step.selector)).some(visible)) return step.reason
    }
    return null
  }

  function pixeldrainStep(): string | null {
    const dialog = Array.from(document.querySelectorAll('.file_viewer .background[role="dialog"] > .window[role="dialog"][aria-modal="true"]')).find(visible)
    if (dialog?.querySelector('.captcha_container')) return 'Complete the Pixeldrain CAPTCHA, then Continue'
    if (dialog?.querySelector(':scope > .header > .title')?.textContent?.trim() === 'Download error') return 'Pixeldrain cannot download this file. Check the source page'
    const preview = document.querySelector('.file_viewer .file_preview')
    if (!preview) return null
    if (preview.querySelector('img.header_image[src="/res/img/slow_down.webp"]')) return 'Pixeldrain reached its download limit'
    const heading = preview.querySelector('h1')?.cloneNode(true)
    if (heading instanceof Element) {
      heading.querySelectorAll('i, .material-icons').forEach((icon) => icon.remove())
      const text = heading.textContent?.trim()
      if (text === 'Download limit reached') return 'Pixeldrain reached its download limit'
      if (text === 'Hotlink protection enabled') return 'Pixeldrain requires a download step on its page'
    }
    if (preview.querySelector('.highlight_yellow')) return 'Pixeldrain requires a CAPTCHA on its page'
    return null
  }

  document.addEventListener('click', (event) => {
    if (!active || !(event.target instanceof Element) || !samePage(active.request.sourceUrl)) return
    const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
    if (!anchor) return
    let permitted = false
    if (active.provider === 'mega') permitted = anchor.id === 'dllink' && anchor.download === active.fileName && anchor.href.startsWith(`blob:${location.origin}/`)
    if (active.provider === 'gofile') {
      try {
        const url = new URL(anchor.href)
        permitted = anchor.parentElement === document.body && anchor.rel === 'noopener' && url.protocol === 'https:'
          && /^(?:[a-z0-9-]+\.)?gofile\.io$/.test(url.hostname) && url.pathname.startsWith('/download/')
          && decodeURIComponent(url.pathname.split('/').at(-1) ?? '') === active.fileName
      } catch { permitted = false }
    }
    if (!permitted) return
    event.preventDefault()
    captured = { requestId: active.request.requestId, url: anchor.href, fileName: active.fileName }
    ipcRenderer.send(ERO_CHANNELS.hostDownload, captured)
  }, true)

  ipcRenderer.on(ERO_CHANNELS.hostRelease, (_event, request: { requestId: number }) => {
    const download = captured
    if (!download || download.requestId !== request.requestId || !active || !samePage(active.request.sourceUrl)) return
    captured = null
    active = null
    stopMonitor()
    const anchor = document.createElement('a')
    anchor.href = download.url
    anchor.download = download.fileName
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  })
  ipcRenderer.on(ERO_CHANNELS.hostCancel, (_event, request: { requestId: number }) => {
    if (active?.request.requestId === request.requestId && active.provider === 'mega') {
      const widget = megaWidget(active.fileName)
      const cancel = widget?.querySelector<HTMLElement>('.content .cols > .actions button:has(.icon-dialog-close-thin)')
      if (cancel && visible(cancel)) cancel.click()
    }
    if (active?.request.requestId === request.requestId) active = null
    if (selected?.request.requestId === request.requestId) selected = null
    if (captured?.requestId === request.requestId) captured = null
    stopMonitor()
    if (preparingRequestId === request.requestId) { stopPrepare(); preparingRequestId = null }
  })
}
