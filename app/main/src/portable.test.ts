import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { portableDataDir } from './portable'

const TEMP_EXE = join(tmpdir(), 'bp-portable', 'Better Player.exe')
const INSTALLED_EXE = 'C:\\Users\\x\\AppData\\Local\\Programs\\Better Player\\Better Player.exe'

describe('portableDataDir', () => {
  it('is null for an installed or dev build', () => {
    expect(portableDataDir({})).toBeNull()
  })

  it('is null when the variable is empty, rather than the working directory', () => {
    expect(portableDataDir({ PORTABLE_EXECUTABLE_DIR: '' }, TEMP_EXE)).toBeNull()
  })

  it('is the folder beside the exe for the portable build, which runs from the temp unpack folder', () => {
    expect(portableDataDir({ PORTABLE_EXECUTABLE_DIR: '/Volumes/stick' }, TEMP_EXE)).toBe('/Volumes/stick/betterplayer')
  })

  it('is null when the variable was inherited by an installed copy', () => {
    expect(portableDataDir({ PORTABLE_EXECUTABLE_DIR: 'D:\\Apps' }, INSTALLED_EXE)).toBeNull()
  })
})
