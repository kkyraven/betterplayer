import { SEARCH_LABELS, type SearchMatch as Match } from '@shared/search'
import { useT } from '@/state/i18n'
import './SearchMatch.css'

export function SearchMatch({ match }: { match?: Match | null }) {
  const t = useT()
  if (match === undefined) return null
  if (match === null) return <div className="media-search-match" aria-hidden />
  const [start, end] = match.ranges[0] ?? [0, 0]
  return (
    <div className="media-search-match" title={`${t(SEARCH_LABELS[match.field])}: ${match.text}`}>
      <span>{t(SEARCH_LABELS[match.field])} · </span>
      {match.text.slice(0, start)}
      {end > start && <mark>{match.text.slice(start, end)}</mark>}
      {match.text.slice(end)}
    </div>
  )
}
