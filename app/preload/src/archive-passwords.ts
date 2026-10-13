import { findArchivePasswords, type ArchivePasswordBlock } from '@shared/archive-passwords'
import type { EroSource } from '@shared/eroscripts'

const EXCLUDED = '.quote, aside.quote, blockquote, .advertisement, [data-ad-slot], form'
const BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, pre, td, th, .onebox'

export function archivePasswordsForPost(cooked: Element, sourceElements: ReadonlyMap<HTMLAnchorElement, EroSource>): void {
  const sources = [...sourceElements].filter(([link]) => cooked.contains(link)).map(([, source]) => source)
  if (!sources.length) return
  const blocks: ArchivePasswordBlock[] = []
  let lastExcluded: Element | null = null
  for (const element of Array.from(cooked.querySelectorAll(`${BLOCKS}, ${EXCLUDED}`)).slice(0, 1000)) {
    const excluded = element.closest(EXCLUDED)
    if (excluded) {
      if (lastExcluded !== excluded) blocks.push({ text: '', kind: 'text', excluded: true })
      lastExcluded = excluded
      continue
    }
    lastExcluded = null
    if (element.matches('li, td, th') && element.querySelector(BLOCKS)) continue
    const preview = element.closest('.onebox')
    if (preview && preview !== element) continue
    const clone = element.cloneNode(true)
    if (!(clone instanceof Element)) continue
    for (const excluded of clone.querySelectorAll(`${EXCLUDED}, .onebox`)) excluded.remove()
    const onebox = preview !== null
    const heading = onebox ? null : /^H([1-6])$/.exec(element.tagName)
    const codes = clone.querySelectorAll('code')
    const code = codes.length === 1 ? codes[0] : undefined
    const literal = code?.textContent ?? undefined
    const onlyCode = code !== undefined && clone.textContent?.trim() === literal?.trim()
    const kind = heading ? 'heading' : element.matches('pre') || onlyCode ? 'code' : 'text'
    if (code && kind !== 'code' && !onlyCode) code.remove()
    const sourceIds = Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .filter((link) => !link.closest(EXCLUDED)).map((link) => sourceElements.get(link)?.id)
      .filter((id): id is string => id !== undefined)
    blocks.push({
      text: onebox ? '' : (kind === 'code' && literal !== undefined ? literal : clone.textContent ?? '').slice(0, 4096),
      kind, ...(literal !== undefined && kind !== 'code' && !onlyCode && !onebox ? { literalValue: literal.slice(0, 4096) } : {}),
      ...(heading ? { headingLevel: Number(heading[1]) } : {}), sourceIds,
    })
  }
  const post = cooked.closest('article, .topic-post, .crawler-post')
  const author = post?.querySelector('.names .username [data-user-card], .names .username a, .names a[data-user-card], .creator[itemprop="author"] [itemprop="name"]')
  const authorUsername = author?.getAttribute('data-user-card') ?? author?.textContent?.trim()
  for (const hint of findArchivePasswords({ authorUsername, blocks }, sources)) {
    const source = sources.find((candidate) => candidate.id === hint.sourceId)
    if (source && hint.candidates.length) source.archivePasswords = hint.candidates
  }
}
