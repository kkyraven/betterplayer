import { describe, expect, it } from 'vitest'
import { bestUpscaler, folderName } from './steps'

describe('bestUpscaler', () => {
  it('takes Apple AI on macOS only', () => {
    expect(bestUpscaler({ appleVsr: true, dlss: false, vsr: false }, 'darwin')).toBe('apple')
    expect(bestUpscaler({ appleVsr: true, dlss: false, vsr: false }, 'win32')).toBe('fsr')
  })

  it('takes RTX Video first, then Apple AI, then FSR 1.0 anywhere; DLSS 5 is never picked on its own', () => {
    expect(bestUpscaler({ appleVsr: false, dlss: true, vsr: true }, 'win32')).toBe('rtx')
    expect(bestUpscaler({ appleVsr: false, dlss: true, vsr: false }, 'win32')).toBe('fsr')
    expect(bestUpscaler({ appleVsr: false, dlss: false, vsr: false }, 'linux')).toBe('fsr')
    expect(bestUpscaler(undefined, 'darwin')).toBe('fsr')
  })
})

describe('folderName', () => {
  it('takes the last segment on either separator', () => {
    expect(folderName('/Users/me/Movies/Videos')).toBe('Videos')
    expect(folderName('C:\\Media\\Archive\\')).toBe('Archive')
    expect(folderName('/')).toBe('/')
  })
})
