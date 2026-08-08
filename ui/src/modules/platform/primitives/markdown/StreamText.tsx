import { Fragment, useRef } from 'react'
import type { ReactNode } from 'react'
import type { StreamFrame } from './stream-presentation'
import { streamPieces } from './stream-presentation'
import css from './MarkdownText.module.css'

/** Retain animation age across Markdown reparenting, rather than replaying old text. */
function FadePiece({ text, at }: { text: string; at: number }) {
  const delay = useRef(-Math.max(0, Date.now() - at))
  return <span className={css.streamPiece} data-xh-stream-piece style={{ animationDelay: `${delay.current}ms` }}>{text}</span>
}

/** Plain text remains plain unless it intersects a recent append range. */
export function renderStreamText(value: string, offset: number, end: number, frame: StreamFrame): ReactNode {
  const pieces = streamPieces(value, offset, frame, Date.now(), end)
  if (pieces.every(piece => piece.at === undefined)) return value
  return pieces.map(piece => piece.at === undefined
    ? <Fragment key={piece.start}>{piece.text}</Fragment>
    : <FadePiece key={piece.start} text={piece.text} at={piece.at} />)
}
