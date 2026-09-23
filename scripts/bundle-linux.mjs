import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const hostLibrary = /^(?:ld-linux[^/]*|lib(?:c|m|dl|pthread|rt|resolv|util|anl|nss_[^.]+)\.so(?:\.|$)|lib(?:EGL|GL|GLX|GLdispatch|OpenGL|GLESv[12]|vulkan|va(?:-[^.]+)?|drm[^.]*|gbm|nvidia[^.]*)\.so(?:\.|$))/
const ffmpegLibrary = /^lib(?:avutil|avcodec|avformat|avfilter|avdevice|swscale|swresample|postproc)\.so\./
const SYMBOL_PREFIX = 'bp_'
const read = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })

function definedSymbols(file) {
  const data = readFileSync(file)
  const headerAt = Number(data.readBigUInt64LE(0x28))
  const headerSize = data.readUInt16LE(0x3a)
  const sections = Array.from({ length: data.readUInt16LE(0x3c) }, (_, i) => {
    const at = headerAt + i * headerSize
    return { type: data.readUInt32LE(at + 4), offset: Number(data.readBigUInt64LE(at + 0x18)), size: Number(data.readBigUInt64LE(at + 0x20)), link: data.readUInt32LE(at + 0x28) }
  })
  const dynsym = sections.find((s) => s.type === 11)
  if (!dynsym) return []
  const strings = sections[dynsym.link]
  const names = []
  for (let at = dynsym.offset + 24; at < dynsym.offset + dynsym.size; at += 24) {
    const section = data.readUInt16LE(at + 6)
    if (section === 0 || section === 0xfff1) continue
    const nameAt = strings.offset + data.readUInt32LE(at)
    names.push(data.toString('utf8', nameAt, data.indexOf(0, nameAt)))
  }
  return names
}

export function renameFfmpegSymbols(files) {
  const names = new Set(files.filter((f) => ffmpegLibrary.test(basename(f))).flatMap(definedSymbols))
  if (!names.size) throw new Error('No ffmpeg libraries among the bundled Linux files')
  const map = join(tmpdir(), `bp-ffmpeg-symbols-${process.pid}.txt`)
  writeFileSync(map, [...names].map((n) => `${n} ${SYMBOL_PREFIX}${n}\n`).join(''))
  try {
    for (const file of files) execFileSync('patchelf', ['--rename-dynamic-symbols', map, file])
  } finally {
    rmSync(map, { force: true })
  }
  return names.size
}

export function bundleLinux(addon) {
  const root = dirname(addon)
  const lib = join(root, 'lib')
  const bin = join(root, 'bin')
  mkdirSync(lib, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const queue = [[addon, addon]]
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const source = read('which', [tool]).trim()
    const destination = join(bin, tool)
    copyFileSync(source, destination)
    chmodSync(destination, 0o755)
    queue.push([source, destination])
  }
  const copied = new Map()
  for (let i = 0; i < queue.length; i++) {
    const [source, destination] = queue[i]
    const dependencies = read('ldd', [source])
    if (/=> not found/.test(dependencies)) throw new Error(`Unresolved Linux dependency for ${source}:\n${dependencies}`)
    for (const match of dependencies.matchAll(/^\s*(\S+) => (\/[^\n]+?) \(0x[0-9a-f]+\)/gm)) {
      const [, name, path] = match
      if (hostLibrary.test(name)) continue
      const canonicalPath = realpathSync(path)
      if (copied.has(name)) {
        if (copied.get(name) !== canonicalPath) throw new Error(`Conflicting Linux library ${name}: ${canonicalPath} and ${copied.get(name)}`)
        continue
      }
      if (!existsSync(canonicalPath)) throw new Error(`Missing Linux library ${canonicalPath}`)
      const target = join(lib, name)
      copyFileSync(canonicalPath, target)
      chmodSync(target, 0o755)
      copied.set(name, canonicalPath)
      queue.push([canonicalPath, target])
    }
    const rpath = destination === addon ? '$ORIGIN/lib' : dirname(destination) === bin ? '$ORIGIN/../lib' : '$ORIGIN'
    execFileSync('patchelf', ['--force-rpath', '--set-rpath', rpath, destination])
  }
  const symbols = renameFfmpegSymbols(queue.map(([, destination]) => destination))
  console.log(`bundle-engine: bundled ${copied.size} Linux libraries, ffmpeg and ffprobe beside ${basename(addon)}; ${symbols} ffmpeg symbols prefixed`)
}
