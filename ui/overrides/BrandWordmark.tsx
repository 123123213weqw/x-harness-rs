import type { IconProps } from './icons/props.ts'

/** Display options kept compatible with the current upstream brand slot. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading X mark; defaults to true. */
  includeMark?: boolean | undefined
}

/** Responsive xLang wordmark derived from the project brand artwork. */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const width = includeMark ? 300 : 192
  return (
    <svg
      width={(size * width) / 64}
      height={size}
      className={className}
      viewBox={includeMark ? '0 0 300 64' : '108 0 192 64'}
      fill="none"
      aria-hidden="true"
    >
      {includeMark && (
        <>
          <path d="M58 4H46L4 50V58H16L58 12V4Z" fill="currentColor" fillOpacity="0.76" />
          <path d="M4 4H16L58 50V58H46L4 12V4Z" fill="currentColor" />
        </>
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
        xLang
      </text>
    </svg>
  )
}
