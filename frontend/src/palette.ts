// Hermes skins as a Tern program palette (the `t` verb). Tern reads omp's
// theme token names (accent, mdHeading, statusLineModel, syntax*, toolDiff*,
// thinking*), so the skin's resolved Theme is mapped onto those, once per
// appearance.

import type { HermesSkin } from '@hermes/shared/skin'
import type { Palette } from '@stencil-hq/tern'
import { fromSkin, type ThemeColors } from '@tui/theme.js'

type Tokens = Record<string, string>

/** The palette for `skin`, in a dark and a light variant. */
export function paletteOf(skin: HermesSkin | undefined): Palette {
  const name = skin?.name || 'default'

  return {
    dark: tokensOf(resolve(skin, 'dark')),
    light: tokensOf(resolve(skin, 'light')),
    name: { dark: name, light: name }
  }
}

/**
 * The skin's colors for one polarity. `fromSkin` decides polarity from the
 * environment (`HERMES_TUI_LIGHT`), so pin it for the call; the overlay a
 * skin authors for that polarity wins over its base colors.
 */
function resolve(skin: HermesSkin | undefined, polarity: 'dark' | 'light'): ThemeColors {
  const light = polarity === 'light'
  const colors = { ...skin?.colors, ...(light ? skin?.light_colors : skin?.dark_colors) }
  const saved = process.env.HERMES_TUI_LIGHT
  process.env.HERMES_TUI_LIGHT = light ? '1' : '0'

  try {
    return fromSkin(colors, skin?.branding ?? {}).color
  } finally {
    if (saved === undefined) {
      delete process.env.HERMES_TUI_LIGHT
    } else {
      process.env.HERMES_TUI_LIGHT = saved
    }
  }
}

function tokensOf(c: ThemeColors): Tokens {
  const out: Tokens = {
    accent: c.accent,
    border: c.border,
    borderAccent: c.accent,
    borderMuted: c.sessionBorder,
    dim: c.sessionBorder,
    error: c.error,
    mdCode: c.syntaxString,
    mdCodeBlockBorder: c.border,
    mdHeading: c.primary,
    mdHr: c.border,
    mdLink: c.accent,
    mdLinkUrl: c.muted,
    mdListBullet: c.accent,
    mdQuote: c.muted,
    mdQuoteBorder: c.border,
    muted: c.muted,
    selectedBg: c.selectionBg,
    statusLineContext: c.label,
    statusLineCost: c.ok,
    statusLineDirty: c.warn,
    statusLineGitClean: c.ok,
    statusLineGitDirty: c.warn,
    statusLineModel: c.accent,
    statusLinePath: c.label,
    statusLineSep: c.sessionBorder,
    statusLineStaged: c.ok,
    statusLineUntracked: c.muted,
    success: c.ok,
    syntaxComment: c.syntaxComment,
    syntaxFunction: c.accent,
    syntaxKeyword: c.syntaxKeyword,
    syntaxNumber: c.syntaxNumber,
    syntaxString: c.syntaxString,
    syntaxType: c.primary,
    thinkingHigh: c.warn,
    thinkingLow: c.statusGood,
    thinkingMedium: c.accent,
    thinkingMinimal: c.muted,
    thinkingText: c.thinking,
    thinkingXhigh: c.statusBad,
    toolDiffAdded: c.diffAdded,
    toolDiffContext: c.muted,
    toolDiffRemoved: c.diffRemoved,
    toolOutput: c.muted,
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
