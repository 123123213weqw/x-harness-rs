import { useId } from 'react'
import type { IconProps } from './icons/props.ts'

/** Compact folded-X brand mark. The historical export name is retained for ABI compatibility. */
export function FishLogo({ size = 24, className }: IconProps) {
  const gradientId = useId()
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 64 64"
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
        <clipPath id={`${gradientId}-clip`}><path d="M58 6H46L6 50V58H18L58 14V6Z" /><path d="M6 6H18L58 50V58H46L6 14V6Z" /></clipPath>
        <linearGradient id={`${gradientId}-shine`}>
          <stop offset="0%" stopColor="white" stopOpacity="0" />
          <stop offset="50%" stopColor="white" stopOpacity="0.8" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M58 6H46L6 50V58H18L58 14V6Z" fill={`url(#${gradientId})`} fillOpacity="0.76" />
      <path d="M6 6H18L58 50V58H46L6 14V6Z" fill={`url(#${gradientId})`} />
      <g clipPath={`url(#${gradientId}-clip)`} pointerEvents="none">
        <rect className="xh-logo-sweep" x="-24" y="0" width="24" height="64" fill={`url(#${gradientId}-shine)`} />
      </g>
    </svg>
  )
}
