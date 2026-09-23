import { afterEach, describe, expect, it, vi } from 'vitest'
import { StashAdapter } from './stash'

afterEach(() => vi.unstubAllGlobals())

const adapter = () => new StashAdapter({ url: 'https://stash.example/stash/', secret: 'private-key' })
const scene = (preview: string | null) => Response.json({ data: { findScene: { paths: { preview } } } })

describe('Stash generated previews', () => {
  it('resolves the current canonical preview and preserves partial content for playback', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(scene('https://stash.example/generated/current-preview.mp4?apikey=private-key&v=2'))
      .mockResolvedValueOnce(new Response('clip', { status: 206, headers: {
        'Content-Type': 'video/mp4', 'Content-Length': '4', 'Content-Range': 'bytes 0-3/400',
        'Accept-Ranges': 'bytes', 'Set-Cookie': 'private-cookie',
      } }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await adapter().preview('scene-42', 'bytes=0-3')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://stash.example/stash/graphql')
    const query = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(query.variables).toEqual({ id: 'scene-42' })
    expect(query.query).toContain('preview')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://stash.example/generated/current-preview.mp4?v=2')
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('private-key')
      expect(new Headers(init?.headers).get('ApiKey')).toBe('private-key')
    }
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Range')).toBe('bytes=0-3')
    expect(fetchMock.mock.calls[1]?.[1]?.redirect).toBe('error')
    expect(response.status).toBe(206)
    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/400',
      'accept-ranges': 'bytes', 'cache-control': 'no-store',
    })
    expect(await response.text()).toBe('clip')
  })

  it('resolves relative preview paths without retaining the API key', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(scene('generated/preview.mp4?apikey=private-key'))
      .mockResolvedValueOnce(new Response('clip', { headers: { 'Content-Type': 'video/mp4' } }))
    vi.stubGlobal('fetch', fetchMock)
    const response = await adapter().preview('42', null)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://stash.example/stash/generated/preview.mp4')
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has('Range')).toBe(false)
    expect(response.status).toBe(200)
  })

  it.each([null, ''])('returns 404 for an absent generated preview: %s', async (preview) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(scene(preview))
    vi.stubGlobal('fetch', fetchMock)
    expect((await adapter().preview('42', null)).status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns 404 for a removed scene', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: { findScene: null } }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await adapter().preview('42', null)).status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not send the configured API key to an off-origin preview', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(scene('https://other.example/preview.mp4'))
    vi.stubGlobal('fetch', fetchMock)
    expect((await adapter().preview('42', null)).status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preserves an unsatisfiable range response for the video element', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(scene('https://stash.example/preview.mp4'))
      .mockResolvedValueOnce(new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */400' } }))
    vi.stubGlobal('fetch', fetchMock)
    const response = await adapter().preview('42', 'bytes=999-')
    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */400')
  })

  it.each(['lookup', 'media'])('aborts an in-flight %s request when hover is cancelled', async (stage) => {
    const controller = new AbortController()
    let started!: () => void
    const pending = new Promise<void>((resolve) => { started = resolve })
    const fetchMock = vi.fn<typeof fetch>()
    if (stage === 'media') fetchMock.mockResolvedValueOnce(scene('https://stash.example/preview.mp4'))
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      started()
    }))
    vi.stubGlobal('fetch', fetchMock)
    const request = adapter().preview('42', null, controller.signal)
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await pending
    controller.abort()
    await rejection
    expect(fetchMock).toHaveBeenCalledTimes(stage === 'lookup' ? 1 : 2)
  })
})
