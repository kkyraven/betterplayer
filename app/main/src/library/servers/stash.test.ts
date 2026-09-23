import { afterEach, describe, expect, it, vi } from 'vitest'
import { StashAdapter } from './stash'
import type { RemoteEntry } from './adapter'

afterEach(() => vi.unstubAllGlobals())

function responses(...data: unknown[]) {
  const fetchMock = vi.fn()
  for (const body of data) fetchMock.mockResolvedValueOnce(Response.json({ data: body }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const adapter = () => new StashAdapter({ url: 'https://stash.example', secret: 'secret' })

describe('StashAdapter', () => {
  it('imports a Windows filename and uses the library creation date for recently added', async () => {
    const stamp = '2026-09-01T00:00:00Z'
    responses(
      { findScenes: { count: 1, scenes: [{ id: '1', updated_at: stamp }] } },
      { findScenes: { scenes: [{
        id: '1', title: null, date: '2001-01-01', created_at: stamp, updated_at: stamp,
        rating100: 80, interactive: true,
        paths: {
          stream: 'https://stash.example/scene/1/stream?apikey=secret',
          funscript: 'https://stash.example/scene/1/funscript?apikey=secret',
          screenshot: 'https://stash.example/scene/1/screenshot?apikey=secret',
          preview: 'https://stash.example/scene/1/preview?apikey=secret',
          sprite: 'https://stash.example/scene/1/sprite?apikey=secret',
          vtt: 'https://stash.example/scene/1/vtt?apikey=secret',
        },
        files: [{ path: 'C:\\Media\\Movie_180_sbs.mp4', duration: 10, width: 3840, height: 1920, size: 123, video_codec: 'hevc' }],
        tags: [{ name: 'coast' }], studio: null,
        details: 'An outdoor walk.', performers: [{ id: 'person-1', name: 'Mira Vale', alias_list: ['MV'] }],
      }] } },
    )
    const entries: RemoteEntry[] = []
    for await (const batch of adapter().scenes(new Map(), () => {})) entries.push(...batch)
    expect(entries[0]?.scene).toMatchObject({
      title: 'Movie_180_sbs', addedAt: Date.parse(stamp),
      stream: 'https://stash.example/scene/1/stream',
      scripts: [{ name: '', url: 'https://stash.example/scene/1/funscript' }],
      thumb: 'https://stash.example/scene/1/screenshot',
      preview: { video: 'https://stash.example/scene/1/preview', sprite: 'https://stash.example/scene/1/sprite', vtt: 'https://stash.example/scene/1/vtt' },
      projection: { kind: 'equirect180', layout: 'sbs' },
      description: 'An outdoor walk.', performers: [{ key: 'person-1', name: 'Mira Vale', aliases: ['MV'] }],
      tags: ['coast'], filename: 'Movie_180_sbs.mp4',
    })
  })

  it('fetches every group page and orders direct members by scene index', async () => {
    const member = (id: string, group: string, index: number | null) => ({ id, groups: [{ group: { id: group }, scene_index: index }] })
    const fetchMock = responses(
      { findGroups: { count: 2, groups: [{ id: 'g1', name: 'Collection', scenes: [member('10', 'g1', null), member('2', 'g1', null), member('8', 'g1', 2), member('9', 'g1', 1), member('1', 'child', 0)] }] } },
      { findGroups: { count: 2, groups: [{ id: 'g2', name: 'Empty', scenes: [] }] } },
    )
    expect(await adapter().groups()).toEqual([
      { key: 'g1', name: 'Collection', sceneKeys: ['9', '8', '2', '10'] },
      { key: 'g2', name: 'Empty', sceneKeys: [] },
    ])
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).variables.filter.page).toBe(2)
  })

  it('rejects an incomplete group listing', async () => {
    responses({ findGroups: { count: 1, groups: [] } })
    await expect(adapter().groups()).rejects.toThrow('Incomplete group listing')
  })

  it('does not replace scene tags with an incomplete list when tag creation returns null', async () => {
    const fetchMock = responses(
      { findTags: { tags: [] } },
      { tagCreate: null },
      { findTags: { tags: [] } },
    )
    await expect(adapter().writeBack('1', { rating: 3, favourite: false, tags: ['new tag'] })).rejects.toThrow('Stash did not create the tag')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map((call) => String(call[1].body)).join('\n')).not.toContain('sceneUpdate')
  })

  it('rejects a nullable scene update result instead of acknowledging an unsaved change', async () => {
    responses({ findTags: { tags: [] } }, { sceneUpdate: null })
    await expect(adapter().writeBack('1', { rating: 0, favourite: false, tags: [] })).rejects.toThrow('Stash did not update the scene')
  })

  it('resolves a tag created concurrently before replacing scene tags', async () => {
    const fetchMock = responses(
      { findTags: { tags: [] } },
      { tagCreate: null },
      { findTags: { tags: [{ id: '9', name: 'new tag', aliases: [] }] } },
      { sceneUpdate: { id: '1' } },
    )
    await adapter().writeBack('1', { rating: 4, favourite: true, tags: ['new tag'] })
    expect(JSON.parse(fetchMock.mock.calls[3]![1].body).variables.input).toEqual({ id: '1', rating100: 80, tag_ids: ['9'] })
  })
})
