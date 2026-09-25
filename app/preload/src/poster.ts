import { ipcRenderer, nativeImage } from 'electron'

ipcRenderer.on('poster:decode', (_event, id: number, bytes: Uint8Array) => {
  try {
    const buffer = Buffer.from(bytes)
    const image = nativeImage.createFromBuffer(buffer)
    const { width, height } = image.getSize()
    if (image.isEmpty() || width * height > 100_000_000) throw new Error('Invalid thumbnail')
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    ipcRenderer.send('poster:decoded', { id, bytes: jpeg ? buffer : image.resize({ width: 480 }).toJPEG(85) })
  } catch {
    ipcRenderer.send('poster:decoded', { id, error: true })
  }
})
