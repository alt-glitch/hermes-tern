export const TERN_DROP: ReadonlySet<string>
export const TERN_BAD_VALUE: RegExp
export const TERN_BAD_SELECTOR: RegExp
export const TERN_BAD_MEDIA: RegExp
/** One declaration as Tern parses it, or undefined when Tern would reject it. */
export function ternDecl(decl: string): string | undefined
/** A declaration block with only what Tern parses. */
export function ternBody(body: string): string
/** Prefix of the data-* mirror the host writes for each non-data kit attribute. */
export const TERN_ATTR: string
/** A selector with each non-data attribute test moved to its data-eui-a- mirror. */
export function ternSelector(sel: string): string
