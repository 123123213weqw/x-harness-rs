import type { IconProps } from './icons/props'

/** Transparent folded X; currentColor reverses with the host theme. */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={['xh-logo-sweep', className].filter(Boolean).join(' ')}
      viewBox="0 0 64 64"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M57.01 5.59H44.27L6.99 49.86V58.41H19.73L57.01 14.14V5.59Z" fillOpacity="0.42" />
      <path d="M6.99 5.59H19.73L57.01 49.86V58.41H44.27L6.99 14.14V5.59Z" fillOpacity="0.9" />
    </svg>
  )
}
