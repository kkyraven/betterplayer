import { describe, expect, it } from 'vitest'
import { resolveWebSource } from './web'

describe('resolveWebSource', () => {
  it.each([
    'https://mega.nz/file/SANITIZED#Example_Key-Exact',
    'https://mega.nz/folder/SANITIZED#Example_Key-Exact/file/SELECTED',
    'https://mega.nz/folder/SANITIZED#Example_Key-Exact/folder/SELECTED',
    'https://mega.nz/file/SANITIZED',
    'https://mega.nz/#!SANITIZED!Example_Key-Exact',
    'https://mega.co.nz/#F!SANITIZED!Example_Key-Exact',
    'https://www.mega.nz/#P!SanitizedPasswordLink',
    'https://mega.io/file/SANITIZED#Key%2FExact%2b.mp4',
    'http://mega.co.nz/#!SANITIZED!Example_Key-Exact',
  ])('requires browser decryption for the complete MEGA URL %s', (url) => {
    expect(resolveWebSource(url)).toEqual({ directUrl: null, host: 'mega', reason: 'Browser decryption required' })
  })

  it.each([
    { url: 'https://gofile.io/d/EXAMPLE1?password=SANITIZED#selection', host: 'gofile' },
    { url: 'https://gofile.io/d/00000000-0000-4000-8000-000000000000', host: 'gofile' },
    { url: 'https://www.mediafire.com/file/SANITIZED/example.mp4/file', host: 'mediafire' },
    { url: 'https://mediafire.com/folder/SANITIZED/example', host: 'mediafire' },
    { url: 'https://mediafire.com/?SANITIZED', host: 'mediafire' },
    { url: 'https://bunkr.cr/f/SANITIZED', host: 'bunkr' },
    { url: 'https://bunkr.fi/a/SANITIZED', host: 'bunkr' },
    { url: 'https://bunkr.si/v/SANITIZED', host: 'bunkr' },
    { url: 'https://balbums.st/a/SANITIZED', host: 'bunkr' },
    { url: 'https://catbox.moe/c/SANITIZED', host: 'catbox' },
    { url: 'https://workupload.com/file/SANITIZED', host: 'workupload' },
    { url: 'https://www.workupload.com/archive/SANITIZED', host: 'workupload' },
  ])('leaves $host pages to the browser', ({ url, host }) => {
    expect(resolveWebSource(url)).toEqual({ directUrl: null, host, reason: 'Browser download required' })
  })

  it.each(['funscript', 'mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'wmv', 'mpeg', 'mpg', 'zip', '7z', 'rar'])('accepts an existing Catbox %s asset without rewriting it', (extension) => {
    const url = `https://files.catbox.moe/abc123.${extension}?token=SANITIZED%2fExact&v=1#Keep%2BExact`
    expect(resolveWebSource(url)).toEqual({ directUrl: url, host: 'catbox' })
  })

  it('matches domains and asset extensions without changing original URL spelling', () => {
    const url = 'HTTPS://FILES.CATBOX.MOE/abc123.MP4?x=%2f#Keep'
    expect(resolveWebSource(url)).toEqual({ directUrl: url, host: 'catbox' })
  })

  it.each([
    'https://files.catbox.moe/',
    'https://files.catbox.moe/abc123',
    'https://files.catbox.moe/abc123.html?filename=example.mp4',
    'https://files.catbox.moe/abc123.exe',
    'https://files.catbox.moe/abc123.mp4.html',
    'https://files.catbox.moe/nested/abc123.mp4',
    'https://files.catbox.moe/abc123%2emp4',
    'https://files.catbox.moe/nested/../abc123.mp4',
    'https://%66iles.catbox.moe/abc123.mp4',
    'http://files.catbox.moe/abc123.mp4',
  ])('requires a browser for an unverified Catbox asset shape %s', (url) => {
    expect(resolveWebSource(url)).toEqual({ directUrl: null, host: 'catbox', reason: 'Browser download required' })
  })

  it.each([
    '', 'not a URL', '/file/example', '//mega.nz/file/example',
    'file:///example.mp4', 'javascript:alert(1)', 'data:video/mp4;base64,EXAMPLE',
    'blob:https://mega.nz/example', 'ftp://files.catbox.moe/abc123.mp4',
    'https://user:pass@mega.nz/file/SANITIZED#KEY',
    'https://mega.nz:444/file/SANITIZED#KEY',
    'https://mega.nz.evil.example/file/SANITIZED#KEY',
    'https://evilmega.nz/file/SANITIZED#KEY',
    'https://mega.nz@evil.example/file/SANITIZED#KEY',
    'https://files.catbox.moe.evil.example/abc123.mp4',
    'https://cdn.catbox.moe/abc123.mp4',
    'https://store1.gofile.io/download/example.mp4',
    'https://download1.mediafire.com/example.mp4',
    'https://bunkr.example/f/SANITIZED',
    'https://unknown.example/example.mp4',
    ' https://mega.nz/file/SANITIZED#KEY',
    'https://mega.nz/file/SANITIZED#KEY\n',
    'https://me\tga.nz/file/SANITIZED#KEY',
    'https://files.catbox.moe/abc123.mp4\r\nInjected: true',
    'https://files.catbox.moe\\evil.example/abc123.mp4',
  ])('rejects unsupported or unsafe URLs %s', (url) => {
    expect(resolveWebSource(url)).toBeNull()
  })
})
