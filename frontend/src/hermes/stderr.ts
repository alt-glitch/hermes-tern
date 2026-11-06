// Which lines of the backend's stderr look like a problem, as the Ink TUI decides it
// (ui-tui/src/app/userMessages.ts): a slow start shows those, not the noise around them.

// Only real failures: a traceback, a CRITICAL log line, an `XxxError:` / `XxxException:` head, the
// gateway's own turn and exit markers, or an attach verdict line (`gateway inaccessible: …`).
const PROBLEM = /Traceback|\b[A-Z][A-Za-z]*(?:Error|Exception)\b:|CRITICAL|\[gateway-turn\]|\[gateway-exit\]|^gateway (?:absent|conflict|draining|inaccessible|incompatible|starting|unavailable): /

/** Whether `line` looks like a failure; the rest is noise. */
export const stderrLooksLikeProblem = (line: string): boolean => PROBLEM.test(line)
