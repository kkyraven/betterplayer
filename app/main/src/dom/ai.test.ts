import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultDomAi, type DomAiSettings } from '@shared/dom'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`sealed:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^sealed:/, ''),
  },
}))
import { Dom } from './index'
import { DomDb } from './store'

const sealed = (s: string) => Buffer.from(`sealed:${s}`).toString('base64')
const LMSTUDIO = 'http://127.0.0.1:1234/v1'
const OPENROUTER = 'https://openrouter.ai/api/v1'
const OPENAI = 'https://api.openai.com/v1'

const dirs: string[] = []
const doms: Dom[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of doms.splice(0)) d.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function folder(meta: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'bp-dom-ai-'))
  dirs.push(dir)
  const db = new DomDb(join(dir, 'dom.sqlite'))
  for (const [k, v] of Object.entries(meta)) db.setMeta(k, v)
  db.close()
  return dir
}

function open(dir: string): Dom {
  const dom = new Dom(dir)
  doms.push(dom)
  return dom
}

const storedAi = (ai: Partial<DomAiSettings>) => {
  const { setupDone: _, ...rest } = { ...defaultDomAi(), ...ai }
  return JSON.stringify(rest)
}

function serve(routes: Record<string, () => Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const route = Object.entries(routes).find(([path]) => String(input).endsWith(path))
    if (!route) throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') })
    return route[1]()
  })
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const authOf = (call: unknown[] | undefined) => new Headers((call?.[1] as RequestInit | undefined)?.headers).get('Authorization')

describe('setupDone on upgrade', () => {
  it.each([
    ['a new install', false, {}],
    ['someone signed in to Agentic Lover', true, { ai: storedAi({}), alRefresh: sealed('r') }],
    ['their own server with a model', true, { ai: storedAi({ provider: 'own', ownModel: 'qwen' }) }],
    ['their own server with no model', false, { ai: storedAi({ provider: 'own', ownModel: '' }) }],
    ['Agentic Lover picked but signed out', false, { ai: storedAi({ provider: 'agenticlover' }) }],
  ])('for %s is %s', (_, done, meta: Record<string, string>) => {
    expect(open(folder(meta)).ai().setupDone).toBe(done)
  })

  it('is decided once, not again after signing in', () => {
    const dir = folder()
    open(dir).ai()
    doms.pop()?.close()
    const db = new DomDb(join(dir, 'dom.sqlite'))
    db.setMeta('alRefresh', sealed('r'))
    db.close()
    expect(open(dir).ai().setupDone).toBe(false)
  })
})

describe('own server keys', () => {
  it('keeps one key per origin', () => {
    const dom = open(folder())
    dom.setKey(LMSTUDIO, 'local')
    dom.setKey(OPENAI, 'sk')
    expect(dom.hasKey('http://127.0.0.1:1234/other')).toBe(true)
    expect(dom.hasKey('http://127.0.0.1:11434/v1')).toBe(false)
    dom.setKey(LMSTUDIO, null)
    expect(dom.hasKey(LMSTUDIO)).toBe(false)
    expect(dom.hasKey(OPENAI)).toBe(true)
    expect(dom.hasKey('not an address')).toBe(false)
  })

  it('gives the single key from before to the server set then, and drops it', async () => {
    const dir = folder({ ai: storedAi({ provider: 'own', ownUrl: OPENROUTER, ownModel: 'm' }), ownKey: sealed('or-key') })
    const dom = open(dir)
    expect(dom.hasKey(OPENROUTER)).toBe(true)
    expect(dom.hasKey(LMSTUDIO)).toBe(false)
    const fetch = serve({ '/models': json({ data: [] }), '/key': json({}) })
    await dom.ownModels(OPENROUTER)
    expect(authOf(fetch.mock.calls[0])).toBe('Bearer or-key')
    doms.pop()?.close()
    const db = new DomDb(join(dir, 'dom.sqlite'))
    expect(db.meta('ownKey')).toBeNull()
    db.close()
  })

  it('keeps the key from before while the saved address does not parse, and moves it once one does', () => {
    const dom = open(folder({ ai: storedAi({ provider: 'own', ownUrl: '127.0.0.1:1234/v1', ownModel: 'm' }), ownKey: sealed('old') }))
    expect(dom.hasKey(LMSTUDIO)).toBe(false)
    dom.setAi({ ...dom.ai(), ownUrl: LMSTUDIO })
    expect(dom.hasKey(LMSTUDIO)).toBe(true)
  })
})

describe('ownModels', () => {
  it('lists the models in the server order', async () => {
    serve({ '/models': json({ data: [{ id: 'b' }, { id: 'a' }, { object: 'model' }] }) })
    expect(await open(folder()).ownModels(`${LMSTUDIO}/`)).toEqual({ kind: 'ok', models: ['b', 'a'] })
  })

  it('tells nothing there from a refused key from another error', async () => {
    const dom = open(folder())
    serve({})
    expect(await dom.ownModels(LMSTUDIO)).toEqual({ kind: 'unreachable', detail: 'connect ECONNREFUSED' })
    vi.restoreAllMocks()
    serve({ '/models': json({ error: 'no' }, 401) })
    expect(await dom.ownModels(OPENAI)).toMatchObject({ kind: 'auth', hasKey: false })
    dom.setKey(OPENAI, 'sk')
    expect(await dom.ownModels(OPENAI)).toMatchObject({ kind: 'auth', hasKey: true })
    vi.restoreAllMocks()
    serve({ '/models': json({}, 500) })
    expect(await dom.ownModels(LMSTUDIO)).toMatchObject({ kind: 'error', status: 500 })
  })

  it('checks an OpenRouter key, since its models answer without one', async () => {
    const dom = open(folder())
    serve({ '/models': json({ data: [{ id: 'x' }] }), '/key': json({}, 401) })
    expect(await dom.ownModels(OPENROUTER)).toEqual({ kind: 'auth', hasKey: false, detail: '' })
    dom.setKey(OPENROUTER, 'bad')
    expect(await dom.ownModels(OPENROUTER)).toMatchObject({ kind: 'auth', hasKey: true })
    vi.restoreAllMocks()
    const fetch = serve({ '/models': json({ data: [{ id: 'x' }] }), '/key': json({ data: {} }) })
    expect(await dom.ownModels(OPENROUTER)).toEqual({ kind: 'ok', models: ['x'] })
    expect(authOf(fetch.mock.calls[1])).toBe('Bearer bad')
  })
})

describe('own server chat', () => {
  const sent = async (ownUrl: string) => {
    const dom = open(folder())
    dom.setAi({ ...defaultDomAi(), provider: 'own', ownUrl, ownModel: 'm', setupDone: true })
    dom.setKey(ownUrl, 'sk')
    const fetch = serve({ '/chat/completions': json({ choices: [{ message: { content: 'Hi' } }] }) })
    await dom.chat([{ role: 'user', content: 'Hello' }], [], false)
    return { body: JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>, auth: authOf(fetch.mock.calls[0]) }
  }

  it('asks OpenAI for completion tokens, with no temperature', async () => {
    const { body, auth } = await sent(OPENAI)
    expect(body).toMatchObject({ model: 'm', max_completion_tokens: 4000 })
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('tools')
    expect(auth).toBe('Bearer sk')
  })

  it('leaves other servers as they were', async () => {
    const { body } = await sent(LMSTUDIO)
    expect(body).toMatchObject({ temperature: 0.9, max_tokens: 800, tools: [] })
    expect(body).not.toHaveProperty('max_completion_tokens')
  })
})
