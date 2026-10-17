// The plugin's own stylesheet over Tern's: only what roles alone cannot say.

import { css } from '@stencil-hq/tern'

export const STYLES = css`
  /* A run's summary is prose ("Ran 2 commands, read 1 file"), not code: the UI face, not mono. */
  [data-role='omp.tools.run'] > .sf-section-head .sf-head {
    font-family: var(--sans) !important;
  }

  /* omp's ask theme draws a radio at the start of each option without moving the text over. */
  [data-role='omp.ask.option'] {
    padding-left: 34px !important;
  }

  /* A steer's status under its words is a note, not code. */
  [data-role='omp.user.steered'] {
    font-family: var(--sans) !important;
  }

  /* A pill holding the keys (Down from an empty prompt): ringed in the accent, without the pick mark's side bar. */
  .sf-row[data-role='omp.hud.pill'][data-mark='pick'] {
    box-shadow: inset 0 0 0 1px var(--accent) !important;
    color: var(--t1) !important;
  }

  .sf-row[data-role='omp.hud.pill'][data-mark='pick']::after {
    display: none;
  }

  /* What the keys do while a pill holds them, beside the pills. */
  .sf-row[data-role='omp.hud.hint'] {
    flex: none;
    gap: 4px;
    margin-right: 6px;
    font: 500 11px/1 var(--sans);
    color: var(--t3);
  }

  [data-role='omp.hud.hint'] .kbd {
    height: 15px;
    min-width: 18px;
    font-size: 10px;
  }

  /* A background card's process line opens the Background sheet. */
  .sf-row[data-role='omp.tool.process'] {
    cursor: pointer;
    border-radius: 4px;
  }

  .sf-row[data-role='omp.tool.process']:hover {
    background: var(--l1);
  }

  /* A turn Hermes started by itself: set apart from the answer above, like a new prompt is. */
  [data-role='omp.turn.continued'] {
    margin-top: 28px !important;
    margin-bottom: 4px !important;
    font-family: var(--sans) !important;
  }
`
