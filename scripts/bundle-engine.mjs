#!/usr/bin/env node
import { bundleLinux } from './bundle-linux.mjs'
import { bundleWindowsTools } from './bundle-windows-tools.mjs'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engine = join(root, 'engine')
const out = join(root, 'app', 'resources', 'engine')

const fail = (msg) => {
  console.error(`bundle-engine: ${msg}`)
  process.exit(1)
}
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
const read = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })

const isSystem = (p) => p.startsWith('/usr/lib/') || p.startsWith('/System/')

function loadCommands(file) {
  return read('otool', ['-L', file])
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(' (')[0])
    .filter((p) => p && !isSystem(p) && basename(p) !== basename(file))
}

function rpaths(file) {
  return [...read('otool', ['-l', file]).matchAll(/LC_RPATH[\s\S]*?path (\S+)/g)].map((m) => m[1])
}

function locate(ref, from) {
  if (ref.startsWith('@loader_path/')) return join(dirname(from), ref.slice('@loader_path/'.length))
  if (ref.startsWith('@rpath/')) {
    const rest = ref.slice('@rpath/'.length)
    for (const rp of rpaths(from)) {
      const candidate = join(rp.replace('@loader_path', dirname(from)), rest)
      if (existsSync(candidate)) return candidate
    }
    fail(`cannot resolve ${ref} from ${from}`)
  }
  if (ref.startsWith('@')) fail(`cannot resolve ${ref} from ${from}`)
  return ref
}

function bundleDylibs(addonPath) {
  const root = dirname(addonPath)
  const lib = join(root, 'lib')
  const bin = join(root, 'bin')
  mkdirSync(lib, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const sources = new Map()
  const queue = [[addonPath, addonPath]]
  const executables = new Set([addonPath])
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const source = read('which', [tool]).trim()
    const destination = join(bin, tool)
    copyFileSync(source, destination)
    chmodSync(destination, 0o755)
    executables.add(destination)
    queue.push([destination, source])
  }
  while (queue.length) {
    const [file, origin] = queue.shift()
    const changes = []
    for (const ref of loadCommands(file)) {
      const name = basename(ref)
      if (!sources.has(name)) {
        const src = locate(ref, origin)
        if (!existsSync(src)) fail(`${src} (needed by ${basename(file)}) does not exist`)
        const dest = join(lib, name)
        copyFileSync(src, dest)
        chmodSync(dest, 0o755)
        sources.set(name, src)
        queue.push([dest, src])
      }
      changes.push('-change', ref, `@loader_path/${relative(dirname(file), join(lib, name))}`)
    }
    if (!executables.has(file)) changes.push('-id', `@loader_path/${basename(file)}`)
    if (changes.length) execFileSync('install_name_tool', [...changes, file], { stdio: ['ignore', 'inherit', 'ignore'] })
  }
  for (const f of [...executables, ...[...sources.keys()].map((n) => join(lib, n))]) run('codesign', ['--force', '--sign', '-', f])
  console.log(`bundle-engine: bundled ${sources.size} dylibs`)
}

const suffix = process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : ''
const addon = `bp-engine.${process.platform}-${process.arch}${suffix}.node`
if (!existsSync(join(engine, addon))) fail(`${addon} not found in engine/; run pnpm run build there first`)

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
copyFileSync(join(engine, 'index.js'), join(out, 'index.js'))
copyFileSync(join(engine, addon), join(out, addon))

switch (process.platform) {
  case 'darwin':
    bundleDylibs(join(out, addon))
    break
  case 'win32': {
    bundleWindowsTools(process.env.BP_FFMPEG_DIR, out)
    const dir = process.env.BP_MPV_DIR
    if (!dir) fail('BP_MPV_DIR is not set; point it at the extracted mpv-dev package')
    const dll = join(dir, 'libmpv-2.dll')
    if (!existsSync(dll)) fail(`${dll} not found`)
    copyFileSync(dll, join(out, 'libmpv-2.dll'))
    const dlls = readdirSync(engine).filter((f) => /\.dll$/i.test(f) && f.toLowerCase() !== 'libmpv-2.dll')
    for (const name of ['libEGL.dll', 'libGLESv2.dll']) {
      if (!dlls.some((f) => f.toLowerCase() === name.toLowerCase())) fail(`${name} is not next to the addon in engine/; run scripts/angle-windows.ps1 -Out engine`)
    }
    for (const f of dlls) copyFileSync(join(engine, f), join(out, f))
    console.log(`bundle-engine: bundled ${dlls.join(', ')}`)
    const dlss5 = join(engine, 'dlss5')
    if (existsSync(dlss5)) {
      const skip = /[\\/]ReShade\.(ini|log\d*)$/i
      cpSync(dlss5, join(out, 'dlss5'), { recursive: true, filter: (src) => !skip.test(src) })
      console.log('bundle-engine: bundled dlss5/')
    }
    break
  }
  case 'linux':
    bundleLinux(join(out, addon))
    break
  default:
    fail(`unsupported platform ${process.platform}`)
}

console.log(`bundle-engine: staged ${addon} in ${out}`)
