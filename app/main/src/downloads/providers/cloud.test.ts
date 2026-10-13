import { describe, expect, it } from 'vitest'
import { resolveCloudSource } from './cloud'

describe('resolveCloudSource', () => {
  it('resolves a single Pixeldrain viewer or file API link with the attachment flag', () => {
    for (const path of ['/u/Test_123', '/api/file/Test_123']) {
      expect(resolveCloudSource(`https://pixeldrain.com${path}`)).toEqual({
        directUrl: 'https://pixeldrain.com/api/file/Test_123?download', host: 'pixeldrain.com'
      })
    }
    const url = 'https://pixeldrain.com/api/file/Test_123?download&token=a%2fb%2B+c&token=two&empty=#fragment'
    expect(resolveCloudSource(url)?.directUrl).toBe(url)
    expect(resolveCloudSource('https://pixeldrain.com/u/Test_123?token=a%2fb%2B+c&flag#fragment')?.directUrl)
      .toBe('https://pixeldrain.com/api/file/Test_123?token=a%2fb%2B+c&flag&download#fragment')
  })

  it('requires file selection for Pixeldrain lists and filesystem links', () => {
    for (const path of ['/l/List_123', '/l/List_123?download#item=2', '/d/Folder12/file.mp4', '/api/list/List_123', '/api/filesystem/Folder12/file.mp4']) {
      expect(resolveCloudSource(`https://pixeldrain.com${path}`)).toEqual({
        directUrl: null, host: 'pixeldrain.com', reason: 'File selection required'
      })
    }
  })

  it('changes only dl for documented Dropbox file links', () => {
    const cases = [
      ['https://www.dropbox.com/s/Test123/file.funscript', 'https://www.dropbox.com/s/Test123/file.funscript?dl=1'],
      ['https://dropbox.com/s/Test123/extensionless?', 'https://dropbox.com/s/Test123/extensionless?dl=1'],
      ['https://www.dropbox.com/scl/fi/Test.123/file%20name.mp4?rlkey=a%2Fb&dl=0&st=a+b#preview', 'https://www.dropbox.com/scl/fi/Test.123/file%20name.mp4?rlkey=a%2Fb&dl=1&st=a+b#preview'],
      ['https://dropbox.com/s/Test123/file.zip?token=a%2fb%2B+c&token=two&flag&empty=', 'https://dropbox.com/s/Test123/file.zip?token=a%2fb%2B+c&token=two&flag&empty=&dl=1'],
      ['https://dropbox.com/s/Test123/file.zip?x=1&?dl=0&token=sample', 'https://dropbox.com/s/Test123/file.zip?x=1&?dl=0&token=sample&dl=1'],
      ['https://dropbox.com/s/Test123/file.zip?dl=0&%64l=0&token=a%7e&&raw=1', 'https://dropbox.com/s/Test123/file.zip?dl=1&%64l=1&token=a%7e&&raw=1']
    ] as const
    for (const [input, output] of cases) {
      expect(resolveCloudSource(input)?.directUrl).toBe(output)
      expect(resolveCloudSource(output)?.directUrl).toBe(output)
    }
  })

  it('requires file selection for Dropbox folders even with a filename or dl=1', () => {
    for (const path of ['/sh/Folder123/files?dl=1', '/scl/fo/Folder123/files?rlkey=sample&dl=1']) {
      expect(resolveCloudSource(`https://www.dropbox.com${path}`)).toEqual({
        directUrl: null, host: 'www.dropbox.com', reason: 'File selection required'
      })
    }
  })

  it('keeps known Drive files on the ordinary browser download path', () => {
    for (const path of ['/file/d/Test_123/view?resourcekey=a%2Fb&usp=sharing', '/file/d/Test_123', '/file/d/Test_123/preview', '/open?id=Test_123&resourcekey=a%2fb', '/uc?export=download&id=Test_123&confirm=sample']) {
      expect(resolveCloudSource(`https://drive.google.com${path}`)).toEqual({
        directUrl: null, host: 'drive.google.com', reason: 'Browser download required'
      })
    }
    for (const path of ['/drive/folders/Folder123', '/drive/u/0/folders/Folder123?resourcekey=sample']) {
      expect(resolveCloudSource(`https://drive.google.com${path}`)?.reason).toBe('File selection required')
    }
  })

  it('uses browser handling for unknown layouts on a known host', () => {
    for (const url of [
      'https://pixeldrain.com/u/Test123/extra', 'https://pixeldrain.com/api/file/Test123/info',
      'https://pixeldrain.com/u/Test123,Other123', 'https://pixeldrain.com/u/%54est123',
      'https://dropbox.com/s/Test123', 'https://dropbox.com/s/dl/file.zip',
      'https://dropbox.com/scl/fi/Test123/file.zip/extra', 'https://dropbox.com/new/file.zip',
      'https://drive.google.com/open?id=Test123&id=Other123', 'https://drive.google.com/uc?export=download',
      'https://drive.google.com/file/d/Test123/view/extra', 'https://drive.google.com/unknown',
      'https://pixeldrain.com/unknown/../u/Test123', 'https://dropbox.com/unknown/%2e%2e/s/Test123/file.zip'
    ]) {
      expect(resolveCloudSource(url)).toMatchObject({ directUrl: null, reason: 'Unknown link layout' })
    }
  })

  it('rejects unsupported, malformed, credentialed, and nonstandard-origin URLs', () => {
    for (const url of [
      '', '/u/Test123', 'not a url', 'javascript:alert(1)', 'file:///u/Test123',
      'ftp://pixeldrain.com/u/Test123', 'https://user:pass@pixeldrain.com/u/Test123',
      'https://dropbox.com:444/s/Test123/file.zip', 'https://example.com/file.mp4',
      'https://pixeldrain.com.evil.test/u/Test123', 'https://evilpixeldrain.com/u/Test123',
      'https://dropbox.com.evil.test/s/Test123/file.zip', 'https://drive.google.com.evil.test/file/d/Test123/view',
      'https://pixeldrain.com/u/Test123\r\nInjected: true', ' https://pixeldrain.com/u/Test123',
      'https://pixeldrain.com\\u\\Test123', 'https://www.googleapis.com/drive/v3/files/Test123?alt=media'
    ]) {
      expect(resolveCloudSource(url)).toBeNull()
    }
  })
})
