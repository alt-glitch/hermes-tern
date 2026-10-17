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
`
