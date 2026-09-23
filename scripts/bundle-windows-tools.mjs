import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function bundleWindowsTools(source, destination) {
  if (!source) throw new Error('BP_FFMPEG_DIR is not set; run scripts/ffmpeg-windows.ps1 and use the printed package path')
  const bin = join(destination, 'bin')
  const notices = join(destination, 'ffmpeg')
  mkdirSync(bin, { recursive: true })
  mkdirSync(notices, { recursive: true })
  for (const tool of ['ffmpeg.exe', 'ffprobe.exe']) copyFileSync(join(source, 'bin', tool), join(bin, tool))
  for (const name of ['LICENSE', 'README.txt']) copyFileSync(join(source, name), join(notices, name))
}
