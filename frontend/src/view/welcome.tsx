// The session's opening card (`omp.welcome`): the Hermes mark, the version,
// and one discovery tip from hermes's tip catalog (`locales/en.yaml`, the
// same pool the classic CLI shows at startup).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { JSX } from '@stencil-hq/tern'

/** What the welcome card shows. */
export interface WelcomeContext {
  /** Blob id of the uploaded logo, when the terminal took it. */
  logo?: string
  version: string
  tip: string
}

/** The session's opening card: logo lockup, version and a tip. */
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
      {cx.tip ? (
        <row align="start" gap="sm" key="tip" role="omp.welcome.tip">
          <icon key="icon" name="lightbulb" role="omp.welcome.tip-icon" />
          <text key="text" role="omp.welcome.tip-text" text={cx.tip} wrap="word" />
        </row>
      ) : null}
    </card>
  )
}

const TIP_LINE = /^\s+t\d+:\s+"((?:[^"\\]|\\.)*)"\s*$/

/** A random tip from hermes's English catalog under `root`; '' when it can't be read. */
export function randomTip(root: string): string {
  let text: string

  try {
    text = readFileSync(join(root, 'locales', 'en.yaml'), 'utf8')
  } catch {
    return ''
  }

  const start = text.search(/^tips:\s*$/m)

  if (start < 0) {
    return ''
  }

  const tips: string[] = []

  for (const line of text.slice(start).split('\n').slice(1)) {
    if (/^\S/.test(line)) {
      break
    }

    const quoted = TIP_LINE.exec(line)?.[1]

    if (quoted) {
      tips.push(JSON.parse(`"${quoted}"`))
    }
  }

  return tips[Math.floor(Math.random() * tips.length)] ?? ''
}
