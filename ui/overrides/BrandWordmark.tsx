import { useId } from 'react'
import type { IconProps } from './icons/props.ts'

/** Display options kept compatible with the current upstream brand slot. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading X mark; defaults to true. */
  includeMark?: boolean | undefined
}

/** Responsive xLang wordmark derived from the project brand artwork. */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const gradientId = useId()
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
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="currentColor" />
          <stop offset="32%" stopColor="currentColor" stopOpacity="0.48" />
          <stop offset="48%" stopColor="currentColor" stopOpacity="0.9" />
          <stop offset="70%" stopColor="currentColor" stopOpacity="0.58" />
          <stop offset="100%" stopColor="currentColor" />
        </linearGradient>
        <clipPath id={`${gradientId}-clip`}><path d="M58 4H46L4 50V58H16L58 12V4Z" /><path d="M4 4H16L58 50V58H46L4 12V4Z" /></clipPath>
        <linearGradient id={`${gradientId}-shine`}>
          <stop offset="0%" stopColor="white" stopOpacity="0" />
          <stop offset="50%" stopColor="white" stopOpacity="0.8" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      {includeMark && (
        <>
          <path d="M58 4H46L4 50V58H16L58 12V4Z" fill={`url(#${gradientId})`} fillOpacity="0.76" />
          <path d="M4 4H16L58 50V58H46L4 12V4Z" fill={`url(#${gradientId})`} />
      <g clipPath={`url(#${gradientId}-clip)`} pointerEvents="none">
        <rect className="xh-logo-sweep" x="-24" y="0" width="24" height="64" fill={`url(#${gradientId}-shine)`} />
      </g>
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
