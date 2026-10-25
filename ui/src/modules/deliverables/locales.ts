/** `deliverables` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'deliverables'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'produced.label': '文件',
  'produced.moreOne': '+ 1 个文件',
  'produced.more': '+ {count} 个文件',
  'produced.open': '打开 {name}',
  'produced.showInFolder': '在文件夹中显示',
  'produced.actions': '文件操作',
  'produced.expand': '展开',
  'produced.collapse': '收起',
  'produced.preview': '内置预览',
  'produced.external': '默认应用打开',
  'produced.previewFile': '预览 {name}',
  'produced.revealFile': '在文件夹中显示 {name}',
  'produced.externalFile': '用默认应用打开 {name}',
  'produced.openIn': 'Open in',
  'produced.openInFile': '选择 {name} 的打开方式',
  'produced.type.website': 'Website',
  'produced.type.pdf': 'PDF document',
  'produced.type.markdown': 'Markdown',
  'produced.type.code': 'Source code',
  'produced.type.image': 'Image',
  'produced.type.spreadsheet': 'Spreadsheet',
  'produced.type.presentation': 'Presentation',
  'produced.type.document': 'Document',
  'produced.type.video': 'Video',
  'produced.type.audio': 'Audio',
  'produced.type.archive': 'Archive',
  'produced.type.file': 'File',
  'produced.type.data': 'Data file',
  'produced.info': '文件信息',
  'produced.infoFile': '{name} 的文件信息',
  'produced.copyPath': '复制路径',
  'produced.copied': '路径已复制',
  'produced.copyFailed': '路径复制失败',
  'produced.noPreview': '暂不支持内置预览，请从 Open in 选择打开方式。',
  'produced.tooLarge': '文件超过内置预览大小限制，可使用默认应用打开。',
  'produced.created': '新建',
  'produced.modified': '已修改',
  'produced.modifiedAt': '修改时间',
  'produced.closeInfo': '收起信息',
  'produced.remaining': '另有 {count} 个文件',
  'produced.loadMore': '显示更多文件',



}

/** English dictionary (same key set). */
export const en: Record<DeliverablesKey, string> = {
  'produced.label': 'Produced',
  'produced.moreOne': '+ 1 file',
  'produced.more': '+ {count} files',
  'produced.open': 'Open {name}',
  'produced.showInFolder': 'Show in folder',
  'produced.actions': 'File actions',
  'produced.expand': 'Expand',
  'produced.collapse': 'Collapse',
  'produced.preview': 'Preview',
  'produced.external': 'Open with default app',
  'produced.previewFile': 'Preview {name}',
  'produced.revealFile': 'Show {name} in folder',
  'produced.externalFile': 'Open {name} with default app',
  'produced.openIn': 'Open in',
  'produced.openInFile': 'Open in options for {name}',
  'produced.type.website': 'Website',
  'produced.type.pdf': 'PDF document',
  'produced.type.markdown': 'Markdown',
  'produced.type.code': 'Source code',
  'produced.type.image': 'Image',
  'produced.type.spreadsheet': 'Spreadsheet',
  'produced.type.presentation': 'Presentation',
  'produced.type.document': 'Document',
  'produced.type.video': 'Video',
  'produced.type.audio': 'Audio',
  'produced.type.archive': 'Archive',
  'produced.type.file': 'File',
  'produced.type.data': 'Data file',
  'produced.info': 'File information',
  'produced.infoFile': 'File information for {name}',
  'produced.copyPath': 'Copy path',
  'produced.copied': 'Path copied',
  'produced.copyFailed': 'Could not copy path',
  'produced.noPreview': 'No built-in preview. Choose an option from Open in.',
  'produced.tooLarge': 'Too large for built-in preview. Open with the default app.',
  'produced.created': 'Created',
  'produced.modified': 'Modified',
  'produced.modifiedAt': 'Modified',
  'produced.closeInfo': 'Close information',
  'produced.remaining': '{count} more files',
  'produced.loadMore': 'Show more files',



}

/** Union of this namespace's dictionary keys. */
export type DeliverablesKey = keyof typeof zh
