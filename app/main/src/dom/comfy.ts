// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import type { DomLora } from '@shared/dom'

const POLL_MS = 1000
const TIMEOUT_MS = 600_000
const WIDTH = 832
const HEIGHT = 1216

type Link = [string, number]
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export interface Files {
  checkpoints: string[]
  diffusion: string[]
  encoders: string[]
  vaes: string[]
  loras: string[]
}

const trim = (url: string) => url.replace(/\/+$/, '')

const isFlux = (files: Files, model: string) => (files.diffusion.includes(model) && !files.checkpoints.includes(model)) || /flux/i.test(model)

function choices(spec: unknown): string[] {
  if (!Array.isArray(spec)) return []
  const meta: unknown = spec[1]
  const list: unknown = Array.isArray(spec[0]) ? spec[0] : typeof meta === 'object' && meta !== null && 'options' in meta ? meta.options : null
  return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []
}

async function options(base: string, node: string, input: string): Promise<string[]> {
  const res = await fetch(`${base}/object_info/${node}`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`ComfyUI ${res.status}`)
  const info = (await res.json()) as Record<string, { input?: { required?: Record<string, unknown> } } | undefined>
  return choices(info[node]?.input?.required?.[input])
}

async function files(base: string): Promise<Files> {
  const [checkpoints, diffusion, encoders, vaes, loras] = await Promise.all([
    options(base, 'CheckpointLoaderSimple', 'ckpt_name'),
    options(base, 'UNETLoader', 'unet_name'),
    options(base, 'DualCLIPLoader', 'clip_name1'),
    options(base, 'VAELoader', 'vae_name'),
    options(base, 'LoraLoader', 'lora_name'),
  ])
  return { checkpoints, diffusion, encoders, vaes, loras }
}

export async function comfyFiles(url: string): Promise<{ models: string[]; flux: string[]; loras: string[] } | null> {
  try {
    const f = await files(trim(url))
    const models = [...new Set([...f.checkpoints, ...f.diffusion])]
    return { models, flux: models.filter((m) => isFlux(f, m)), loras: f.loras }
  } catch {
    return null
  }
}

function loaders(f: Files, model: string, graph: Graph): { model: Link; clip: Link; vae: Link } {
  if (!f.diffusion.includes(model) || f.checkpoints.includes(model)) {
    graph.ckpt = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } }
    return { model: ['ckpt', 0], clip: ['ckpt', 1], vae: ['ckpt', 2] }
  }
  const t5 = f.encoders.find((n) => /t5xxl/i.test(n))
  const clipL = f.encoders.find((n) => /clip_l/i.test(n))
  const ae = f.vaes.find((n) => /(^|[\\/])ae\.|flux/i.test(n))
  if (!t5 || !clipL) throw new Error('Flux needs clip_l and t5xxl in ComfyUI/models/text_encoders')
  if (!ae) throw new Error('Flux needs its VAE, ae.safetensors, in ComfyUI/models/vae')
  graph.unet = { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } }
  graph.clip = { class_type: 'DualCLIPLoader', inputs: { clip_name1: t5, clip_name2: clipL, type: 'flux' } }
  graph.vae = { class_type: 'VAELoader', inputs: { vae_name: ae } }
  return { model: ['unet', 0], clip: ['clip', 0], vae: ['vae', 0] }
}

export function comfyGraph(f: Files, checkpoint: string, prompt: string, negative: string, loras: DomLora[], seed: number): Graph {
  const graph: Graph = {}
  const out = loaders(f, checkpoint, graph)
  let { model, clip } = out
  loras.forEach((l, i) => {
    const id = `lora${i}`
    graph[id] = { class_type: 'LoraLoader', inputs: { model, clip, lora_name: l.name, strength_model: l.weight, strength_clip: l.weight } }
    model = [id, 0]
    clip = [id, 1]
  })
  const flux = isFlux(f, checkpoint)
  graph.pos = { class_type: 'CLIPTextEncode', inputs: { clip, text: prompt } }
  graph.neg = { class_type: 'CLIPTextEncode', inputs: { clip, text: flux ? '' : negative } }
  if (flux) graph.guide = { class_type: 'FluxGuidance', inputs: { conditioning: ['pos', 0], guidance: 3.5 } }
  graph.latent = { class_type: flux ? 'EmptySD3LatentImage' : 'EmptyLatentImage', inputs: { width: WIDTH, height: HEIGHT, batch_size: 1 } }
  const sampling = flux ? { steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple' } : { steps: 25, cfg: 6, sampler_name: 'euler_ancestral', scheduler: 'normal' }
  graph.sampler = { class_type: 'KSampler', inputs: { model, positive: [flux ? 'guide' : 'pos', 0], negative: ['neg', 0], latent_image: ['latent', 0], seed, denoise: 1, ...sampling } }
  graph.decode = { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: out.vae } }
  graph.save = { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'betterplayer_dom' } }
  return graph
}

interface History {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>
  status?: { status_str?: string; messages?: Array<[string, { exception_message?: string }]> }
}

async function rejection(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const body = JSON.parse(text) as { error?: { message?: string }; node_errors?: Record<string, { errors?: Array<{ details?: string }> }> }
    const detail = Object.values(body.node_errors ?? {}).flatMap((n) => n.errors ?? []).map((e) => e.details).find(Boolean)
    return [body.error?.message, detail].filter(Boolean).join(': ') || text.slice(0, 200)
  } catch {
    return text.slice(0, 200)
  }
}

export async function comfyImage(url: string, checkpoint: string, prompt: string, negative: string, loras: DomLora[]): Promise<string> {
  const base = trim(url)
  const graph = comfyGraph(await files(base), checkpoint, prompt, negative, loras, Math.floor(Math.random() * 2 ** 32))
  const res = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph }) })
  if (!res.ok) throw new Error(`ComfyUI ${res.status}: ${await rejection(res)}`)
  const { prompt_id: id } = (await res.json()) as { prompt_id?: string }
  if (!id) throw new Error('ComfyUI returned no prompt id')
  const until = Date.now() + TIMEOUT_MS
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const entry = ((await (await fetch(`${base}/history/${id}`)).json()) as Record<string, History | undefined>)[id]
    if (entry?.status?.status_str === 'error') {
      const failed = entry.status.messages?.find(([kind]) => kind === 'execution_error')?.[1].exception_message
      throw new Error(`ComfyUI failed: ${failed?.trim() || 'see its console'}`)
    }
    const image = Object.values(entry?.outputs ?? {}).flatMap((o) => o.images ?? [])[0]
    if (!image) continue
    const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type })
    const view = await fetch(`${base}/view?${q}`)
    if (!view.ok) throw new Error(`ComfyUI ${view.status}`)
    return `data:image/png;base64,${Buffer.from(await view.arrayBuffer()).toString('base64')}`
  }
  throw new Error('ComfyUI took too long')
}
