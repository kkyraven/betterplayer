export const TRACK_WIDTH = 384

let rgb = new Uint8Array(0)

export function toRgb(src: Uint8Array, width: number, height: number, bgra: boolean): { rgb: Uint8Array; width: number; height: number } {
  const w = Math.min(TRACK_WIDTH, width)
  const h = Math.max(2, Math.round((height * w) / width) & ~1)
  if (rgb.length !== w * h * 3) rgb = new Uint8Array(w * h * 3)
  const [ri, gi, bi] = bgra ? [2, 1, 0] : [0, 1, 2]
  for (let y = 0; y < h; y++) {
    const sy = Math.floor((y * height) / h)
    const row = sy * width * 4
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((x * width) / w)
      const i = row + sx * 4
      const o = (y * w + x) * 3
      rgb[o] = src[i + ri]!
      rgb[o + 1] = src[i + gi]!
      rgb[o + 2] = src[i + bi]!
    }
  }
  return { rgb, width: w, height: h }
}
