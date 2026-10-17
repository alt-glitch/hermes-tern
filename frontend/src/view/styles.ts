// The plugin's own stylesheet over Tern's: only what roles alone cannot say.

import { css } from '@stencil-hq/tern'

export const STYLES = css`
  /* The work log, as t3code draws it: quiet 14px rows in the UI face, a 24px line each. */
  [data-role='hermes.turn.working'],
  [data-role='hermes.turn.fold'] > .sf-section-head,
  [data-role='hermes.work.group'] > .sf-section-head,
  [data-role='hermes.work.row'] > .sf-section-head,
  .sf-col[data-role='hermes.work.row'],
  .sf-row[data-role='hermes.work.row'] {
    font: 400 14px/24px var(--sans) !important;
    min-height: 24px;
  }

  /* "Working for 12s" and "Worked for 54s" head the turn, ruled off from what follows. */
  [data-role='hermes.turn.working'],
  [data-role='hermes.turn.fold'] > .sf-section-head {
    padding-bottom: 8px !important;
    margin-bottom: 6px !important;
    box-shadow: inset 0 -1px 0 rgba(128, 128, 128, 0.22) !important;
  }

  /* An open fold or group lists its steps and notes where they were, not in an indented code
     column: no guide line, no indent, the UI face at the answer's size. */
  :is([data-role='hermes.turn.fold'], [data-role='hermes.work.group'], [data-role='hermes.work.row']),
  :is([data-role='hermes.turn.fold'], [data-role='hermes.work.group'], [data-role='hermes.work.row']) > .sf-section-body {
    margin-left: 0 !important;
    padding-left: 0 !important;
    border: none !important;
    box-shadow: none !important;
    background: none !important;
  }

  :is([data-role='hermes.turn.fold'], [data-role='hermes.work.group'], [data-role='hermes.work.row'])::before,
  :is([data-role='hermes.turn.fold'], [data-role='hermes.work.group'], [data-role='hermes.work.row'])::after,
  :is([data-role='hermes.turn.fold'], [data-role='hermes.work.group'], [data-role='hermes.work.row']) > .sf-section-body::before,
  :is([data-role='hermes.turn.fold'], [data-role='hermes.work.group'], [data-role='hermes.work.row']) > .sf-section-body::after {
    display: none !important;
  }

  :is([data-role='hermes.turn.fold'], [data-role='hermes.work.group'], [data-role='hermes.work.row']) > .sf-section-body {
    font-family: var(--sans) !important;
    font-size: 14px !important;
  }

  [data-role='hermes.turn.fold'] > .sf-section-body > .sf-md {
    margin: 4px 0 10px !important;
  }

  [data-role='hermes.turn.working'] .sf-elapsed {
    margin-left: 4px;
  }

  /* The chevron follows the label: right after "Worked for", at the row's end on a step. */
  [data-role='hermes.turn.fold'] > .sf-section-head > .sf-chev,
  [data-role='hermes.work.row'] > .sf-section-head > .sf-chev {
    order: 2;
    opacity: 0.7;
  }

  [data-role='hermes.work.row'] > .sf-section-head > .sf-head {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* A group's summary has no chevron; when it started shows on hover. */
  [data-role='hermes.work.group'] > .sf-section-head > .sf-chev {
    display: none;
  }

  [data-role='hermes.work.group'] > .sf-section-head > .sf-head {
    flex: 1 1 auto;
    min-width: 0;
  }

  [data-role='hermes.work.time'] {
    opacity: 0;
    font-size: 12px !important;
    font-variant-numeric: tabular-nums;
  }

  [data-role='hermes.work.group'] > .sf-section-head:hover [data-role='hermes.work.time'] {
    opacity: 1;
  }

  /* What a step or thought opens to sits under its label, past the icon column: a call's
     command and output in the code face, a thought as prose. */
  [data-role='hermes.work.detail'],
  [data-role='hermes.work.thought'] {
    margin: 2px 0 8px 28px !important;
  }

  [data-role='hermes.work.detail'] {
    font-family: var(--mono) !important;
    font-size: 13px !important;
  }

  /* The session sidebar is a prefs sheet for its dock, not for settings: no search, no one-page
     strip, no page heading over the folder line. */
  .sf-prefs[data-id='layer.sidebar'] .pf-mark,
  .sf-prefs[data-id='layer.sidebar'] .pf-search,
  .sf-prefs[data-id='layer.sidebar'] .pf-groups,
  .sf-prefs[data-id='layer.sidebar'] .pf-eyebrow,
  .sf-prefs[data-id='layer.sidebar'] .pf-title {
    display: none !important;
  }

  .sf-prefs[data-id='layer.sidebar'] .pf-lead {
    font-family: var(--mono) !important;
    font-size: 12px !important;
    margin-top: 0 !important;
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
