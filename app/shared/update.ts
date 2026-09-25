export type UpdateState =
  | { status: 'off'; portable: boolean }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'upToDate' }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string; notes: string; bytes: number | null }
  | { status: 'error'; message: string }

export interface ReleaseNotes {
  version: string
  notes: string[]
}

export function parseReleaseNotes(markdown: string): ReleaseNotes[] {
  const releases: ReleaseNotes[] = []
  for (const line of markdown.split('\n')) {
    const version = /^## (\S+)/.exec(line)?.[1]
    const current = releases[releases.length - 1]
    if (version) releases.push({ version, notes: [] })
    else if (line.startsWith('- ') && current) current.notes.push(line.slice(2).trim())
  }
  return releases.filter((release) => release.notes.length > 0)
}
