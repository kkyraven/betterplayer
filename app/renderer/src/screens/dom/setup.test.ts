import { describe, expect, it } from 'vitest'
import { SIGNED_OUT_AL } from '@shared/dom'
import { domBlock, firstChatModel, hostOf, listModels, ownServerId } from './setup'

const OPENAI = ['gpt-6.1-terra', 'text-embedding-3-large', 'tts-2', 'whisper-2', 'dall-e-3', 'gpt-image-2', 'omni-moderation-latest', 'o5-mini']
const ROUTER = ['openai/gpt-6.1-terra', 'deepseek/deepseek-v4.1', 'anthropic/claude-sonnet-5', 'qwen3.5:14b']

describe('listModels', () => {
  it('hides non-chat models behind a count', () => {
    const list = listModels(OPENAI, '', false, '')
    expect(list.groups.flatMap((g) => g.ids)).toEqual(['gpt-6.1-terra', 'o5-mini'])
    expect(list.hidden).toBe(6)
    expect(listModels(OPENAI, '', true, '').groups.flatMap((g) => g.ids)).toHaveLength(OPENAI.length)
  })

  it('groups by vendor prefix with bare ids first, and keeps whole ids once a slash is typed', () => {
    expect(listModels(ROUTER, '', false, '').groups.map((g) => g.vendor)).toEqual(['', 'anthropic', 'deepseek', 'openai'])
    expect(listModels(ROUTER, 'openai/', false, '').groups).toEqual([{ vendor: '', ids: ['openai/gpt-6.1-terra'] }])
  })

  it('keeps a saved model the server does not list, and offers typed ids that are not listed', () => {
    expect(listModels(OPENAI, '', false, 'ft:gpt-6.1-terra:raven').unlisted).toBe('ft:gpt-6.1-terra:raven')
    expect(listModels(OPENAI, 'ft:mine', false, '').typed).toBe('ft:mine')
    expect(listModels(OPENAI, 'gpt-6.1-terra', false, '').typed).toBeNull()
  })

  it('keeps a picked non-chat model in view', () => {
    expect(listModels(OPENAI, '', false, 'tts-2').groups.flatMap((g) => g.ids)).toContain('tts-2')
  })
})

it('preselects the first chat model', () => {
  expect(firstChatModel(['nomic-embed-text:latest', 'qwen3.5:14b', 'gemma4:12b'])).toBe('gemma4:12b')
  expect(firstChatModel(['nomic-embed-text:latest'])).toBe('')
})

it('names servers by preset or host', () => {
  expect(ownServerId('https://api.openai.com/v1/')).toBe('openai')
  expect(ownServerId('http://192.168.1.20:8000/v1')).toBe('custom')
  expect(hostOf('http://192.168.1.20:8000/v1')).toBe('192.168.1.20:8000')
})

describe('domBlock', () => {
  const signedIn = { signedIn: true, freeSecondsLeft: 0 }
  const own = { provider: 'own', setupDone: true, ownModel: 'qwen' } as const
  const al = { provider: 'agenticlover', setupDone: true, ownModel: '' } as const
  it('asks for setup before anything else', () => {
    expect(domBlock({ ...own, setupDone: false }, signedIn, true, null)).toBe('notSetUp')
  })
  it('blocks an own server that is down or wants a key, not one still being asked', () => {
    expect(domBlock(own, SIGNED_OUT_AL, false, { kind: 'unreachable', detail: '' })).toBe('ownDown')
    expect(domBlock(own, SIGNED_OUT_AL, false, { kind: 'auth', hasKey: false, detail: '' })).toBe('ownKey')
    expect(domBlock(own, SIGNED_OUT_AL, false, null)).toBeNull()
  })
  it('blocks an own server with no model picked', () => {
    expect(domBlock({ ...own, ownModel: ' ' }, SIGNED_OUT_AL, false, { kind: 'ok', models: ['qwen'] })).toBe('ownModel')
  })
  it('follows Agentic Lover access', () => {
    expect(domBlock(al, SIGNED_OUT_AL, false, null)).toBe('signIn')
    expect(domBlock(al, signedIn, false, null)).toBe('freeUsed')
    expect(domBlock(al, signedIn, true, null)).toBeNull()
  })
})
