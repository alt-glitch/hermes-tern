// The plugin's own stylesheet over Tern's: only what roles alone cannot say. Every color is one of
// Tern's theme vars (--t*, --l*, --sf-c-*, the palette's --sf-p-*), never a literal, so it changes
// with the user's theme and with /theme.

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
    box-shadow: inset 0 -1px 0 var(--l3) !important;
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

  /* An open group's steps hang from its summary: a guide line down from its icon, the rows a size
     smaller, so the summary reads as the parent and not as one more step. */
  [data-role='hermes.work.group'] > .sf-section-body {
    margin: 2px 0 6px 7px !important;
    padding-left: 17px !important;
    border-left: 1px solid var(--l3) !important;
  }

  [data-role='hermes.work.group'] > .sf-section-body [data-role='hermes.work.row'] > .sf-section-head,
  [data-role='hermes.work.group'] > .sf-section-body .sf-col[data-role='hermes.work.row'] {
    font-size: 13px !important;
    line-height: 22px !important;
    min-height: 22px;
  }

  /* The group's own chevron sits right after its summary and turns as it opens (Tern's is hidden). */
  [data-role='hermes.work.chev'] {
    opacity: 0.45;
    transition: transform 0.15s ease, opacity 0.15s ease;
  }

  .sf-section.collapsed > .sf-section-head [data-role='hermes.work.chev'] {
    transform: rotate(-90deg);
  }

  [data-role='hermes.work.group'] > .sf-section-head:hover [data-role='hermes.work.chev'] {
    opacity: 0.85;
  }

  /* The status strip under everything (hermes-for-tern's console bar): one quiet mono line, the
     brand in the accent, the send or stop key the strongest thing on it. */
  [data-role='hermes.statusline'] {
    margin-top: 6px !important;
    font: 400 11.5px/20px var(--mono) !important;
    color: var(--t3) !important;
  }

  [data-role='hermes.statusline.brand'] {
    color: var(--sf-p-accent, var(--sf-c-accent)) !important;
    font-weight: 600 !important;
  }

  [data-role='hermes.statusline.send'],
  [data-role='hermes.statusline.stop'] {
    color: var(--t1) !important;
    cursor: pointer;
  }

  [data-role='hermes.statusline.stop'] {
    color: var(--sf-c-error, var(--t1)) !important;
  }

  [data-role='hermes.statusline.warn'] {
    color: var(--sf-c-warning, var(--t2)) !important;
  }

  [data-role='hermes.statusline.bad'] {
    color: var(--sf-c-error, var(--t2)) !important;
  }

  [data-role='hermes.statusline.good'] {
    color: var(--sf-c-success, var(--t2)) !important;
  }

  /* While a turn runs, an accent streak sweeps the composer's top edge. */
  @keyframes hermes-streak {
    from {
      background-position: 0% 0;
    }

    to {
      background-position: 100% 0;
    }
  }

  [data-role='hermes.streak'] {
    height: 1px;
    margin: 0 18px -1px;
    background-image: linear-gradient(to right, transparent, var(--sf-p-accent, var(--accent)), transparent);
    background-size: 30% 100%;
    background-repeat: no-repeat;
    animation: hermes-streak 1.8s ease-in-out infinite alternate;
  }

  @media (prefers-reduced-motion: reduce) {
    [data-role='hermes.streak'] {
      animation: none;
      background-position: 50% 0;
    }
  }

  /* The todo list, opened from its pill: a panel above the composer. */
  [data-role='hermes.todos'] {
    width: min(736px, calc(100% - 8px));
    margin: 0 auto 8px !important;
    padding: 8px 12px !important;
    border-radius: 10px;
    background: var(--l1);
    max-height: 260px;
    overflow: auto;
  }

  [data-role='hermes.todos.pill'] .sf-meter {
    flex: none;
  }

  [data-role='hermes.todos.now'] {
    max-width: 360px;
  }

  /* The connect card's buttons: Authorize per app, Continue at the foot. */
  [data-role='hermes.connect.open'],
  [data-role='hermes.connect.continue'] {
    flex: none;
    padding: 2px 10px !important;
    border-radius: 999px;
    box-shadow: inset 0 0 0 1px var(--l3);
    font: 500 12px/20px var(--sans) !important;
    cursor: pointer;
  }

  [data-role='hermes.connect.open'] {
    color: var(--sf-p-accent, var(--sf-c-accent)) !important;
  }

  [data-role='hermes.connect.continue'] {
    background: var(--t1);
    color: var(--card) !important;
    box-shadow: none;
  }

  [data-role='hermes.connect.open']:hover,
  [data-role='hermes.connect.continue']:hover {
    opacity: 0.85;
  }

  [data-role='hermes.connect.row'] {
    min-height: 28px;
    font: 400 13px/22px var(--sans) !important;
  }

  /* An image the next prompt carries: Tern's omp chip (thumbnail, name, size) with a ✕ after
     them, in a third column of its grid. */
  .sf-card[data-role='omp.composer.chip'] > .sf-card-body > [data-role='hermes.composer.remove'] {
    grid-column: 3;
    grid-row: 1 / 3;
    align-self: center;
    width: 20px;
    height: 20px;
    margin-right: -6px;
    border-radius: 6px;
    color: var(--t3);
    cursor: pointer;
  }

  .sf-card[data-role='omp.composer.chip'] > .sf-card-body > [data-role='hermes.composer.remove']:hover {
    background: var(--l2);
    color: var(--t1);
  }

  /* A prompt's file, or an image whose file is gone: a quiet chip beside its thumbnails. */
  [data-role='hermes.user.attachment'] {
    max-width: 240px;
    padding: 1px 8px !important;
    border-radius: 999px;
    background: var(--l1);
    font: 500 12px/20px var(--sans) !important;
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
    box-shadow: inset 0 0 0 1px var(--sf-p-accent, var(--accent)) !important;
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

  /* The standing goal and loop, and the reconnect notice: quiet lines above the pills, as wide as
     the composer. A goal or loop part is a soft capsule that opens its sheet. */
  [data-role='hermes.automation'],
  [data-role='hermes.reconnect'] {
    width: min(736px, calc(100% - 8px));
    margin: 0 auto 6px !important;
    font: 400 12.5px/22px var(--sans) !important;
    color: var(--t2);
  }

  [data-role='hermes.reconnect'] {
    padding: 0 10px !important;
  }

  [data-role='hermes.reconnect'] .sf-elapsed,
  [data-role='hermes.automation.count'] {
    font-variant-numeric: tabular-nums;
    color: var(--t2);
  }

  /* Each capsule takes its content's width and gives way by truncating its words, never its count. */
  .sf-row[data-role='hermes.automation.item'] {
    flex: 0 1 auto;
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    padding: 1px 10px !important;
    border-radius: 999px;
    background: var(--l1);
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .sf-row[data-role='hermes.automation.item']:hover {
    background: var(--l2);
  }

  .sf-row[data-role='hermes.automation.item'][data-mark='pick'] {
    box-shadow: inset 0 0 0 1px var(--sf-p-accent, var(--accent)) !important;
  }

  .sf-row[data-role='hermes.automation.item'][data-mark='pick']::after {
    display: none;
  }

  [data-role='hermes.automation.label'] {
    flex: none;
    color: var(--t1);
    font-weight: 500;
  }

  [data-role='hermes.automation.what'] {
    flex: 0 1 auto !important;
    min-width: 0;
    overflow: hidden;
    color: var(--t2);
  }

  [data-role='hermes.automation.item'] > :not([data-role='hermes.automation.what']) {
    flex: none;
  }

  [data-role='hermes.automation.when'] {
    margin-left: 6px;
  }

  [data-role='hermes.automation.item'] .sf-meter {
    margin-left: 6px;
  }

  [data-role='hermes.automation.item'] .sf-meter {
    flex: none;
    width: 44px;
  }

  [data-role='hermes.automation.title'] {
    font-size: 15px !important;
  }

  /* Fast mode: a bolt on the model chip. */
  [data-role='hermes.composer.fast'] {
    margin-left: -2px;
  }

  [data-role='hermes.composer.fast'] + [data-role='hermes.composer.fast'] {
    margin-left: -7px;
  }

  /* A background card's process line opens the Background sheet. */
  .sf-row[data-role='omp.tool.process'] {
    cursor: pointer;
    border-radius: 4px;
  }

  .sf-row[data-role='omp.tool.process']:hover {
    background: var(--l1);
  }

  /* A one-agent delegation: the agent's own row as one soft tile, a click opening the agent. */
  .sf-agent[data-role='hermes.task.solo'] {
    margin: 6px 0 !important;
    padding: 6px 12px !important;
    border-radius: 10px;
    background: var(--sf-card-bg);
    box-shadow: inset 0 0 0 1px var(--l2);
    cursor: pointer;
    transition: background 120ms ease;
  }

  .sf-agent[data-role='hermes.task.solo']:hover {
    background: var(--l1);
  }

  /* A compaction: a quiet rule across the transcript, what happened in its middle. */
  [data-role='hermes.compaction'] {
    margin: 20px 0 !important;
  }

  .sf-row[data-role='hermes.compaction.line'] {
    font: 400 13px/22px var(--sans) !important;
    justify-content: center;
    min-width: 0;
  }

  .sf-row[data-role='hermes.compaction.line']::before,
  .sf-row[data-role='hermes.compaction.line']::after {
    content: '';
    flex: 1 1 24px;
    height: 1px;
    background: var(--l3);
  }

  [data-role='hermes.compaction.line'] .sf-elapsed {
    margin-left: 4px;
  }

  .sf-row[data-role='hermes.compaction.line']::before {
    margin-right: 6px;
  }

  .sf-row[data-role='hermes.compaction.line']::after {
    margin-left: 6px;
  }

  /* With its summary known, the rule opens it: the whole line is the head, the chevron after it. */
  [data-role='hermes.compaction'] > .sf-section-head {
    cursor: pointer;
    padding: 0 !important;
    background: none !important;
    border: none !important;
  }

  [data-role='hermes.compaction'] > .sf-section-head > .sf-head {
    flex: 1 1 auto;
    min-width: 0;
  }

  [data-role='hermes.compaction'] > .sf-section-head > .sf-chev {
    order: 2;
    opacity: 0.6;
    margin-left: 4px;
  }

  [data-role='hermes.compaction'] > .sf-section-body {
    margin: 10px 0 0 !important;
    padding: 2px 0 2px 14px !important;
    border: none !important;
    box-shadow: inset 2px 0 0 var(--l3) !important;
    background: none !important;
    font-family: var(--sans) !important;
    font-size: 14px !important;
  }

  /* A turn Hermes started by itself: set apart from the answer above, like a new prompt is. */
  [data-role='omp.turn.continued'] {
    margin-top: 28px !important;
    margin-bottom: 4px !important;
    font-family: var(--sans) !important;
  }

  /* ── Pull requests (prs/view.tsx): one view in the PR aside and the sheet ── */
  /* Prose in sans in the aside and the sheet (their text defaults to mono); code,
     paths and diffs keep mono. */
  :is([data-role='hermes.pr.frame'], [data-role='hermes.pr.asideview'])
    :is(.sf-text, .sf-md, .md, .sf-card-head, .sf-section-head, .sf-tabs, .sf-badge) {
    font-family: var(--sans) !important;
  }

  /* (Tern's \`:is()\` takes compound selectors only: \`.md code\` gets a rule of its own.) */
  :is([data-role='hermes.pr.frame'], [data-role='hermes.pr.asideview']) :is(.sf-t-mono, .sf-diff, .sf-code) {
    font-family: var(--mono) !important;
  }

  :is([data-role='hermes.pr.frame'], [data-role='hermes.pr.asideview']) .md code {
    font-family: var(--mono) !important;
  }

  :is([data-role='hermes.pr.frame'], [data-role='hermes.pr.asideview']) .sf-md {
    font-size: 14px;
  }

  /* GitHub ticks a done task; it does not strike it through. */
  :is([data-role='hermes.pr.frame'], [data-role='hermes.pr.asideview']) li.task.done :is(*, .li-t) {
    text-decoration: none !important;
    color: inherit !important;
  }

  [data-role='hermes.pr.head'] {
    padding: 2px 2px 0;
  }

  /* Each header row spans the view; its text takes the room its trailing parts leave. */
  [data-role='hermes.pr.head'] > .sf-row,
  [data-role='hermes.pr.tabs'] {
    align-self: stretch;
    width: 100%;
  }

  [data-role='hermes.pr.head'] > .sf-row > .sf-text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  [data-role='hermes.pr.head'] > .sf-row > :is([data-role='hermes.pr.checkout'], [data-role='hermes.pr.size']) {
    flex: none;
    margin-left: auto;
  }

  [data-role='hermes.pr.head'] > .sf-row > :is(.sf-badge, .sf-icon) {
    flex: none;
  }

  [data-role='hermes.pr.title'] {
    font: 600 19px/1.3 var(--sans) !important;
    letter-spacing: -0.01em;
    color: var(--t1) !important;
  }

  [data-role='hermes.pr.meta'],
  [data-role='hermes.pr.branch'] {
    font-size: 12.5px;
  }

  [data-role='hermes.pr.checkout'] {
    cursor: pointer;
  }

  [data-role='hermes.pr.tabs'] {
    padding: 8px 0;
    box-shadow: inset 0 1px 0 var(--l2), inset 0 -1px 0 var(--l2);
  }

  [data-role='hermes.pr.checkstate'] {
    cursor: pointer;
    font-size: 12.5px;
  }

  [data-role='hermes.pr.body'] {
    padding: 4px 2px 8px;
  }

  [data-role='hermes.pr.comment'],
  [data-role='hermes.pr.thread'] {
    background: var(--sf-card-bg) !important;
    box-shadow: inset 0 0 0 1px var(--l2) !important;
    border-radius: 10px !important;
  }

  [data-role='hermes.pr.comment'] > .sf-card-head,
  [data-role='hermes.pr.thread'] > .sf-card-head {
    box-shadow: inset 0 -1px 0 var(--l2);
    font-family: var(--sans) !important;
  }

  [data-role='hermes.pr.permalink'] {
    font-size: 12px;
  }

  [data-role='hermes.pr.reply'] {
    padding: 8px 0 0 12px;
    box-shadow: inset 2px 0 0 var(--l2);
  }

  [data-role='hermes.pr.event'],
  [data-role='hermes.pr.commits'] {
    padding: 0 6px;
    font-size: 13px;
  }

  [data-role='hermes.pr.commit'] {
    padding-left: 22px;
    font-size: 12.5px;
  }

  [data-role='hermes.pr.details'] > .sf-section-head {
    font-weight: 600;
  }

  /* The file list beside the diffs where there is room, above them where there is not. */
  [data-role='hermes.pr.files'] {
    flex-wrap: wrap;
  }

  [data-role='hermes.pr.files'] > .sf-col:last-child {
    flex: 1 1 520px;
  }

  [data-role='hermes.pr.filelist'] {
    flex: 1 0 260px;
    max-width: 320px;
    position: sticky;
    top: 0;
    max-height: 100%;
    overflow-y: auto;
  }

  [data-role='hermes.pr.fileitem'] {
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12.5px;
  }

  [data-role='hermes.pr.fileitem']:hover {
    background: var(--l1);
  }

  [data-role='hermes.pr.check'] {
    padding: 2px 4px;
    font-size: 13px;
  }

  /* The sheet: the view fills the overlay; only the body scrolls. */
  [data-role='hermes.pr.frame'] {
    height: 100%;
    min-height: 0;
    gap: 12px !important;
  }

  [data-role='hermes.pr.frame'] > [data-role='hermes.pr.body'] {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  /* The PR aside is Tern's settings sheet: its search, page title and empty state say nothing here. */
  [data-role='hermes.pr.aside'] :is(.pf-search, .pf-head, .pf-eyebrow, .pf-none, .pf-groups) {
    display: none !important;
  }

  [data-role='hermes.pr.aside'] .pf-extra {
    margin-top: 0 !important;
  }

  [data-role='hermes.pr.asideview'] [data-role='hermes.pr.checkout'] {
    display: none;
  }

  /* The PR pill's menu: a tray above the composer, as wide as it. */
  .sf-overlay[data-role='hermes.pr.menu'] .sf-ov-card {
    width: 720px;
    max-width: 100%;
    font-family: var(--sans);
  }

  [data-role='hermes.pr.menu.row'] {
    padding: 7px 10px;
    border-radius: 8px;
    cursor: pointer;
  }

  [data-role='hermes.pr.menu.row']:hover,
  [data-role='hermes.pr.menu.row'][data-mark='pick'] {
    background: var(--l1);
  }

  [data-role='hermes.pr.menu.foot'] {
    padding: 8px 10px 2px;
    box-shadow: inset 0 1px 0 var(--l2);
    font-size: 12px;
  }

  /* The composer's completion list, readable like t3code's: it sits above the composer (anchored in
     overlays/completion.tsx) and is as wide, names in the UI face (paths stay mono), and descriptions
     one step brighter. The list places rows at fixed
     steps, so a long description shows whole in a footer under the list, not in its row. */
  .sf-overlay[data-role='omp.autocomplete'] .sf-ov-card {
    width: min(736px, calc(100% - 8px)) !important;
    max-width: min(736px, calc(100% - 8px)) !important;
  }

  .sf-overlay[data-role='omp.autocomplete'] .sf-item-label {
    max-width: 40% !important;
    font: 550 13.5px/1.35 var(--sans) !important;
  }

  .sf-overlay[data-role='omp.autocomplete'] [data-role='hermes.complete.path'] .sf-item-label {
    font: 13px/1.35 var(--mono) !important;
  }

  .sf-overlay[data-role='omp.autocomplete'] .sf-item-detail {
    font: 13px/1.35 var(--sans) !important;
    color: var(--t2) !important;
  }

  .sf-overlay[data-role='omp.autocomplete'] .sf-item-label .sf-t-mark {
    background: none !important;
    box-shadow: none !important;
    color: var(--accent) !important;
  }

  [data-role='hermes.complete.more'] {
    margin: 4px 0 0;
    padding: 8px 11px 4px;
    box-shadow: inset 0 1px 0 var(--l2);
    font: 13px/1.45 var(--sans);
    color: var(--t2);
  }

  /* The session picker gives its preview the room: the list about 40%, the preview about 60%,
     where whole prompts, replies and the conversation are read. */
  :is(.sf-picker[data-role='hermes.sessions'], .sf-picker[data-id='layer.sessions']) .pk-pv {
    width: 60% !important;
  }

  /* Prompts and replies in the preview read as prose (the UI face); their code stays mono. */
  .pk-pv-slot .sf-md:is([data-role='hermes.sessions.prompt'], [data-role='hermes.sessions.reply'], [data-role='hermes.sessions.user']) {
    font: 13px/1.55 var(--sans) !important;
  }

  .pk-pv-slot .sf-md:is([data-role='hermes.sessions.prompt'], [data-role='hermes.sessions.reply'], [data-role='hermes.sessions.user']) :is(code, pre) {
    font-family: var(--mono) !important;
    font-size: 12px !important;
  }

  /* The whole session id, on its own lines, wrapped anywhere, never cut. */
  [data-role='hermes.sessions.id'] {
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--l1);
    font-size: 12.5px;
    overflow-wrap: anywhere;
    word-break: break-all;
  }

  [data-role='hermes.sessions.tool'] {
    font: 12.5px/1.45 var(--mono);
  }
`
