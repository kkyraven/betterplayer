import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function portableDataDir(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string | null {
  const exeDir = env.PORTABLE_EXECUTABLE_DIR
  if (!exeDir) return null
  if (!execPath.toLowerCase().startsWith(tmpdir().toLowerCase())) return null
  return join(exeDir, 'betterplayer')
}
