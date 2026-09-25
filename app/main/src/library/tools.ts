import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Tool = 'ffmpeg' | 'ffprobe'

const win32 = process.platform === 'win32'

function fallbackDirs(): string[] {
  if (process.platform === 'linux') return ['/usr/local/bin', '/usr/bin']
  if (!win32) return ['/opt/homebrew/bin', '/usr/local/bin']
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const dirs = [join(local, 'Microsoft', 'WinGet', 'Links'), join(homedir(), 'scoop', 'shims'), join(process.env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin')]
  const packages = join(local, 'Microsoft', 'WinGet', 'Packages')
  try {
    for (const pkg of readdirSync(packages)) {
      if (!pkg.startsWith('Gyan.FFmpeg')) continue
      for (const sub of readdirSync(join(packages, pkg))) {
        const bin = join(packages, pkg, sub, 'bin')
        if (existsSync(bin)) dirs.push(bin)
      }
    }
  } catch {
  }
  return dirs
}
let fallbackCache: string[] | null = null
function fallback(): string[] {
  return (fallbackCache ??= fallbackDirs())
}

export class ToolMissingError extends Error {
  constructor(tool: Tool) {
    super(`${tool} not found on PATH or in ${fallback().join(', ')}`)
  }
}

function brief(stderr: string): string {
  const [line = '', ...rest] = stderr.trim().split('\n')
  const first = line.length > 200 ? `${line.slice(0, 200)}…` : line
  return rest.length > 0 ? `${first} (+${rest.length} lines)` : first
}

function exec(tool: Tool, dir: string | null, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  const file = dir ? join(dir, win32 ? `${tool}.exe` : tool) : tool
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'buffer', signal }, (err, stdout, stderr) => {
      if (signal?.aborted) return reject(signal.reason)
      if (!err) return resolve(stdout)
      if (err.code === 'ENOENT') return reject(new ToolMissingError(tool))
      const why = typeof err.code === 'number' ? `exited with ${err.code}` : err.killed ? `timed out after ${timeoutMs / 1000}s` : err.message
      reject(new Error(`${tool} ${why}${stderr.length > 0 ? `: ${brief(stderr.toString())}` : ''}`))
    })
  })
}

export async function runToolBytes(tool: Tool, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  try {
    return await exec(tool, null, args, timeoutMs, signal)
  } catch (e) {
    if (!(e instanceof ToolMissingError)) throw e
  }
  for (const dir of fallback()) {
    signal?.throwIfAborted()
    if (existsSync(join(dir, win32 ? `${tool}.exe` : tool))) return exec(tool, dir, args, timeoutMs, signal)
  }
  throw new ToolMissingError(tool)
}

export async function runTool(tool: Tool, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return (await runToolBytes(tool, args, timeoutMs, signal)).toString()
}
