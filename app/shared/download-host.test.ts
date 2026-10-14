import { describe, expect, it } from 'vitest'
import { intermediaryDownloadUrl, matchingVideoFileNames, unavailableHostFile } from './download-host'

describe('confirmed unavailable host files', () => {
  it('recognizes the actual MEGA, GoFile, K2S and Drive error headings', () => {
    expect(unavailableHostFile('mega.nz', 'File cannot be accessed')).toBe(true)
    expect(unavailableHostFile('www.mega.co.nz', 'File cannot be accessed')).toBe(true)
    expect(unavailableHostFile('gofile.io', ' This content does not exist ')).toBe(true)
    expect(unavailableHostFile('k2s.cc', 'File unavailable')).toBe(true)
    expect(unavailableHostFile('keep2share.cc', ' File unavailable ')).toBe(true)
    expect(unavailableHostFile('drive.google.com', ' Sorry, the file you have requested does not exist. ')).toBe(true)
  })

  it('keeps login, keys, quota and cold storage eligible for user recovery', () => {
    for (const heading of ['Log in to your MEGA account', 'Enter decryption key', 'Transfer quota exceeded', '']) {
      expect(unavailableHostFile('mega.nz', heading)).toBe(false)
    }
    for (const heading of ['Sign in', 'This file is in cold storage', 'Free downloads are temporarily paused']) {
      expect(unavailableHostFile('gofile.io', heading)).toBe(false)
    }
    for (const heading of ['Sign In', 'Premium', 'Download and Watch Online', 'Free Plan']) {
      expect(unavailableHostFile('k2s.cc', heading)).toBe(false)
    }
    for (const heading of ['You need access', 'Request access', 'Sign in', "You can't view or download this file at this time."]) {
      expect(unavailableHostFile('drive.google.com', heading)).toBe(false)
    }
  })

  it('requires the corresponding provider origin and exact error', () => {
    expect(unavailableHostFile('ads.example', 'File cannot be accessed')).toBe(false)
    expect(unavailableHostFile('mega.nz.example', 'File cannot be accessed')).toBe(false)
    expect(unavailableHostFile('gofile.io', 'File cannot be accessed')).toBe(false)
    expect(unavailableHostFile('k2s.cc.example', 'File unavailable')).toBe(false)
    expect(unavailableHostFile('gofile.io', 'File unavailable')).toBe(false)
    expect(unavailableHostFile('k2s.cc', 'Download and Watch Online\nFile unavailable')).toBe(false)
    expect(unavailableHostFile('drive.google.com.example', 'Sorry, the file you have requested does not exist.')).toBe(false)
    expect(unavailableHostFile('ads.example', 'Sorry, the file you have requested does not exist.')).toBe(false)
    expect(unavailableHostFile('drive.google.com', 'Sorry, the file you have requested does not exist.\nRequest access')).toBe(false)
  })
})

describe('intermediary download links', () => {
  const article = 'https://keep2porn.net/205359-mistress-aryel-double-femdom-ruined-orgasm-femdom-fullhd-1080p-cruelmistresses.html'
  const file = 'https://k2s.cc/file/53a37617478a5'

  it('accepts the actual article-to-K2S file transition', () => {
    expect(intermediaryDownloadUrl(article, file)).toBe(file)
  })

  it('rejects promotions, unrelated pages and non-file routes', () => {
    for (const target of [
      'https://k2s.cc/code/68290extra-free-days?site=keep2porn.net',
      'https://keep2share.cc/pr/68290?site=keep2porn.net',
      'https://k2s.cc/auth/login',
      'https://k2s.cc/file/53a37617478a5/other',
      'https://k2s.cc/file/%35%33a37617478a5',
      'https://k2s.cc/file/',
    ]) expect(intermediaryDownloadUrl(article, target)).toBeNull()
    for (const source of [
      'https://keep2porn.net/',
      'https://keep2porn.net/tags/CruelMistresses/',
      'https://keep2porn.net/not-an-article.html',
      'https://keep2porn.net/205359-other/page.html',
    ]) expect(intermediaryDownloadUrl(source, file)).toBeNull()
  })

  it('requires exact HTTPS origins without credentials or unexpected URL state', () => {
    for (const source of [
      article.replace('https:', 'http:'),
      article.replace('keep2porn.net', 'keep2porn.net.example'),
      article.replace('keep2porn.net', 'localhost'),
      article.replace('keep2porn.net', 'user:password@keep2porn.net'),
      article.replace('keep2porn.net', 'keep2porn.net:444'),
      `${article}?redirect=https://example.com`,
      `${article}#download`,
      'not a URL',
    ]) expect(intermediaryDownloadUrl(source, file)).toBeNull()
    for (const target of [
      file.replace('https:', 'http:'),
      file.replace('k2s.cc', 'k2s.cc.example'),
      file.replace('k2s.cc', '127.0.0.1'),
      file.replace('k2s.cc', 'user:password@k2s.cc'),
      file.replace('k2s.cc', 'k2s.cc:444'),
      `${file}?redirect=https://example.com`,
      `${file}#download`,
      'file:///53a37617478a5',
    ]) expect(intermediaryDownloadUrl(article, target)).toBeNull()
  })
})

describe('matching folder videos to selected scripts', () => {
  const videos = ['1641647055994.webm', '1645668234609.webm']

  it('finds the selected numeric script video among both actual topic files', () => {
    expect(matchingVideoFileNames(videos, ['1641647055994.funscript'])).toEqual([videos[0]])
    expect(matchingVideoFileNames(videos, ['1645668234609.funscript'])).toEqual([videos[1]])
  })

  it('uses established axis and variant suffix conventions against known videos', () => {
    expect(matchingVideoFileNames(videos, ['1641647055994.roll.funscript', '1641647055994.max.funscript'])).toEqual([videos[0]])
    expect(matchingVideoFileNames(['Scene.webm'], ['scene.Alternative.Roll.FUNSCRIPT'])).toEqual(['Scene.webm'])
  })

  it('retains every match when both scripts or several encodings are selected', () => {
    expect(matchingVideoFileNames(videos, ['1641647055994.funscript', '1645668234609.funscript'])).toEqual(videos)
    expect(matchingVideoFileNames(['scene.webm', 'scene.mp4'], ['scene.funscript'])).toEqual(['scene.webm', 'scene.mp4'])
    expect(matchingVideoFileNames(['scene.webm', 'scene.webm'], ['scene.funscript'])).toHaveLength(2)
  })

  it('leaves absent selections and unrelated or merely similar file names unresolved', () => {
    expect(matchingVideoFileNames(videos, [])).toEqual([])
    expect(matchingVideoFileNames(videos, ['missing.funscript'])).toEqual([])
    expect(matchingVideoFileNames(videos, ['16416470559940.funscript'])).toEqual([])
    expect(matchingVideoFileNames(['scene-other.webm'], ['scene.funscript'])).toEqual([])
    expect(matchingVideoFileNames(['scene.webm'], ['scene-other.funscript'])).toEqual([])
  })

  it('preserves the longest actual stem and rejects paths and non-video files', () => {
    expect(matchingVideoFileNames(['scene.webm', 'scene.part.webm'], ['scene.part.roll.funscript'])).toEqual(['scene.part.webm'])
    expect(matchingVideoFileNames(['scene.txt', 'folder/scene.webm', 'folder\\scene.webm'], ['scene.funscript'])).toEqual([])
    expect(matchingVideoFileNames(['scene.webm'], ['folder/scene.funscript', 'folder\\scene.funscript', 'scene.mp4'])).toEqual([])
  })
})
