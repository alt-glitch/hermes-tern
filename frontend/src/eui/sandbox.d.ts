// Types of sandbox.js, the DOM sandbox the vendored ephemeral-ui kit runs in.

/** One element of a mounted card, as plain data. `id` is stable for the element's lifetime. */
export interface EuiEl {
  readonly t: 'el'
  readonly tag: string
  readonly id: number
  readonly cls: string
  readonly style: string
  readonly attrs: Readonly<Record<string, string>>
  /** The kit listens for a click, press or change on it (or it is a native control). */
  readonly click: boolean
  readonly kids: readonly EuiNode[]
}

export interface EuiText {
  readonly t: 'text'
  readonly text: string
}

/** An inline <svg>, serialized whole (Tern draws SVG as an image). */
export interface EuiSvg {
  readonly t: 'svg'
  readonly svg: string
  readonly w: number
  readonly h: number
  readonly cls: string
  readonly style: string
}

export type EuiNode = EuiEl | EuiText | EuiSvg

export interface EuiMounted {
  /** The catalog app the card was drawn for (the requested one, else the kind's first app). */
  readonly app: string
  readonly label: string
  snapshot(): EuiNode | null
  /** Replays a user's click on element `id` into the card; false when it is gone or disabled. */
  click(id: number): boolean
  dispose(): void
}

export interface EuiApp {
  readonly id: string
  readonly name: string
  readonly kinds: readonly string[]
}

export interface EuiSandbox {
  readonly kinds: readonly string[]
  apps(): readonly EuiApp[]
  mount(kind: string, app: string, onChange: () => void): EuiMounted
}

export function vendorDir(candidates: readonly string[]): string
export function createSandbox(dir: string, scheme?: 'light' | 'dark', log?: (error: unknown) => void): Promise<EuiSandbox>
