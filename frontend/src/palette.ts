// The program palette (the `t` verb) for each theme mode. A `t` replaces the previous palette
// whole and an empty one leaves every token to Tern, so:
//
// - `tern` (the default) sends nothing: the user's Tern theme colors everything, light and dark.
// - `nous` is the Nous look (video-lab taste): bone ink, quiet grays, blue links, and gold kept
//   for the few accent moments (a finished agent, the selected row), never for text at large.
// - `skin` takes the Hermes skin's semantic colors only (accent, success, warning, error).
//   Muted and dim text stay Tern's: Hermes derives them from the accent, which turned every
//   secondary line gold.

import type { HermesSkin } from '@hermes/shared/skin'
import type { Palette } from '@stencil-hq/tern'
import { fromSkin, type ThemeColors } from '@tui/theme.js'

import type { ThemeMode } from './settings.js'

type Tokens = Record<string, string>

const NOUS: { dark: Tokens; light: Tokens } = {
  dark: {
    accent: '#F5B820',
    dim: '#77746D',
    error: '#E5484D',
    mdLink: '#7A9CFF',
    muted: '#9A968C',
    selectedBg: '#26262A',
    statusLinePath: '#9A968C',
    text: '#EDE8DC'
  },
  light: {
    accent: '#956E00',
    dim: '#8A867C',
    error: '#C93C42',
    mdLink: '#2F5BD8',
    muted: '#6B675E',
    statusLinePath: '#6B675E'
  }
}

/** The palette `mode` sends; `skin` only matters in `skin` mode. */
export function paletteFor(mode: ThemeMode, skin: HermesSkin | undefined): Palette {
  if (mode === 'nous') {
    return { dark: NOUS.dark, light: NOUS.light, name: { dark: 'nous', light: 'nous' } }
  }

  if (mode === 'skin' && skin) {
    const name = skin.name || 'default'

    return {
      dark: semantic(resolve(skin, 'dark')),
      light: semantic(resolve(skin, 'light')),
      name: { dark: name, light: name }
    }
  }

  return { dark: {}, light: {}, name: { dark: 'tern', light: 'tern' } }
}

/**
 * The skin's colors for one polarity. `fromSkin` decides polarity from the
 * environment (`HERMES_TUI_LIGHT`), so pin it for the call; the overlay a
 * skin authors for that polarity wins over its base colors.
 *
 * Boundary: this writes the environment for a Hermes call that reads it. It
 * is not a launch setting, so it stays out of LaunchEnv (config/env.ts).
 */
function resolve(skin: HermesSkin, polarity: 'dark' | 'light'): ThemeColors {
  const light = polarity === 'light'
  const colors = { ...skin.colors, ...(light ? skin.light_colors : skin.dark_colors) }
  const saved = process.env['HERMES_TUI_LIGHT']
  process.env['HERMES_TUI_LIGHT'] = light ? '1' : '0'

  try {
    return fromSkin(colors, skin.branding ?? {}).color
  } finally {
    if (saved === undefined) {
      delete process.env['HERMES_TUI_LIGHT']
    } else {
      process.env['HERMES_TUI_LIGHT'] = saved
    }
  }
}

function semantic(c: ThemeColors): Tokens {
  const out: Tokens = {
    accent: c.accent,
    borderAccent: c.accent,
    error: c.error,
    mdListBullet: c.accent,
    statusLineModel: c.accent,
    success: c.ok,
    warning: c.warn
  }

  // Tern reads #rrggbb (and #rgb); drop anything an ANSI fallback produced.
  for (const key in out) {
    if (!/^#[0-9a-f]{3,8}$/i.test(out[key] ?? '')) {
      delete out[key]
    }
  }

  return out
}
