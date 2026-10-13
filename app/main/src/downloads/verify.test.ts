import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { VerificationError, verifiedScriptEntries, verifyFunscript, verifyScriptZip } from './verify'

describe('downloaded scripts and bounded ZIPs', () => {
  it('keeps v2 root stroke, channel stroke, other axes and metadata valid', async () => {
    const bytes = await readFile(new URL('./fixtures/v2.funscript', import.meta.url))
    const original = Buffer.from(bytes)
    expect(() => verifyFunscript(bytes)).not.toThrow()
    expect(bytes).toEqual(original)
    expect(() => verifyFunscript(Buffer.from('{"actions":[{"at":1.5,"pos":101},{"at":0,"pos":-1}],"axes":[{"id":"R1","actions":[{"at":0,"pos":50}]}]}'))).not.toThrow()
    expect(() => verifyFunscript(Buffer.alloc(32 * 1024 * 1024 + 1, 32))).toThrow('supported size')
    expect(() => verifyScriptZip(Buffer.from('not a zip'))).toThrow(VerificationError)
  })
  it('accepts nested script bundles while refusing traversal, symlinks and general media archives', async () => {
    const [scripts, traversal, symlink, video] = await Promise.all(['script-bundle.zip', 'traversal.zip', 'symlink.zip', 'video-archive.zip'].map(name => readFile(new URL(`./fixtures/${name}`, import.meta.url))))
    expect(() => verifyScriptZip(scripts!)).not.toThrow()
    expect(verifiedScriptEntries(scripts!).map(entry => entry.name)).toEqual(['nested/scene.funscript', 'nested/scene.alternative.roll.funscript'])
    expect(() => verifyScriptZip(traversal!)).toThrow('Unsafe archive path')
    expect(() => verifyScriptZip(symlink!)).toThrow('Unsafe archive path')
    expect(() => verifyScriptZip(video!)).toThrow('Choose files from this archive')
    const corrupt = Buffer.from(scripts!)
    const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    corrupt.writeUInt32LE(0, central + 16)
    expect(() => verifyScriptZip(corrupt)).toThrow('Invalid archive checksum')
  })
})
