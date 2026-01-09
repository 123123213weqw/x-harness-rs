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
          <path d="M0 16h14l20 16-20 16H0l20-16L0 16Z" fill="#1F5EFF" />
          <path
            d="M26 4h22l12 16L72 4h22L72 32l22 28H72L60 44 48 60H26l22-28L26 4Z"
            fill="currentColor"
          />
          <rect x="50" y="35" width="14" height="6" fill="#1F5EFF" />
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
