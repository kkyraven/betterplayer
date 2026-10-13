import { ipcRenderer } from 'electron'
import { ERO_CHANNELS, MAX_TOPIC_SOURCES, explicitMirrorKind, isEroTopicUrl, sourceId, sourceKind, sourceUrl, type EroSource, type EroTopicReport } from '@shared/eroscripts'
import { archivePasswordsForPost } from './archive-passwords'

export function observeEroScripts() {
  if (!process.isMainFrame) return
  let generation = -1
  let pageUrl = ''
  let nextControl = 1
  let timer: ReturnType<typeof setTimeout> | null = null
  let observer: MutationObserver | null = null
  let lastReport = ''
  const tokens = new WeakMap<Element, string>()
  const controls = new Map<string, HTMLAnchorElement>()
  const prepared = new Map<number, { generation: number; control: HTMLAnchorElement; url: string }>()
  const separateAxes = () => {
    try { return localStorage.getItem('discourse-funscript-heatmap-multiaxis_download_format') === '"v1.0"' }
    catch { return true }
  }

  function scan() {
    timer = null
    if (generation < 0 || location.href !== pageUrl || !isEroTopicUrl(pageUrl)) return
    controls.clear()
    const sources: EroSource[] = []
    const seen = new Set<string>()
    const sourceElements = new Map<HTMLAnchorElement, EroSource>()
    for (const cooked of Array.from(document.querySelectorAll('.topic-post .cooked, article .cooked, .crawler-post > .post[itemprop="text"]')).slice(0, 200)) {
      const post = cooked.closest('article, .topic-post, .crawler-post')
      const numberText = post?.getAttribute('data-post-number') ?? post?.querySelector('[data-post-number]')?.getAttribute('data-post-number')
        ?? post?.querySelector('[itemprop="position"]')?.getAttribute('content') ?? post?.querySelector('[itemprop="position"]')?.textContent?.trim()
        ?? /^post_(\d+)$/.exec(post?.id ?? '')?.[1]
      const postNumber = Number(numberText)
      if (!Number.isSafeInteger(postNumber) || postNumber < 1) continue
      for (const link of Array.from(cooked.querySelectorAll<HTMLAnchorElement>('a[href]')).slice(0, 500)) {
        if (sources.length >= MAX_TOPIC_SOURCES) break
        if (link.matches('.funscript-link-container:not(.funscript-link-merged)')) continue
        if (link.closest('.quote, aside.quote, blockquote, .onebox .onebox-avatar, .lightbox, .advertisement, [data-ad-slot]')) continue
        const merged = link.matches('a.funscript-link-container.funscript-link-merged[download]')
          && link.href.startsWith(`blob:${location.origin}/`) && sourceKind(link.download) === 'script'
        if (merged && separateAxes()) continue
        let controlId: string | null = null
        if (merged) {
          const previous = tokens.get(link)
          controlId = previous?.startsWith(`ero-${generation}-`) ? previous : `ero-${generation}-${nextControl++}`
          tokens.set(link, controlId)
          controls.set(controlId, link)
        }
        const url = merged ? pageUrl : sourceUrl(link.getAttribute('href') ?? '', pageUrl)
        if (!url) continue
        let fileName: string | null = null
        const download = link.download.trim()
        const label = (link.innerText || link.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 512)
        const pathName = (() => {
          try {
            const parts = new URL(url).pathname.split('/').map((part) => decodeURIComponent(part))
            return [...parts].reverse().find((part) => sourceKind(part) !== 'unknown') ?? parts.at(-1) ?? ''
          } catch { return '' }
        })()
        for (const candidate of [download, label, pathName]) {
          if (sourceKind(candidate) !== 'unknown' && !/[/\\]/.test(candidate) && candidate.length <= 256) { fileName = candidate; break }
        }
        const kind = merged ? 'script' : sourceKind(fileName ?? pathName)
        const host = new URL(url).hostname
        const fileHost = /^(?:www\.)?(?:pixeldrain\.com|mega\.nz|mega\.co\.nz|gofile\.io|mediafire\.com|dropbox\.com|drive\.google\.com|workupload\.com|catbox\.moe|files\.catbox\.moe|bunkr\.(?:fi|si|site|cr|ru|is|black))$/.test(host)
        const attachment = link.matches('a.attachment, a.funscript-link-container') && kind !== 'unknown'
        if (kind === 'unknown' && !fileHost && !attachment && !/\b(?:download|mirror)\b/i.test(label)) continue
        if (/\b(?:buy|purchase|subscribe|donate|support me|patreon)\b/i.test(label)) continue
        const id = sourceId(postNumber, url, controlId)
        if (seen.has(id)) continue
        seen.add(id)
        const source: EroSource = { id, url, label: label || fileName || host, host, kind, fileName, postNumber, controlId, mirrorKey: null }
        sources.push(source)
        sourceElements.set(link, source)
      }
      let mirrorNumber = 0
      const mirrorBlocks = new Set<Element>()
      for (const block of Array.from(cooked.querySelectorAll('p, h2, h3, h4, strong')).slice(0, 150)) {
        const container = block.matches('strong') && block.parentElement?.matches('p') ? block.parentElement : block
        if (mirrorBlocks.has(container)) continue
        const heading = Array.from(container.childNodes).filter((node) => !(node instanceof Element && node.matches('a'))).map((node) => node.textContent ?? '').join('').trim()
        const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]'))
        if (!links.length && container.nextElementSibling?.matches('ul, ol, p')) links.push(...container.nextElementSibling.querySelectorAll<HTMLAnchorElement>('a[href]'))
        const group = links.map((link) => sourceElements.get(link)).filter((source): source is EroSource => source !== undefined)
        const kind = explicitMirrorKind(heading, group)
        if (!kind || group.length !== links.length) continue
        mirrorBlocks.add(container)
        const mirrorKey = `post-${postNumber}-mirror-${++mirrorNumber}`
        for (const source of group) { source.kind = kind; source.mirrorKey = mirrorKey }
      }
      archivePasswordsForPost(cooked, sourceElements)
    }
    const categories: NonNullable<EroTopicReport['categories']> = []
    for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/c/"], a[href^="https://discuss.eroscripts.com/c/"]')).slice(0, 150)) {
      const slug = new URL(link.href).pathname.split('/')[2] ?? ''
      const name = (link.innerText || link.textContent || '').trim().slice(0, 100)
      if (/^[\w-]+$/.test(slug) && name && !categories.some((category) => category.slug === slug)) categories.push({ slug, name })
    }
    const report: EroTopicReport = {
      generation, url: pageUrl, title: (document.querySelector('#topic-title h1')?.textContent?.trim() || document.title).slice(0, 240),
      sources, scope: 'loaded-posts', categories,
    }
    const serialized = JSON.stringify(report)
    if (serialized === lastReport) return
    lastReport = serialized
    ipcRenderer.send(ERO_CHANNELS.topic, report)
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(scan, 250)
  }

  ipcRenderer.on(ERO_CHANNELS.observe, (_event, state: { generation: number; url: string }) => {
    observer?.disconnect()
    if (timer) clearTimeout(timer)
    timer = null
    controls.clear()
    prepared.clear()
    lastReport = ''
    generation = state.generation
    pageUrl = state.url
    if (!isEroTopicUrl(pageUrl)) return
    observer = new MutationObserver((mutations) => {
      if (mutations.some((change) => change.type === 'childList'
        || (change.target instanceof Element ? change.target : change.target.parentElement)?.closest('.cooked, .crawler-post > .post[itemprop="text"]'))) schedule()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'download', 'data-post-number'], characterData: true })
    scan()
  })

  ipcRenderer.on(ERO_CHANNELS.prepare, (_event, request: { requestId: number; generation: number; controlId: string }) => {
    const control = controls.get(request.controlId)
    if (request.generation !== generation || location.href !== pageUrl || !control?.isConnected
      || !control.closest('.cooked') || !control.matches('a.funscript-link-container.funscript-link-merged[download]')
      || !control.href.startsWith(`blob:${location.origin}/`) || sourceKind(control.download) !== 'script' || separateAxes()) {
      ipcRenderer.send(ERO_CHANNELS.prepared, { requestId: request.requestId, generation, url: null })
      return
    }
    prepared.set(request.requestId, { generation, control, url: control.href })
    ipcRenderer.send(ERO_CHANNELS.prepared, { requestId: request.requestId, generation, url: control.href })
  })

  ipcRenderer.on(ERO_CHANNELS.activate, (_event, request: { requestId: number; generation: number }) => {
    const selected = prepared.get(request.requestId)
    prepared.delete(request.requestId)
    if (!selected || selected.generation !== generation || request.generation !== generation || location.href !== pageUrl
      || !selected.control.isConnected || selected.control.href !== selected.url) return
    selected.control.click()
  })
  ipcRenderer.on(ERO_CHANNELS.hostCancel, (_event, request: { requestId: number }) => prepared.delete(request.requestId))
}
