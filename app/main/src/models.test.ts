import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Models } from './models'

vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en' } }))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-models-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

it('imports hand-fetched files by checksum under the model file names, and names the rest', async () => {
  const files = [
    { file: 'tagger.onnx', url: 'https://example.org/model.onnx', sha256: sha('weights') },
    { file: 'tagger.csv', url: 'https://example.org/selected_tags.csv', sha256: sha('tags') },
  ]
  const models = new Models(join(dir, 'data'), join(dir, 'bundled'), () => {})
  writeFileSync(join(dir, 'model.onnx'), 'weights')
  writeFileSync(join(dir, 'config.json'), '{}')

  const unknown = await models.import([join(dir, 'model.onnx'), join(dir, 'config.json')], files)

  expect(unknown).toEqual(['config.json'])
  expect(readFileSync(join(models.dir, 'tagger.onnx'), 'utf8')).toBe('weights')
  expect(readdirSync(models.dir)).toEqual(['tagger.onnx'])
})
