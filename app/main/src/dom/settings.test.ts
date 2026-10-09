import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { defaultDomAi, type ChatMessage } from '@shared/dom'

vi.mock('electron', () => ({ safeStorage: {}, BrowserWindow: vi.fn() }))
import { Dom } from './index'

it.each(['tagEditing', 'viewVideo'] as const)('persists the global %s opt-in across restarts', (permission) => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-dom-settings-'))
  let dom = new Dom(dir)
  try {
    expect(dom.ai()[permission]).toBe(false)
    dom.setAi({ ...defaultDomAi(), [permission]: true })
    dom.close()
    dom = new Dom(dir)
    expect(dom.ai()[permission]).toBe(true)
    dom.setAi({ ...dom.ai(), [permission]: false })
    dom.close()
    dom = new Dom(dir)
    expect(dom.ai()[permission]).toBe(false)
  } finally {
    dom.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('forwards video image parts through the own-server chat connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-dom-vision-'))
  const dom = new Dom(dir)
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'Seen.' } }] })))
  try {
    dom.setAi({ ...defaultDomAi(), provider: 'own', viewVideo: true })
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Video screenshot at 1.25 seconds.' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZmFrZQ==' } }] }]
    await dom.chat(messages, [], false)
    const sent = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { messages: ChatMessage[] }
    expect(sent.messages).toEqual(messages)
  } finally {
    fetch.mockRestore()
    dom.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('persists named advanced pain profiles and the opt-in independently of AI settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-dom-pain-'))
  let dom = new Dom(dir)
  try {
    expect(dom.advancedPain().enabled).toBe(false)
    const profile = { ...dom.advancedPain().profiles[0]!, id: 'custom', name: 'whip_cock' }
    profile.channels[0].riseMs = 300
    dom.setAdvancedPain({ enabled: true, profiles: [profile] })
    dom.close()
    dom = new Dom(dir)
    expect(dom.advancedPain()).toEqual({ enabled: true, profiles: [profile] })
    expect(dom.ai().tagEditing).toBe(false)
    expect(dom.ai().viewVideo).toBe(false)
  } finally { dom.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('persists the optional safeword for every dom', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-dom-safeword-'))
  let dom = new Dom(dir)
  try {
    expect((await dom.you()).safeword).toBe('')
    dom.setYou({ ...await dom.you(), safeword: 'red' })
    dom.close(); dom = new Dom(dir)
    expect((await dom.you()).safeword).toBe('red')
    dom.setYou({ ...await dom.you(), safeword: '' })
    expect((await dom.you()).safeword).toBe('')
  } finally { dom.close(); rmSync(dir, { recursive: true, force: true }) }
})
