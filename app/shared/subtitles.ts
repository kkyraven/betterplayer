export const SUBTITLE_EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa'] as const
export type SubtitleExtension = (typeof SUBTITLE_EXTENSIONS)[number]

export function subtitleExtension(path: string): SubtitleExtension | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return SUBTITLE_EXTENSIONS.find((e) => e === ext) ?? null
}

export interface SubtitleTrack {
  path: string
  label: string
}

export interface Cue {
  startMs: number
  endMs: number
  text: string
}

export function sidecarTrack(videoName: string, entry: string, dir: string): SubtitleTrack | null {
  const ext = subtitleExtension(entry)
  if (!ext) return null
  const stem = videoName.slice(0, videoName.lastIndexOf('.'))
  if (!stem || !entry.startsWith(`${stem}.`)) return null
  const rest = entry.slice(stem.length + 1, entry.length - ext.length - 1)
  if (rest !== '' && rest.includes('.')) return null
  return { path: `${dir}${entry}`, label: rest === '' ? 'default' : rest }
}

export function sortTracks(tracks: SubtitleTrack[]): SubtitleTrack[] {
  return [...tracks].sort((a, b) => (a.label === 'default' ? -1 : b.label === 'default' ? 1 : a.label.localeCompare(b.label)))
}

export function parseSubtitles(text: string, ext: SubtitleExtension): Cue[] {
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const cues = ext === 'ass' || ext === 'ssa' ? parseAss(body) : parseSrt(body)
  return cues.filter((c) => c.endMs > c.startMs && c.text.length > 0).sort((a, b) => a.startMs - b.startMs)
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/
const TIME_LINE = new RegExp(`^\\s*${TIME.source}\\s*-->\\s*${TIME.source}`)

function timeMs(h: string | undefined, m: string, s: string, ms: string): number {
  return Number(h ?? 0) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms.padEnd(3, '0'))
}

function parseSrt(body: string): Cue[] {
  const cues: Cue[] = []
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => TIME_LINE.test(l))
    if (at < 0) continue
    const m = TIME_LINE.exec(lines[at] ?? '')
    if (!m) continue
    const [, h1, m1, s1, ms1, h2, m2, s2, ms2] = m
    if (!m1 || !s1 || !ms1 || !m2 || !s2 || !ms2) continue
    const text = cleanText(lines.slice(at + 1).join('\n'))
    cues.push({ startMs: timeMs(h1, m1, s1, ms1), endMs: timeMs(h2, m2, s2, ms2), text })
  }
  return cues
}

function parseAss(body: string): Cue[] {
  const cues: Cue[] = []
  let columns: string[] | null = null
  let inEvents = false
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inEvents = line.toLowerCase() === '[events]'
      continue
    }
    if (!inEvents) continue
    if (line.toLowerCase().startsWith('format:')) {
      columns = line.slice(7).split(',').map((c) => c.trim().toLowerCase())
      continue
    }
    if (!columns || !line.toLowerCase().startsWith('dialogue:')) continue
    const fields = line.slice(9).split(',')
    const textAt = columns.indexOf('text')
    const start = fields[columns.indexOf('start')]
    const end = fields[columns.indexOf('end')]
    if (textAt < 0 || !start || !end) continue
    const text = cleanText(fields.slice(textAt).join(',').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' '))
    cues.push({ startMs: assTime(start), endMs: assTime(end), text })
  }
  return cues
}

function assTime(value: string): number {
  const m = /(\d+):(\d{1,2}):(\d{2})[.:](\d{1,3})/.exec(value.trim())
  if (!m) return 0
  const [, h, min, s, frac] = m
  return timeMs(h, min ?? '0', s ?? '0', frac ?? '0')
}

export function cleanText(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n')
}

export function cueAt(cues: Cue[], timeMs: number): number {
  let lo = 0
  let hi = cues.length - 1
  let last = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const cue = cues[mid]
    if (!cue) break
    if (cue.startMs <= timeMs) {
      last = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  for (let i = last; i >= 0 && i > last - 8; i--) {
    const cue = cues[i]
    if (cue && cue.startMs <= timeMs && timeMs < cue.endMs) return i
  }
  return -1
}
