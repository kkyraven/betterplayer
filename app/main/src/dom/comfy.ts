// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import type { DomLora } from '@shared/dom'

const POLL_MS = 1000
const TIMEOUT_MS = 180_000
const WIDTH = 832
const HEIGHT = 1216

const trim = (url: string) => url.replace(/\/+$/, '')

async function comfyOptions(url: string, node: string, input: string): Promise<string[]> {
  try {
    const res = await fetch(`${trim(url)}/object_info/${node}`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const info = (await res.json()) as Record<string, { input?: { required?: Record<string, unknown[]> } }>
    const names = info[node]?.input?.required?.[input]?.[0]
    return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

export async function comfyFiles(url: string): Promise<{ checkpoints: string[]; loras: string[] }> {
  const [checkpoints, loras] = await Promise.all([comfyOptions(url, 'CheckpointLoaderSimple', 'ckpt_name'), comfyOptions(url, 'LoraLoader', 'lora_name')])
  return { checkpoints, loras }
}

export async function comfyImage(url: string, checkpoint: string, prompt: string, negative: string, loras: DomLora[]): Promise<string> {
  const base = trim(url)
  const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
  }
  let model: [string, number] = ['ckpt', 0]
  let clip: [string, number] = ['ckpt', 1]
  loras.forEach((l, i) => {
    const id = `lora${i}`
    graph[id] = { class_type: 'LoraLoader', inputs: { model, clip, lora_name: l.name, strength_model: l.weight, strength_clip: l.weight } }
    model = [id, 0]
    clip = [id, 1]
  })
  Object.assign(graph, {
    pos: { class_type: 'CLIPTextEncode', inputs: { clip, text: prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip, text: negative } },
    latent: { class_type: 'EmptyLatentImage', inputs: { width: WIDTH, height: HEIGHT, batch_size: 1 } },
    sampler: {
      class_type: 'KSampler',
      inputs: { model, positive: ['pos', 0], negative: ['neg', 0], latent_image: ['latent', 0], seed: Math.floor(Math.random() * 2 ** 32), steps: 25, cfg: 6, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1 },
    },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['ckpt', 2] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'betterplayer_dom' } },
  })
  const res = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph }) })
  if (!res.ok) throw new Error(`ComfyUI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const { prompt_id: id } = (await res.json()) as { prompt_id?: string }
  if (!id) throw new Error('ComfyUI returned no prompt id')
  const until = Date.now() + TIMEOUT_MS
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const history = (await (await fetch(`${base}/history/${id}`)).json()) as Record<string, { outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }>
    const image = Object.values(history[id]?.outputs ?? {}).flatMap((o) => o.images ?? [])[0]
    if (!image) continue
    const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type })
    const view = await fetch(`${base}/view?${q}`)
    if (!view.ok) throw new Error(`ComfyUI ${view.status}`)
    return `data:image/png;base64,${Buffer.from(await view.arrayBuffer()).toString('base64')}`
  }
  throw new Error('ComfyUI took too long')
}
