import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { masksOverCap, useMaskDir } from './masks'

describe('mask track housekeeping', () => {
  it('deletes the least recently used folders until the rest fit, never the one in use', () => {
    const folders = [
      { name: '3', bytes: 400, usedMs: 30 },
      { name: '1', bytes: 500, usedMs: 10 },
      { name: '2', bytes: 300, usedMs: 20 },
      { name: '4', bytes: 200, usedMs: 5 },
    ]
    expect(masksOverCap(folders, 2000, '3')).toEqual([])
    expect(masksOverCap(folders, 1000, '3')).toEqual(['4', '1'])
    expect(masksOverCap(folders, 500, '4')).toEqual(['1', '2', '3'])
    expect(masksOverCap([{ name: '9', bytes: 5000, usedMs: 0 }], 1000, '9')).toEqual([])
  })

  it('touches the folder in use, so an old track opened again is kept over newer ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bp-masks-'))
    try {
      const old = new Date(Date.now() - 60_000)
      for (const [name, age] of [['1', 3], ['2', 2], ['3', 1]] as const) {
        mkdirSync(join(root, name))
        writeFileSync(join(root, name, '0.z'), Buffer.alloc(100))
        const at = new Date(old.getTime() - age * 1000)
        utimesSync(join(root, name), at, at)
      }
      await useMaskDir(root, join(root, '1'), 250)
      expect(['1', '2', '3'].map((n) => existsSync(join(root, n)))).toEqual([true, false, true])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
