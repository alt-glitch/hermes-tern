export interface SvgRule { readonly sel: string; readonly decls: readonly (readonly [string, string])[] }
export function svgRules(css: string, scheme: 'light' | 'dark' | string): SvgRule[]
export function resolveValue(value: string, lookup: (name: string) => string | undefined, depth?: number): string
export function svgInline(svg: Element, rules: readonly SvgRule[], theme: Readonly<Record<string, unknown>>): string
