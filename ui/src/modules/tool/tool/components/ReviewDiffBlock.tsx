import * as React from 'react'
import {DiffBlock} from '../../primitives'
import type {DiffBlockProps} from '../../primitives'
import {useTranscriptState} from '../../transcript-state'
import './ReviewDiffBlock.styles'

type Layout = 'inline' | 'split'
export interface ReviewDiffBlockProps extends DiffBlockProps {stateKey?: string | undefined}

function diffLines(text: string | null): string[] {
  if (text === null || text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/** Same bounded, persisted review affordance as the latest frozen Tool factory. */
export function XHReviewDiffBlock({diffs, maxLines, className, stateKey = ''}: ReviewDiffBlockProps) {
  const [layout, setLayout] = React.useState<Layout>(() => {
    try { return localStorage.getItem('xharness.ui.diff-layout.v1') === 'split' ? 'split' : 'inline' } catch { return 'inline' }
  })
  const [expanded, setExpanded] = useTranscriptState('diff:' + stateKey, false)
  const [copied, setCopied] = React.useState(false)
  const translate = (zh: string, en: string): string => (document.documentElement.lang || '').toLowerCase().startsWith('zh') ? zh : en
  const changeLayout = (value: Layout): void => {
    setLayout(value)
    try { localStorage.setItem('xharness.ui.diff-layout.v1', value) } catch { /* memory only */ }
  }
  const copy = async (): Promise<void> => {
    const text = diffs.map(({path, oldText, newText}) => `${path}\n--- before\n${oldText ?? ''}\n+++ after\n${newText}`).join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1200)
    } catch { /* no clipboard permission */ }
  }
  const maxPreview = 500
  const panes = layout === 'split' ? diffs.map((diff, index) => {
    const oldLines = diffLines(diff.oldText)
    const newLines = diffLines(diff.newText)
    const length = Math.max(oldLines.length, newLines.length)
    const absoluteCap = 3000
    const shown = Math.min(length, expanded ? absoluteCap : maxPreview)
    const left = React.createRef<HTMLDivElement>(), right = React.createRef<HTMLDivElement>()
    const syncing = {active: false}
    const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null): void => {
      if (syncing.active || !from || !to) return
      syncing.active = true
      to.scrollTop = from.scrollTop
      to.scrollLeft = from.scrollLeft
      requestAnimationFrame(() => { syncing.active = false })
    }
    const side = (lines: readonly string[], other: readonly string[], title: string, ref: React.RefObject<HTMLDivElement>, otherRef: React.RefObject<HTMLDivElement>) => React.createElement('div', {
      className: 'xh-review-pane', ref, onScroll: (event: React.UIEvent<HTMLDivElement>) => { sync(event.currentTarget, otherRef.current) }, key: title,
    }, [React.createElement('span', {className: 'xh-review-pane-heading', key: 'heading'}, title),
      ...Array.from({length: shown}, (_, lineIndex) => React.createElement('div', {
        className: 'xh-review-line', 'data-changed': lines[lineIndex] !== other[lineIndex], key: lineIndex,
      }, [React.createElement('span', {className: 'xh-review-line-number', key: 'number'}, lineIndex < lines.length ? lineIndex + 1 : ''),
        React.createElement('span', {className: 'xh-review-line-code', key: 'code'}, lines[lineIndex] ?? ' ')]))])
    return React.createElement('div', {className: 'xh-review-file', key: `${diff.path}:${index}`}, [
      React.createElement('div', {className: 'xh-review-path', title: diff.path, key: 'path'}, diff.path),
      React.createElement('div', {className: 'xh-review-panes', key: 'panes'}, [
        side(oldLines, newLines, translate('修改前', 'Before'), left, right),
        side(newLines, oldLines, translate('修改后', 'After'), right, left),
      ]),
      length > maxPreview && React.createElement('button', {
        type: 'button', className: 'xh-review-truncated', onClick: () => { setExpanded(value => !value) }, key: 'more',
      }, expanded
        ? translate(length > absoluteCap ? `仅预览前 ${absoluteCap} 行 · 点击收起，完整内容可复制` : '收起', length > absoluteCap ? `Preview capped at ${absoluteCap} lines · full diff can be copied` : 'Show less')
        : translate(`展开预览（${length} 行）`, `Expand preview (${length} lines)`)),
    ])
  }) : null
  const layouts: readonly Layout[] = ['inline', 'split']
  return React.createElement('div', {className: `xh-review ${className || ''}`, 'data-xh-diff-layout': layout}, [
    React.createElement('div', {className: 'xh-review-toolbar', key: 'toolbar'}, [
      React.createElement('span', {className: 'xh-review-title', key: 'title'}, translate('文件差异', 'File diff')),
      React.createElement('div', {className: 'xh-review-actions', role: 'group', 'aria-label': translate('差异布局', 'Diff layout'), key: 'actions'}, [
        ...layouts.map(value => React.createElement('button', {type: 'button', 'aria-pressed': layout === value, onClick: () => { changeLayout(value) }, key: value},
          value === 'inline' ? translate('行内', 'Inline') : translate('并排', 'Side by side'))),
        layout === 'split' && React.createElement('button', {type: 'button', onClick: copy, key: 'copy'}, copied ? translate('已复制', 'Copied') : translate('复制', 'Copy')),
      ]),
    ]),
    layout === 'inline'
      ? React.createElement(DiffBlock, {diffs, maxLines, className, key: 'inline'})
      : React.createElement('div', {key: 'split'}, panes),
  ])
}
export {XHReviewDiffBlock as ReviewDiffBlock}
