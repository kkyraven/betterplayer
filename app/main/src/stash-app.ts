import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Library } from './library'

const STASH_UP_TIMEOUT_MS = 60_000
const STASH_POLL_MS = 2_000

async function reachable(base: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(base, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

export async function startStashApp(path: string, library: Library) {
  if (!path || !existsSync(path)) return
  const stashRoots = library.roots().filter((root) => root.kind === 'stash')
  const up = await Promise.all(stashRoots.map((root) => reachable(root.path, 1_500)))
  const down = stashRoots.filter((_, i) => !up[i])
  if (stashRoots.length > 0 && down.length === 0) return
  try {
    const child = process.platform === 'darwin' && path.endsWith('.app')
      ? spawn('open', ['-g', '-a', path], { detached: true, stdio: 'ignore' })
      : spawn(path, [], { cwd: dirname(path), detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', (e) => process.stderr.write(`stash: failed to start ${path}: ${e.message}\n`))
    child.unref()
  } catch (e) {
    process.stderr.write(`stash: failed to start ${path}: ${e instanceof Error ? e.message : String(e)}\n`)
    return
  }
  const deadline = Date.now() + STASH_UP_TIMEOUT_MS
  const pending = new Set(down)
  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STASH_POLL_MS))
    for (const root of pending) {
      if (await reachable(root.path, STASH_POLL_MS)) {
        pending.delete(root)
        library.scan(root.id)
      }
    }
  }
}
