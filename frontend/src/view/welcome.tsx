// The session's opening card (`omp.welcome`): the Hermes mark and the version.

import type { JSX } from '@stencil-hq/tern'

/** What the welcome card shows. */
export interface WelcomeContext {
  /** Blob id of the uploaded logo, when the terminal took it. */
  logo?: string
  version: string
}

/** The session's opening card: logo lockup and version. */
export function welcomeNode(key: string, cx: WelcomeContext): JSX.Element {
  return (
    <card key={key} role="omp.welcome">
      <row align="center" gap="md" key="lockup" role="omp.welcome.lockup">
        {cx.logo ? <image alt="Hermes" blob={cx.logo} h={52} key="logo" role="omp.welcome.logo" w={52} /> : null}
        <col key="mark" role="omp.welcome.mark">
          <text key="wordmark" role="omp.welcome.wordmark" spans={[{ s: 'strong', t: 'hermes' }]} wrap="none" />
          {cx.version ? (
            <text key="version" role="omp.welcome.version" spans={[{ s: 'dim mono', t: cx.version }]} wrap="none" />
          ) : null}
        </col>
      </row>
    </card>
  )
}
