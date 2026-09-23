import { basename, dirname, extname } from 'node:path'

export class ScriptFolders {
  private readonly byStem = new Map<string, Set<string>>()

  constructor(siblings: Map<string, string[]>) {
    for (const [dir, names] of siblings) {
      for (const name of names) {
        const extension = extname(name)
        if (!['.funscript', '.FUNSCRIPT', '.zip'].includes(extension)) continue
        const base = basename(name, extension)
        const stems = [base]
        if (extension !== '.zip') {
          for (let i = 1; i < base.length; i++) {
            if (base[i] === '.' || base[i] === '_' || (base.slice(i, i + 2) === ' (' && base.endsWith(')') && base.length > i + 3)) stems.push(base.slice(0, i))
          }
        }
        for (const stem of stems) {
          const dirs = this.byStem.get(stem) ?? new Set<string>()
          dirs.add(dir)
          this.byStem.set(stem, dirs)
        }
      }
    }
  }

  forMedia(path: string): string[] {
    return [...(this.byStem.get(basename(path, extname(path))) ?? [])].filter((dir) => dir !== dirname(path)).sort()
  }
}
