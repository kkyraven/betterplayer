import { parseScriptName } from '@shared/matcher'

export const STAND_IN = 'video.mp4'

export function scriptFileNames(names: string[]): string[] {
  const stems = names.map((n) => n.replace(/\.funscript$/i, '').trim())
  if (stems.length === 1) {
    const suffix = parseScriptName(`video.${stems[0]}.funscript`)?.suffix
    return [suffix ? `video.${suffix}.funscript` : 'video.funscript']
  }
  const shortest = [...stems].sort((a, b) => a.length - b.length)[0] ?? ''
  const shared = shortest.length > 0 && stems.every((s) => s === shortest || s.startsWith(`${shortest}.`) || s.startsWith(`${shortest}_`))
  const used = new Set<string>()
  return stems.map((s, i) => {
    const suffix = shared ? s.slice(shortest.length).replace(/^[._]/, '') : s
    const clean = suffix.replace(/[^\w.-]+/g, '_').replace(/^\.+|\.+$/g, '')
    const stem = clean ? `video.${clean}` : i === 0 ? 'video' : `video.${i}`
    let result = `${stem}.funscript`
    for (let n = 2; used.has(result.toLowerCase()); n++) result = `${stem}.${n}.funscript`
    used.add(result.toLowerCase())
    return result
  })
}
