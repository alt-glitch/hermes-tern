// Bundled assets: esbuild's `binary` loader inlines them as bytes (scripts/build.mjs).
declare module '*.png' {
  const bytes: Uint8Array
  export default bytes
}
