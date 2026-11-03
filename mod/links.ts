/**
 * Does this terminal draw OSC 8 hyperlinks? The same answer Claude Code gives itself, because the kit's
 * `Link` asks Claude Code: where the answer is no, `Link` prints its text and then its URL, a URL the
 * pane did not count, and every row overflowed (Terminal.app, 2026-11-03). Where the answer is no, the
 * mod draws no `Link` and puts the URL in its own rows (text.ts `docLines`, `links: false`).
 *
 * Nothing can ask a terminal (the OSC 8 spec: "currently there's no way of detecting"), so Claude
 * Code reads the environment. This mirrors Claude Code 2.1.317's decision, read from its build: the
 * `hyperlinks` setting, then FORCE_HYPERLINK, then the `supports-hyperlinks` package it bundles, then
 * its own list. Kept in step by hand: if Claude Code widens its list, an unknown terminal here only
 * shows URLs instead of links, never an overflowing row. Free of the mods API: test/links.test.ts.
 */

/** The variables the decision reads; register.tsx reads each by its literal name ($.env.get). */
export interface LinkEnv {
  FORCE_HYPERLINK?: string
  NETLIFY?: string
  WT_SESSION?: string
  CI?: string
  TEAMCITY_VERSION?: string
  TERM_PROGRAM?: string
  TERM_PROGRAM_VERSION?: string
  VTE_VERSION?: string
  TERM?: string
  TERMINAL_EMULATOR?: string
  TMUX?: string
  LC_TERMINAL?: string
}

const OFF = ['0', 'false', 'no', 'off']

/** `supports-hyperlinks`' version parse: "7602" (VTE) is 0.76.2; else dotted. */
function version(v: string): { major: number; minor: number } {
  if (/^\d{3,4}$/.test(v)) {
    const m = /(\d{1,2})(\d{2})/.exec(v) ?? []
    return { major: 0, minor: parseInt(m[1] ?? '', 10) }
  }
  const [a, b] = (v || '').split('.').map(n => parseInt(n, 10))
  return { major: a ?? NaN, minor: b ?? NaN }
}

/** The bundled `supports-hyperlinks` (a TTY with colour assumed: the pane is drawn to one). */
function supportsHyperlinks(e: LinkEnv): boolean {
  if (e.NETLIFY) return true
  if (e.WT_SESSION !== undefined) return true
  if (e.CI) return false
  if (e.TEAMCITY_VERSION) return false
  if (e.TERM_PROGRAM) {
    const v = version(e.TERM_PROGRAM_VERSION ?? '')
    switch (e.TERM_PROGRAM) {
      case 'iTerm.app':
        return v.major === 3 ? v.minor >= 1 : v.major > 3
      case 'WezTerm':
        return v.major >= 20200620
      case 'vscode':
        return v.major > 1 || (v.major === 1 && v.minor >= 72)
      case 'ghostty':
        return true
    }
  }
  if (e.VTE_VERSION) {
    if (e.VTE_VERSION === '0.50.0') return false
    const v = version(e.VTE_VERSION)
    return v.major > 0 || v.minor >= 50
  }
  return e.TERM === 'alacritty'
}

const KNOWN = ['ghostty', 'Hyper', 'kitty', 'alacritty', 'iTerm.app', 'iTerm2', 'WarpTerminal']

/** Claude Code's answer: its `hyperlinks` setting first (undefined: not set), then the environment. */
export function hyperlinks(e: LinkEnv, setting?: unknown): boolean {
  if (typeof setting === 'boolean') return setting
  if (e.FORCE_HYPERLINK) return !(OFF.includes(e.FORCE_HYPERLINK.toLowerCase().trim()) || parseInt(e.FORCE_HYPERLINK, 10) === 0)
  if (supportsHyperlinks(e)) return true
  const p = e.TERM_PROGRAM
  if (p && KNOWN.includes(p)) return true
  if (e.TERMINAL_EMULATOR === 'JetBrains-JediTerm') return true
  if (e.WT_SESSION && p !== 'tmux' && !e.TMUX) return true
  if (p === 'tmux') {
    const [a, b] = (e.TERM_PROGRAM_VERSION ?? '').split('.').map(n => parseInt(n, 10))
    if (a! > 3 || (a === 3 && b! >= 4)) return true
  }
  if (e.LC_TERMINAL && KNOWN.includes(e.LC_TERMINAL)) return true
  return !!e.TERM?.includes('kitty')
}
