import { useState } from 'react'
import type { AttachmentLoader, DurableAttachment } from './contracts'
interface FileCardProps {
  name: string | undefined; bytes: number; onRemove?: (() => void) | undefined; removeLabel?: string | undefined
  onDownload?: (() => void) | undefined; busy?: boolean | undefined; error?: boolean | undefined
}
export function FileCard({ name, bytes, onRemove, removeLabel, onDownload, busy, error }: FileCardProps) {
  const size = bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / 1048576).toFixed(1) + ' MiB'
  const Info = onDownload ? 'button' : 'div'
  return <div className="xh-file-card"><span aria-hidden>▤</span>
    <Info className="xh-file-info" onClick={onDownload} {...(Info === 'button' ? { disabled: busy } : {})} title={name}>
      <span className="xh-file-name">{name || '附件'}</span><span className="xh-file-size" role={error ? 'alert' : undefined}>{busy ? '正在读取…' : error ? '读取失败，点击重试' : size + (onDownload ? ' · 下载' : '')}</span>
    </Info>
    {onRemove && <button type="button" className="xh-file-remove" onClick={onRemove} aria-label={removeLabel || '移除 ' + name}>×</button>}
  </div>
}
export function HistoryFile({ attachment, load }: { attachment: DurableAttachment; load: AttachmentLoader }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const download = async () => {
    if (busy) return
    setBusy(true); setError(false)
    try {
      const url = await load(attachment)
      const link = document.createElement('a'); link.href = url; link.download = attachment.name || 'attachment'
      document.body.appendChild(link); link.click(); link.remove()
    } catch { setError(true) } finally { setBusy(false) }
  }
  return <FileCard name={attachment.name} bytes={attachment.bytes} onDownload={() => { void download() }} busy={busy} error={error} />
}
