import type { IconProps } from './icons/props'

/** Display options kept compatible with the current upstream brand slot. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading X mark; defaults to true. */
  includeMark?: boolean | undefined
}

/** Responsive wordmark paired with the transparent, theme-aware X mark. */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const width = includeMark ? 340 : 232
  return (
    <svg
      width={(size * width) / 64}
      height={size}
      className={className}
      viewBox={includeMark ? '0 0 340 64' : '108 0 232 64'}
      fill="none"
      aria-hidden="true"
    >
      {includeMark && (
        <g className="xh-logo-sweep" fill="currentColor">
          <path d="M57.01 5.59H44.27L6.99 49.86V58.41H19.73L57.01 14.14V5.59Z" fillOpacity="0.42" />
          <path d="M6.99 5.59H19.73L57.01 49.86V58.41H44.27L6.99 14.14V5.59Z" fillOpacity="0.9" />
        </g>
      )}
      <text
        x="108"
        y="51"
        fill="currentColor"
        fontFamily="Rajdhani, Orbitron, ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="45"
        fontWeight="600"
        letterSpacing="2.2"
      >
        XHarness
      </text>
    </svg>
  )
}
