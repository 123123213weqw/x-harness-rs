import type { IconProps } from './icons/props.ts'

/** Compact xLang brand mark. The historical export name is retained for ABI compatibility. */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * 64) / 100}
      className={className}
      viewBox="0 0 100 64"
      fill="none"
      aria-hidden="true"
    >
      <path d="M0 16h14l20 16-20 16H0l20-16L0 16Z" fill="#1F5EFF" />
      <path
        d="M26 4h22l12 16L72 4h22L72 32l22 28H72L60 44 48 60H26l22-28L26 4Z"
        fill="currentColor"
      />
      <rect x="50" y="35" width="14" height="6" fill="#1F5EFF" />
    </svg>
  )
}
