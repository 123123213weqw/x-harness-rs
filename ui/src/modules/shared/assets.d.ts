declare module '*.css' {
  /** Build-owned raw CSS; consumers explicitly manage style lifecycle. */
  const css: string
  export default css
}
