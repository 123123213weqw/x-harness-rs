declare module '*.css' {
  /** Build-owned raw CSS; consumers explicitly manage style lifecycle. */
  const css: string
  export default css
}
declare module '*.svg' {
  /** Repository-owned, bundled SVG source; never a network request. */
  const source: string
  export default source
}
