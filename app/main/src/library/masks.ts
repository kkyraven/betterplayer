import { readdir, rm, stat, utimes } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const MASKS_CAP_BYTES = 2 * 1024 ** 3

export interface MaskFolder {
  name: string
  bytes: number
  usedMs: number
}

export function masksOverCap(folders: readonly MaskFolder[], capBytes: number, keep: string): string[] {
  let total = folders.reduce((sum, f) => sum + f.bytes, 0)
  const out: string[] = []
  for (const f of [...folders].sort((a, b) => a.usedMs - b.usedMs)) {
    if (total <= capBytes) break
    if (f.name === keep) continue
    out.push(f.name)
    total -= f.bytes
  }
  return out
}

export async function useMaskDir(root: string, dir: string, capBytes = MASKS_CAP_BYTES): Promise<void> {
  const now = new Date()
  await utimes(dir, now, now).catch(() => undefined)
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const scanned = await Promise.all(
    entries.filter((e) => e.isDirectory()).map(async (e): Promise<MaskFolder | null> => {
      const path = join(root, e.name)
      const files = await readdir(path, { withFileTypes: true }).catch(() => null)
      const used = await stat(path).catch(() => null)
      if (!files || !used) return null
      const sizes = await Promise.all(files.filter((f) => f.isFile()).map((f) => stat(join(path, f.name)).then((s) => s.size, () => 0)))
      return { name: e.name, bytes: sizes.reduce((sum, n) => sum + n, 0), usedMs: used.mtimeMs }
    }),
  )
  const folders = scanned.filter((f) => f !== null)
  const failed: unknown[] = []
  for (const name of masksOverCap(folders, capBytes, basename(dir))) {
    await rm(join(root, name), { recursive: true, force: true }).catch((error: unknown) => failed.push(error))
  }
  if (failed.length > 0) throw new AggregateError(failed, `${failed.length} mask tracks could not be deleted`)
}
