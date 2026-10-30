import css from './LoadingIndicator.styles'

export interface LoadingIndicatorProps {
  active: boolean
  label: string
}

// Twelve 2px squares trace a single 16px ring. Only opacity moves; the
// square edges remain aligned to the pixel grid instead of rotating the SVG.
const pixels = [[5, 0], [9, 0], [12, 2], [14, 5], [14, 9], [12, 12],
  [9, 14], [5, 14], [2, 12], [0, 9], [0, 5], [2, 2]] as const

/** Presentation only: the caller owns the authoritative activity state. */
export function LoadingIndicator({ active, label }: LoadingIndicatorProps) {
  if (!active) return null
  return (
    <div className={css.root} role="status" aria-live="polite" aria-label={label} data-xh-loading-indicator="true">
      <svg className={css.icon} data-xh-loading-ring="true" width="16" height="16" viewBox="0 0 16 16"
        fill="currentColor" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
        {pixels.map(([x, y], index) => <rect key={index} className={css.pixel}
          x={x} y={y} width="2" height="2" style={{ animationDelay: `${index * 100 - 1200}ms` }} />)}
      </svg>
    </div>
  )
}
