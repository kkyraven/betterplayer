import type { ModelInfo } from './tracking'

const REPO = 'https://huggingface.co/SmilingWolf/wd-vit-tagger-v3'

export const TAGGER_MODEL: ModelInfo = {
  id: 'wd-vit-v3',
  label: 'WD ViT Tagger v3',
  kind: 'tagger',
  version: 'v3',
  files: [
    { file: 'wd-vit-tagger-v3.onnx', url: `${REPO}/resolve/main/model.onnx`, sha256: '35f23693620b668f4d53fd3c62bf65e40af739bc52c7eb0fbc49258b58d065b6' },
    { file: 'wd-vit-tagger-v3.csv', url: `${REPO}/resolve/main/selected_tags.csv`, sha256: '298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217' },
  ],
  bundled: false,
  sizeMb: 362,
  licence: 'Apache-2.0',
  licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0.txt',
  sourceUrl: REPO,
  consent: true,
}
export const TAGGER_WEIGHTS = TAGGER_MODEL.files[0]!.file
export const TAGGER_TAGS_FILE = TAGGER_MODEL.files[1]!.file

export const TAGGER_INPUT = 448

export const TAGGER_STILLS = [0.1, 0.3, 0.5, 0.7, 0.9] as const

export const TAGGER_THRESHOLDS = [0.83, 0.8, 0.75, 0.65, 0.6] as const

export const TAG_CATEGORY_GENERAL = 0

export interface TagEntry {
  name: string
  category: number
}

export function parseTagList(csv: string): TagEntry[] {
  const out: TagEntry[] = []
  const lines = csv.split(/\r?\n/)
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const [, name = '', category = ''] = line.split(',')
    out.push({ name, category: Number.parseInt(category, 10) })
  }
  return out
}

export function selectTags(tags: readonly TagEntry[], stills: readonly ArrayLike<number>[], thresholds: readonly number[] = TAGGER_THRESHOLDS): string[] {
  const picked: { name: string; p: number }[] = []
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]
    if (!tag || tag.category !== TAG_CATEGORY_GENERAL || !tag.name) continue
    const probs = stills.map((still) => still[i] ?? 0).sort((a, b) => b - a)
    const kept = probs.some((p, n) => p >= (thresholds[n] ?? thresholds[thresholds.length - 1] ?? Infinity))
    if (kept) picked.push({ name: displayName(tag.name), p: probs[0] ?? 0 })
  }
  picked.sort((a, b) => b.p - a.p)
  return picked.map((t) => t.name)
}

const displayName = (name: string) => (/[a-z0-9]/i.test(name) ? name.replace(/_/g, ' ') : name)
