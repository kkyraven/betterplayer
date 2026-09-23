export interface PhotoSize { width: number; height: number }
export interface PhotoCrop { zoom: number; x: number; y: number }

export const INITIAL_CROP: PhotoCrop = { zoom: 1, x: 0, y: 0 }

export function clampCrop(image: PhotoSize, crop: PhotoCrop): PhotoCrop {
  const zoom = Math.max(1, Math.min(3, crop.zoom))
  const scale = zoom / Math.min(image.width, image.height)
  const maxX = (image.width * scale - 1) / 2
  const maxY = (image.height * scale - 1) / 2
  return { zoom, x: Math.max(-maxX, Math.min(maxX, crop.x)), y: Math.max(-maxY, Math.min(maxY, crop.y)) }
}

export function cropBounds(image: PhotoSize, draft: PhotoCrop) {
  const crop = clampCrop(image, draft)
  const size = Math.min(image.width, image.height) / crop.zoom
  return { x: (image.width - size) / 2 - crop.x * size, y: (image.height - size) / 2 - crop.y * size, size }
}

export function cropPng(image: HTMLImageElement, crop: PhotoCrop): string {
  const source = cropBounds({ width: image.naturalWidth, height: image.naturalHeight }, crop)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 384
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not crop')
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, source.x, source.y, source.size, source.size, 0, 0, 384, 384)
  return canvas.toDataURL('image/png').split(',')[1]!
}
