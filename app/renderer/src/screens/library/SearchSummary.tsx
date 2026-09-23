import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'

export function SearchSummary() {
  const t = useT()
  const held = useLibrary((s) => s.searchInfo)
  const query = useLibrary((s) => s.search)
  const total = useLibrary((s) => s.total)
  const loading = useLibrary((s) => s.loading)
  if (!query.trim()) return null
  const info = held?.query === query ? held : null
  return (
    <div className="lib-search-summary" aria-busy={loading}>
      <div className="lib-search-conditions" role="status">
        {info?.error ? <span className="lib-search-error">{info.error}</span> : loading ? <span>{t('library.search.searching')}</span> : <span>{t('library.videos', { count: total })}</span>}
        {info && !info.error && [...new Set(info.conditions)].map((condition) => <span key={condition} className="chip on">{condition}</span>)}
        {info && !info.error && info.corrections.map((c) => <span className="lib-search-correction" key={`${c.from}:${c.to}`}>{c.from} → {c.to}</span>)}
      </div>
      <details>
        <summary>{t('library.search.details')}</summary>
        <div className="lib-search-help">
          <span>{t('library.search.performer')}</span><code>performer:"Name"</code>
          <span>{t('library.sidebar.tags')}</span><code>tag:outdoor -tag:rain</code>
          <span>{t('library.sort.duration')}</span><code>under 20 minutes</code>
          <span>{t('library.sort.rating')}</span><code>rating:&gt;=4</code>
          <span>{t('library.search.exactPhrase')}</span><code>"coast walk"</code>
        </div>
      </details>
    </div>
  )
}
