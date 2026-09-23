import { describe, expect, it } from 'vitest'
import { clampCrop, cropBounds, INITIAL_CROP } from './photo-crop'

describe('profile photo crop', () => {
  it('centres the largest square without stretching portraits or landscapes', () => {
    expect(cropBounds({ width: 1200, height: 800 }, INITIAL_CROP)).toEqual({ x: 200, y: 0, size: 800 })
    expect(cropBounds({ width: 800, height: 1200 }, INITIAL_CROP)).toEqual({ x: 0, y: 200, size: 800 })
  })

  it('keeps every edge inside the image at all supported zoom levels', () => {
    for (const image of [{ width: 1600, height: 900 }, { width: 900, height: 1600 }, { width: 400, height: 400 }]) {
      for (const zoom of [1, 1.25, 2, 3]) {
        for (const x of [-10, 0, 10]) {
          for (const y of [-10, 0, 10]) {
            const crop = cropBounds(image, { zoom, x, y })
            expect(crop.x).toBeGreaterThanOrEqual(-1e-9)
            expect(crop.y).toBeGreaterThanOrEqual(-1e-9)
            expect(crop.x + crop.size).toBeLessThanOrEqual(image.width + 1e-9)
            expect(crop.y + crop.size).toBeLessThanOrEqual(image.height + 1e-9)
          }
        }
      }
    }
  })

  it('reclamps pan when zooming out and maps rightward dragging to the left source edge', () => {
    const image = { width: 1200, height: 800 }
    const pan = clampCrop(image, { zoom: 3, x: 1, y: 1 })
    expect(clampCrop(image, { ...pan, zoom: 1 })).toEqual({ zoom: 1, x: 0.25, y: 0 })
    expect(cropBounds(image, { zoom: 1, x: 0.25, y: 0 }).x).toBe(0)
  })
})
