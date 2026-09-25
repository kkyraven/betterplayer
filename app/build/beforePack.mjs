import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' }

export default async function beforePack(context) {
  const platform = context.electronPlatformName
  const suffix = platform === 'win32' ? '-msvc' : platform === 'linux' ? '-gnu' : ''
  const arch = ARCH[context.arch]
  const want = `bp-engine.${platform}-${arch}${suffix}.node`
  const dir = join(context.packager.projectDir, 'resources', 'engine')
  let staged
  try {
    staged = readdirSync(dir)
  } catch {
    throw new Error(`${dir} is missing; run scripts/bundle-engine.mjs on a ${platform} host first`)
  }
  if (!staged.includes(want)) {
    throw new Error(`resources/engine holds [${staged.filter((f) => f.endsWith('.node')).join(', ') || 'no addon'}] but this package targets ${platform}-${arch} (${want}); run scripts/bundle-engine.mjs on a ${platform} host first`)
  }
}
