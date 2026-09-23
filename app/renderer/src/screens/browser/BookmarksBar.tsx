import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, X } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import type { BrowserBookmark } from '@shared/browser'
import { useBrowser } from '@/state/browser'
import { useT } from '@/state/i18n'
import { SiteIcon, siteName } from './StartPage'

export function BookmarksBar({ openSite, onOpenSite }: { openSite: string | null; onOpenSite: (site: string | null) => void }) {
  const t = useT()
  const bookmarks = useBrowser((s) => s.startData?.bookmarks)
  const navigate = useBrowser((s) => s.navigate)
  const open = useBrowser((s) => s.open)
  const toggleBookmark = useBrowser((s) => s.toggleBookmark)
  const groups = useMemo(() => {
    const sites = new Map<string, BrowserBookmark[]>()
    for (const bookmark of bookmarks ?? []) {
      const site = siteName(bookmark.url)
      const entries = sites.get(site) ?? []
      entries.push(bookmark)
      sites.set(site, entries)
    }
    return [...sites].sort(([a], [b]) => a.localeCompare(b)).map(([site, entries]) => ({ site, entries: entries.sort((a, b) => a.title.localeCompare(b.title)) }))
  }, [bookmarks])
  useEffect(() => {
    if (openSite && !groups.some((group) => group.site === openSite)) onOpenSite(null)
  }, [groups, openSite, onOpenSite])
  if (!groups.length) return null
  return (
    <nav className="bbookmarks" aria-label={t('browser.bookmarks.title')}>
      {groups.map(({ site, entries }) => (
        <Popover.Root key={site} open={openSite === site} onOpenChange={(open) => onOpenSite(open ? site : null)}>
          <Popover.Trigger asChild>
            <button type="button" className="bsite"><SiteIcon url={entries[0]?.url ?? ''} /><span>{site}</span><ChevronDown /></button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="bbookmark-menu" align="start" sideOffset={5} collisionPadding={12} aria-label={site}>
              {entries.map((bookmark) => (
                <div className="bbookmark" key={bookmark.url}>
                  <a href={bookmark.url} title={bookmark.url} onClick={(event) => {
                    event.preventDefault()
                    onOpenSite(null)
                    void (event.metaKey || event.ctrlKey ? open(bookmark.url) : navigate(bookmark.url))
                  }} onAuxClick={(event) => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    onOpenSite(null)
                    void open(bookmark.url)
                  }}><SiteIcon url={bookmark.url} /><span>{bookmark.title || bookmark.url}</span></a>
                  <button type="button" aria-label={t('browser.bookmarks.remove', { name: bookmark.title || site })} title={t('browser.addr.removeBookmark')} onClick={() => void toggleBookmark(bookmark.url)}><X /></button>
                </div>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ))}
    </nav>
  )
}
