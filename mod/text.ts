/**
 * A post's Markdown as styled lines at a given width, for the Thread tab (decision 2026-10-31, option c).
 *
 * The pane scrolls its own rows under a pinned header, so it must know every post's height to the row;
 * the kit's Markdown draws but never reports one. Here we wrap ourselves, and each line is drawn
 * truncated, so a line is exactly one row even where a terminal measures a glyph wider than we do.
 *
 * A subset, by design: paragraphs (a newline is a break, as in chat), bold, italic, inline code, links,
 * bullets, numbered items, quotes, headings and fenced code. Tables come out as their raw rows; any
 * other syntax stays as typed. Free of the mods API: test/mod-text.test.ts covers it under `bun test`.
 */

/** One styled stretch of a line. */
export interface Run {
  text: string
  bold?: true
  italic?: true
  code?: true
  dim?: true
  href?: string
}

/** One drawn row. */
export type Line = Run[]

type Style = Omit<Run, 'text'>

// Combining marks, joiners and variation selectors take no cell.
const ZERO = /[\p{Mn}\p{Me}​-‏⁠︀-️]/u
const PICTO = /\p{Extended_Pictographic}/u

/** Terminal cells a code point takes. Errs wide: a line we think too wide wraps early, never overflows. */
function charWidth(ch: string): number {
  if (ZERO.test(ch)) return 0
  const c = ch.codePointAt(0)!
  if (c < 0x1100) return 1
  if (
    (c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd) ||
    (c >= 0x1f000 && PICTO.test(ch))
  ) return 2
  return 1
}

/** Terminal cells a string takes. */
export function cellWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

const URL_AT = /^https?:\/\/[^\s<>()[\]]+/
const LINK_AT = /^\[([^\]]+)\]\(([^)\s]+)\)/
const ALNUM = /[\p{L}\p{N}]/u

/** Inline Markdown as runs, before wrapping. Unclosed markers stay as typed. */
function inline(src: string, style: Style = {}): Run[] {
  const out: Run[] = []
  let buf = ''
  const flush = () => {
    if (buf) out.push({ ...style, text: buf })
    buf = ''
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    const rest = src.slice(i)
    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|>~]/.test(src[i + 1]!)) {
      buf += src[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ ...style, code: true, text: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (ch === '[') {
      const m = LINK_AT.exec(rest)
      if (m) {
        flush()
        out.push(...inline(m[1]!, { ...style, href: m[2]! }))
        i += m[0].length
        continue
      }
    }
    if ((ch === 'h') && (i === 0 || /[\s(]/.test(src[i - 1]!))) {
      const m = URL_AT.exec(rest)
      if (m) {
        const url = m[0].replace(/[.,;:!?'"]+$/, '')
        flush()
        out.push({ ...style, href: url, text: url })
        i += url.length
        continue
      }
    }
    if (ch === '*' || ch === '_') {
      const double = src[i + 1] === ch
      const mark = double ? ch + ch : ch
      const open = i + mark.length
      // Opens before a non-space; `_` only at a word's start, so snake_case stays as typed.
      const opens = open < src.length && !/\s/.test(src[open]!) && (ch === '*' || i === 0 || !ALNUM.test(src[i - 1]!))
      if (opens) {
        let end = src.indexOf(mark, open + 1)
        while (end !== -1) {
          const closes = !/\s/.test(src[end - 1]!) && (ch === '*' || end + mark.length >= src.length || !ALNUM.test(src[end + mark.length]!))
          // A single `*` must not close on half of a `**`.
          if (closes && (double || src[end + 1] !== ch)) break
          end = src.indexOf(mark, end + 1)
        }
        if (end !== -1) {
          flush()
          out.push(...inline(src.slice(open, end), double ? { ...style, bold: true } : { ...style, italic: true }))
          i = end + mark.length
          continue
        }
      }
      buf += mark
      i += mark.length
      continue
    }
    buf += ch
    i += 1
  }
  flush()
  return out
}

const same = (a: Run, b: Run) => a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.dim === b.dim && a.href === b.href

/** Adjacent runs of one style joined. */
function merge(line: Line): Line {
  const out: Line = []
  for (const r of line) {
    const last = out[out.length - 1]
    if (last && same(last, r)) last.text += r.text
    else if (r.text) out.push({ ...r })
  }
  return out
}

/**
 * Runs word-wrapped to `width` cells: `first` leads the first line, `hang` every other. A word wider
 * than a whole line is broken where the line ends.
 */
function wrap(runs: Run[], width: number, first: Run[], hang: Run[]): Line[] {
  const lines: Line[] = []
  const lead = (l: Run[]) => l.map(r => ({ ...r }))
  let cur: Line = lead(first)
  let used = cellWidth(first.map(r => r.text).join(''))
  let empty = true
  let space: Run | null = null
  const hangW = cellWidth(hang.map(r => r.text).join(''))
  const next = () => {
    lines.push(cur)
    cur = lead(hang)
    used = hangW
    empty = true
    space = null
  }
  for (const r of runs) {
    for (const tok of r.text.split(/(\s+)/)) {
      if (!tok) continue
      const style = { ...r, text: tok }
      if (/^\s+$/.test(tok)) {
        if (!empty) space = { ...style, text: ' ' }
        continue
      }
      const w = cellWidth(tok)
      const gap = space ? 1 : 0
      if (used + gap + w <= width) {
        if (space) cur.push(space)
        cur.push(style)
        used += gap + w
        empty = false
        space = null
        continue
      }
      if (!empty) next()
      if (used + w <= width) {
        cur.push(style)
        used += w
        empty = false
        continue
      }
      // Too wide for any line: break it.
      let piece = ''
      for (const ch of tok) {
        const cw = charWidth(ch)
        if (used + cellWidth(piece) + cw > width && (piece || !empty)) {
          if (piece) cur.push({ ...r, text: piece })
          piece = ''
          next()
        }
        piece += ch
      }
      if (piece) {
        cur.push({ ...r, text: piece })
        used += cellWidth(piece)
        empty = false
      }
    }
  }
  lines.push(cur)
  return lines.map(merge)
}

/** A string cut to `width` cells, an ellipsis marking the cut. */
function cut(s: string, width: number): string {
  if (cellWidth(s) <= width) return s
  let out = ''
  for (const ch of s) {
    if (cellWidth(out + ch) > width - 1) break
    out += ch
  }
  return out + '…'
}

/** A fenced code line: gutter, hard-wrapped, `↪` where it continues. */
function codeLines(text: string, width: number): Line[] {
  const room = Math.max(2, width - 2)
  const out: Line[] = []
  let left = text
  do {
    if (cellWidth(left) <= room) {
      out.push([{ code: true, text: `│ ${left}` }])
      break
    }
    let piece = ''
    for (const ch of left) {
      if (cellWidth(piece + ch) > room - 1) break
      piece += ch
    }
    out.push([{ code: true, text: `│ ${piece}↪` }])
    left = left.slice(piece.length)
  } while (left)
  return out
}

const FENCE = /^\s*```/
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const HEADING = /^#{1,6}\s+(.*)$/
const QUOTE = /^>\s?(.*)$/

/** A post's Markdown as lines at most `width` cells wide; blank lines collapse to one, none at the edges. */
export function renderPost(src: string, width: number): Line[] {
  const w = Math.max(4, Math.floor(width))
  const out: Line[] = []
  const blank = () => {
    if (out.length && out[out.length - 1]!.length) out.push([])
  }
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (FENCE.test(line)) {
      for (i++; i < lines.length && !FENCE.test(lines[i]!); i++) out.push(...codeLines(lines[i]!, w))
      continue
    }
    if (!line.trim()) {
      blank()
      continue
    }
    if (line.trimStart().startsWith('|')) {
      out.push([{ text: cut(line.trim(), w) }])
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      out.push(...wrap(inline(heading[1]!, { bold: true }), w, [], []))
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote) {
      const bar = [{ dim: true as const, text: '▎ ' }]
      out.push(...wrap(inline(quote[1]!, { dim: true }), w, bar, bar))
      continue
    }
    const item = LIST.exec(line)
    if (item) {
      const indent = '  '.repeat(Math.floor(item[1]!.replace(/\t/g, '  ').length / 2))
      const mark = /\d/.test(item[2]!) ? `${item[2]} ` : '• '
      out.push(...wrap(inline(item[3]!), w, [{ text: indent + mark }], [{ text: ' '.repeat(cellWidth(indent + mark)) }]))
      continue
    }
    out.push(...wrap(inline(line), w, [], []))
  }
  while (out.length && !out[out.length - 1]!.length) out.pop()
  return out
}
