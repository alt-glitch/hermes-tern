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

  /* A turn Hermes started by itself: set apart from the answer above, like a new prompt is. */
  [data-role='omp.turn.continued'] {
    margin-top: 28px !important;
    margin-bottom: 4px !important;
    font-family: var(--sans) !important;
  }
`
