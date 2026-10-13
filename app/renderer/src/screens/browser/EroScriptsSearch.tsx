import { Search, SlidersHorizontal } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import type { EroTopic } from '@shared/eroscripts'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { useBrowser } from '@/state/browser'
import { useT } from '@/state/i18n'
import { eroSearchError, eroSearchUrl, parseEroSearch, searchQueryFromUrl, type EroSearch } from './eroSearch'

const drafts = new Map<number, EroSearch>()

export function EroScriptsSearch({ tabId, url, topic }: { tabId: number; url: string; topic: EroTopic | null }) {
  const t = useT()
  const navigate = useBrowser((state) => state.navigate)
  const [search, setSearch] = useState(() => drafts.get(tabId) ?? parseEroSearch(searchQueryFromUrl(url) ?? ''))
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<ReturnType<typeof eroSearchError>>(null)
  const filtersId = useId()
  const categoriesId = useId()
  useEffect(() => {
    const query = searchQueryFromUrl(url)
    if (query !== null) {
      const next = parseEroSearch(query)
      drafts.set(tabId, next)
      setSearch(next)
      setError(null)
    }
    const tabs = useBrowser.getState().tabs
    for (const id of drafts.keys()) if (!tabs.some((tab) => tab.id === id)) drafts.delete(id)
  }, [url, tabId])
  const update = (patch: Partial<EroSearch>) => {
    const next = { ...search, ...patch }
    drafts.set(tabId, next)
    setSearch(next)
    setError(null)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const issue = eroSearchError(search)
    setError(issue)
    if (!issue) void navigate(eroSearchUrl(search))
    else setExpanded(true)
  }
  return (
    <form className="ero-search" onSubmit={submit} onKeyDown={(event) => {
      if (event.key === 'Escape' && expanded) {
        event.preventDefault()
        event.stopPropagation()
        setExpanded(false)
        event.currentTarget.querySelector<HTMLButtonElement>('.ero-search-row > button')?.focus()
      }
    }}>
      <div className="ero-search-row">
        <label className="ero-query">
          <Search aria-hidden size={15} />
          <input value={search.text} aria-label={t('eroscripts.search')} placeholder={t('eroscripts.search')} onChange={(event) => update({ text: event.target.value })} spellCheck={false} />
        </label>
        <Button aria-expanded={expanded} aria-controls={filtersId} onClick={() => setExpanded(!expanded)}><SlidersHorizontal />{t('eroscripts.filters')}</Button>
        <Button type="submit" variant="primary">{t('eroscripts.searchButton')}</Button>
      </div>
      {expanded && (
        <div id={filtersId} className="ero-filters">
          <Field label={t('eroscripts.category')}>
            <input className="input" value={search.category} list={categoriesId} onChange={(event) => update({ category: event.target.value })} placeholder={t('eroscripts.allCategories')} spellCheck={false} />
            <datalist id={categoriesId}>{topic?.categories?.map((category) => <option key={category.slug} value={category.slug}>{category.name}</option>)}</datalist>
          </Field>
          <Field label={t('eroscripts.tags')}><input className="input" value={search.tags} onChange={(event) => update({ tags: event.target.value })} spellCheck={false} /></Field>
          <Field label={t('eroscripts.tagMatch')}><select className="input" value={search.tagMode} onChange={(event) => update({ tagMode: event.target.value === 'any' ? 'any' : 'all' })}><option value="all">{t('eroscripts.allTags')}</option><option value="any">{t('eroscripts.anyTag')}</option></select></Field>
          <Field label={t('eroscripts.excludeTags')}><input className="input" value={search.excludeTags} onChange={(event) => update({ excludeTags: event.target.value })} spellCheck={false} /></Field>
          <Field label={t('eroscripts.author')}><input className="input" value={search.author} onChange={(event) => update({ author: event.target.value })} spellCheck={false} /></Field>
          <Field label={t('eroscripts.after')}><input className="input" type="date" value={search.after} onChange={(event) => update({ after: event.target.value })} /></Field>
          <Field label={t('eroscripts.before')}><input className="input" type="date" value={search.before} onChange={(event) => update({ before: event.target.value })} /></Field>
          <Field label={t('eroscripts.sort')}><select className="input" value={search.sort} onChange={(event) => update({ sort: event.target.value === 'latest' || event.target.value === 'latest_topic' || event.target.value === 'likes' ? event.target.value : '' })}><option value="">{t('eroscripts.relevance')}</option><option value="latest">{t('eroscripts.latestPost')}</option><option value="latest_topic">{t('eroscripts.latestTopic')}</option><option value="likes">{t('eroscripts.likes')}</option></select></Field>
          <div className="ero-scopes">
            <label><input type="checkbox" checked={search.titleOnly} onChange={(event) => update({ titleOnly: event.target.checked })} />{t('eroscripts.titleOnly')}</label>
            <label><input type="checkbox" checked={search.firstPost} onChange={(event) => update({ firstPost: event.target.checked })} />{t('eroscripts.firstPost')}</label>
          </div>
        </div>
      )}
      {error && <p className="ero-error" role="alert">{t(`eroscripts.invalid.${error}`)}</p>}
    </form>
  )
}
