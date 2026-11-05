export const TERN_DROP: ReadonlySet<string>
export const TERN_BAD_VALUE: RegExp
export const TERN_BAD_SELECTOR: RegExp
export const TERN_BAD_MEDIA: RegExp
/** One declaration as Tern parses it, or undefined when Tern would reject it. */
export function ternDecl(decl: string): string | undefined
/** A declaration block with only what Tern parses. */
export function ternBody(body: string): string
