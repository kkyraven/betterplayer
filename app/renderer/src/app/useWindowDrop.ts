import { useEffect, useState } from 'react'
import { electron } from '@/node'

export function useWindowDrop(onDrop: (paths: string[]) => void, enabled = true): boolean {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    setDragging(false)
    if (!enabled) return
    let depth = 0
    const reset = () => {
      depth = 0
      setDragging(false)
    }
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth += 1
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const paths = Array.from(e.dataTransfer?.files ?? [], (file) => electron.webUtils.getPathForFile(file)).filter(Boolean)
      if (paths.length > 0) onDrop(paths)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', reset, true)
    window.addEventListener('dragend', reset, true)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', reset, true)
      window.removeEventListener('dragend', reset, true)
      window.removeEventListener('drop', drop)
    }
  }, [onDrop, enabled])
  return dragging
}
