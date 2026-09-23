export const ROOT_KINDS = ['folder', 'stash', 'heresphere'] as const
export type RootKind = (typeof ROOT_KINDS)[number]
export type ServerKind = Exclude<RootKind, 'folder'>

export const SERVER_LABELS: Record<ServerKind, string> = { stash: 'Stash', heresphere: 'HereSphere' }

export interface ServerInput {
  url: string
  username: string
  password: string
}

export interface RemoteLoad {
  scriptsPath: string
  headers: string
}

export const isUrl = (path: string) => /^https?:\/\//i.test(path)

export function serverPage(path: string): string | null {
  const m = /^(https?:\/\/[^/]+)(?:\/[^?#]*)?\/scene\/(\d+)\/stream(?:[?#]|$)/i.exec(path)
  return m ? `${m[1]}/scenes/${m[2]}` : null
}
