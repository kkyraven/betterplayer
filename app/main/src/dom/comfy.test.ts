import { afterEach, describe, expect, it, vi } from 'vitest'
import { comfyFiles, comfyGraph, type Files } from './comfy'

function serve(lists: Record<string, string[]>) {
  const inputs: Record<string, [string, string]> = {
    CheckpointLoaderSimple: ['ckpt_name', 'combo'],
    UNETLoader: ['unet_name', 'list'],
    DualCLIPLoader: ['clip_name1', 'list'],
    VAELoader: ['vae_name', 'list'],
    LoraLoader: ['lora_name', 'list'],
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const node = String(url).split('/').pop() ?? ''
    const [input, shape] = inputs[node] ?? ['', 'list']
    const names = lists[node] ?? []
    const spec = shape === 'combo' ? ['COMBO', { options: names }] : [names]
    return new Response(JSON.stringify({ [node]: { input: { required: { [input]: spec } } } }))
  })
}

const flux: Files = { checkpoints: ['sdxl.safetensors'], diffusion: ['flux1-dev.safetensors'], encoders: ['clip_l.safetensors', 't5xxl_fp16.safetensors'], vaes: ['ae.safetensors'], loras: [] }

describe('ComfyUI', () => {
  afterEach(() => vi.restoreAllMocks())

  it('lists checkpoints and diffusion models, and marks Flux', async () => {
    serve({ CheckpointLoaderSimple: ['sdxl.safetensors', 'flux1-dev-fp8.safetensors'], UNETLoader: ['fluxDevNsfw.safetensors'], LoraLoader: ['a.safetensors'] })
    expect(await comfyFiles('http://127.0.0.1:8188/')).toEqual({
      models: ['sdxl.safetensors', 'flux1-dev-fp8.safetensors', 'fluxDevNsfw.safetensors'],
      flux: ['flux1-dev-fp8.safetensors', 'fluxDevNsfw.safetensors'],
      loras: ['a.safetensors'],
    })
  })

  it('reports a ComfyUI it cannot reach as null, even one with no checkpoints', async () => {
    serve({ UNETLoader: ['flux1-dev.safetensors'] })
    expect(await comfyFiles('http://127.0.0.1:8188')).not.toBeNull()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    expect(await comfyFiles('http://127.0.0.1:8188')).toBeNull()
  })

  it('loads a Flux diffusion model with its encoders and VAE, at cfg 1 with guidance', () => {
    const g = comfyGraph(flux, 'flux1-dev.safetensors', 'tags', 'ugly', [{ name: 'l.safetensors', weight: 0.8 }], 1)
    expect(g.unet?.inputs).toMatchObject({ unet_name: 'flux1-dev.safetensors' })
    expect(g.clip?.inputs).toMatchObject({ clip_name1: 't5xxl_fp16.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' })
    expect(g.lora0?.inputs).toMatchObject({ model: ['unet', 0], clip: ['clip', 0] })
    expect(g.sampler?.inputs).toMatchObject({ model: ['lora0', 0], positive: ['guide', 0], cfg: 1, scheduler: 'simple' })
    expect(g.decode?.inputs.vae).toEqual(['vae', 0])
    expect(g.neg?.inputs.text).toBe('')
  })

  it('keeps the SDXL graph for other checkpoints', () => {
    const g = comfyGraph(flux, 'sdxl.safetensors', 'tags', 'ugly', [], 1)
    expect(g.unet).toBeUndefined()
    expect(g.sampler?.inputs).toMatchObject({ model: ['ckpt', 0], positive: ['pos', 0], cfg: 6 })
    expect(g.neg?.inputs.text).toBe('ugly')
  })

  it('names the files a Flux model is missing', () => {
    expect(() => comfyGraph({ ...flux, encoders: [] }, 'flux1-dev.safetensors', '', '', [], 1)).toThrow('clip_l and t5xxl')
  })
})
