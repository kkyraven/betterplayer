import { Upload } from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'
import { downloadKindOf, type DownloadFile, type DownloadKind } from '@shared/downloads'
import { cx } from '@/lib/cx'
import { electron } from '@/node'
import { useDownloads } from '@/state/downloads'
import { useT } from '@/state/i18n'

const ACCEPT: Record<DownloadKind, string> = { video: '.mp4,.m4v,.mov,.mkv,.webm,.avi', script: '.funscript', archive: '.zip', unknown: '.mp4,.m4v,.mov,.mkv,.webm,.avi,.funscript,.zip' }
const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

export function FileDrop({ file }: { file: DownloadFile }) {
  const t = useT()
  const attach = useDownloads((state) => state.attachFile)
  const [over, setOver] = useState(false)
  const [wrong, setWrong] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const take = (picked: File | undefined) => {
    if (!picked) return
    const path = electron.webUtils.getPathForFile(picked)
    const kind = downloadKindOf(picked.name)
    const fits = !!path && kind !== 'unknown' && (file.kind === 'unknown' || kind === file.kind)
    setWrong(!fits)
    if (fits) void attach(file.id, path)
  }
  return (
    <>
      <button
        type="button"
        className={cx('download-drop', over && 'over', wrong && 'wrong')}
        onClick={() => input.current?.click()}
        onDragEnter={(event) => { if (hasFiles(event)) { event.preventDefault(); setOver(true) } }}
        onDragOver={(event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
        onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(false) }}
        onDrop={(event) => {
          if (!hasFiles(event)) return
          event.preventDefault()
          event.stopPropagation()
          setOver(false)
          take(event.dataTransfer.files[0])
        }}
      >
        <Upload />
        <span>{wrong ? t('downloads.manual.wrongFile') : t('downloads.manual.drop')}</span>
      </button>
      <input ref={input} type="file" hidden accept={ACCEPT[file.kind]} onChange={(event) => { take(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
    </>
  )
}
