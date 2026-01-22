import type { IconProps } from './icons/props.ts'

/** Compact folded-X brand mark. The historical export name is retained for ABI compatibility. */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <path d="M58 6H46L6 50V58H18L58 14V6Z" fill="currentColor" fillOpacity="0.76" />
      <path d="M6 6H18L58 50V58H46L6 14V6Z" fill="currentColor" />
    </svg>
  )
}
