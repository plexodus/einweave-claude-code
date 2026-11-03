/**
 * A post as styled lines at a given width, for the Thread tab (decision 2026-10-31, option c).
 *
 * The pane scrolls its own rows under a pinned header, so it must know every post's height to the row;
 * the kit's Markdown draws but never reports one. Here we wrap ourselves, and each line is drawn
 * truncated, so a line is exactly one row even where a terminal measures a glyph wider than we do.
 *
 * The lines come from the SERVER's doc (RFC-034 D6): the mod parses no Markdown. `ui_thread` has
 * already decided whether there is a doc to draw (`docToRender`, G11), applied the link/image rule (G8),
 * stripped control characters and resolved mentions (doc-view.ts); without a doc the post's `content`
 * is drawn as plain text, never parsed. One linear walk; a node this mod does not know draws its children.
 * Free of the mods API: test/mod-text.test.ts covers it under `bun test`.
 */

/** One styled stretch of a line. */
export interface Run {
  text: string
  bold?: true
  italic?: true
  code?: true
  dim?: true
  strike?: true
  href?: string
  /** A mention: drawn whole (never wrapped inside), `gone` for someone no longer in the workspace. */
  mention?: 'active' | 'gone'
  /** Drawn by the mod (bullet, bar, gutter, rule), not the post's own text. */
  deco?: true
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


const same = (a: Run, b: Run) =>
  a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.dim === b.dim && a.strike === b.strike &&
  a.href === b.href && a.mention === b.mention && a.deco === b.deco

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
    // A mention is one token, spaces and all: it breaks only where it is wider than a whole line.
    for (const tok of r.mention ? [r.text] : r.text.split(/(\s+)/)) {
      if (!tok) continue
      const style = { ...r, text: tok }
      if (!r.mention && /^\s+$/.test(tok)) {
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

/** A code line: gutter, hard-wrapped, `↪` where it continues; `lead` gives each row's prefix. */
function codeLines(text: string, width: number, lead: () => Run[]): Line[] {
  const out: Line[] = []
  const gutter: Run = { code: true, deco: true, text: '│ ' }
  let i = 0
  // A terminal draws a tab as up to 8 cells and we would count 1: expanded, the row's width is known.
  const chars = [...text.replace(/\t/g, '    ')]
  do {
    const pre = lead()
    const room = Math.max(2, width - cellWidth(pre.map(r => r.text).join('')) - 2)
    let piece = ''
    let w = 0
    let j = i
    for (; j < chars.length; j++) {
      const cw = charWidth(chars[j]!)
      if (w + cw > room - (j < chars.length - 1 ? 1 : 0)) break
      piece += chars[j]
      w += cw
    }
    // A glyph wider than the room on its own still moves on.
    if (j === i && j < chars.length) piece = chars[j++]!
    const more = j < chars.length
    out.push(merge([...pre, gutter, { code: true, text: piece }, ...(more ? [{ code: true as const, deco: true as const, text: '↪' }] : [])]))
    i = j
  } while (i < chars.length)
  return out
}

/**
 * A doc node as `ui_thread` hands it over (the server's `[tag, attrs | 0, ...children]`, cleaned by
 * doc-view.ts). Typed loosely on purpose: it is data, and anything else in it is skipped, never thrown on.
 */
export type DocNode = string | readonly [string, Record<string, unknown> | 0, ...unknown[]]

const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'hr'])
const isEl = (n: unknown): n is readonly [string, unknown, ...unknown[]] => Array.isArray(n) && typeof n[0] === 'string'
const attrs = (n: readonly unknown[]): Record<string, unknown> => (n[1] && typeof n[1] === 'object' ? (n[1] as Record<string, unknown>) : {})
const kids = (n: readonly unknown[]) => n.slice(2)
const textOf = (r: Run[]) => r.map(x => x.text).join('')

/** Inline nodes as runs, split into segments where a line must break (`br`, a newline in the text). */
function inline(nodes: readonly unknown[], style: Style, segs: Run[][]): void {
  for (const n of nodes) {
    if (typeof n === 'string') {
      const parts = n.split('\n')
      parts.forEach((t, i) => {
        if (i) segs.push([])
        if (t) segs[segs.length - 1]!.push({ ...style, text: t })
      })
      continue
    }
    if (!isEl(n)) continue
    const a = attrs(n)
    switch (n[0]) {
      case 'br':
        segs.push([])
        break
      case 'strong':
        inline(kids(n), { ...style, bold: true }, segs)
        break
      case 'em':
        inline(kids(n), { ...style, italic: true }, segs)
        break
      case 's':
      case 'del':
        inline(kids(n), { ...style, strike: true }, segs)
        break
      case 'code':
        inline(kids(n), { ...style, code: true }, segs)
        break
      case 'a':
        inline(kids(n), typeof a.href === 'string' && a.href ? { ...style, href: a.href } : style, segs)
        break
      case 'img':
        if (typeof a.alt === 'string' && a.alt) segs[segs.length - 1]!.push({ ...style, dim: true, text: a.alt })
        break
      case '@': {
        const gone = a.gone === true
        const name = typeof a.name === 'string' && a.name ? a.name : null
        // One row whatever it carries: a newline in it would draw a second row the pane does not count.
        const text = (gone ? (name ?? '@former member') : `@${typeof a.h === 'string' && a.h ? a.h : (name ?? '')}`).replace(/\s+/g, ' ')
        segs[segs.length - 1]!.push(gone ? { ...style, italic: true, dim: true, mention: 'gone', text } : { ...style, bold: true, mention: 'active', text })
        break
      }
      default:
        // A block where only inline belongs, or a tag this mod does not know: its children (G11).
        inline(kids(n), style, segs)
    }
  }
}

/** The prefixes a container gives its rows: `first` once, then `hang`. */
interface Lead {
  first: Run[]
  hang: Run[]
  used: boolean
}
const take = (l: Lead) => {
  const r = l.used ? l.hang : l.first
  l.used = true
  return r
}

/**
 * A doc as lines at most `width` cells wide (RFC-034 D6; below 6 cells it is drawn at 6, the narrowest a
 * bar, a mark and a word share; the pane never asks below 10). Blocks are separated by a blank row (inside
 * a quote, a bar); list items are not. Nesting indents until half the width is prefix, then stops growing.
 */
export function docLines(doc: readonly unknown[], width: number): Line[] {
  const w = Math.max(6, Math.floor(width))
  const out: Line[] = []
  const wide = (r: Run[]) => cellWidth(textOf(r)) > w / 2
  const child = (l: Lead, first: Run[], hang: Run[]): Lead => {
    const lead = take(l)
    if (!wide([...l.hang, ...hang])) return { first: [...lead, ...first], hang: [...l.hang, ...hang], used: false }
    // Too deep or too wide to indent further: the mark still shows while it fits, the hang stops growing.
    return { first: cellWidth(textOf([...lead, ...first])) < w ? [...lead, ...first] : lead, hang: l.hang, used: false }
  }
  const para = (segs: Run[][], l: Lead) => {
    for (const seg of segs) {
      const first = take(l)
      out.push(...wrap(seg, w, first, l.hang))
    }
  }

  const blocks = (nodes: readonly unknown[], l: Lead, style: Style, gap: boolean): void => {
    let buf: unknown[] = []
    let any = false
    const sep = () => {
      if (gap && any) out.push(merge(l.hang.map(r => ({ ...r }))).map(r => ({ ...r, text: r.text.trimEnd() })).filter(r => r.text))
      any = true
    }
    const flush = () => {
      if (!buf.length) return
      const segs: Run[][] = [[]]
      inline(buf, style, segs)
      buf = []
      if (!segs.some(s => s.length)) return
      sep()
      para(segs, l)
    }
    for (const n of nodes) {
      if (!isEl(n) || !BLOCKS.has(n[0])) {
        buf.push(n)
        continue
      }
      flush()
      const a = attrs(n)
      const tag = n[0]
      if (tag === 'p') {
        const segs: Run[][] = [[]]
        inline(kids(n), style, segs)
        sep()
        para(segs, l)
      } else if (/^h[1-6]$/.test(tag)) {
        const segs: Run[][] = [[]]
        inline(kids(n), { ...style, bold: true }, segs)
        sep()
        para(segs, l)
      } else if (tag === 'blockquote') {
        sep()
        const bar: Run[] = [{ dim: true, deco: true, text: '▎ ' }]
        blocks(kids(n), child(l, bar, bar), { ...style, dim: true }, true)
      } else if (tag === 'ul' || tag === 'ol') {
        sep()
        const start = typeof a.start === 'number' && Number.isSafeInteger(a.start) ? a.start : 1
        let i = 0
        for (const item of kids(n)) {
          if (!isEl(item)) continue
          const ia = attrs(item)
          const box = ia.checked === true ? '☑ ' : ia.checked === false ? '☐ ' : ''
          const mark = (tag === 'ol' ? `${start + i}. ` : '• ') + box
          i++
          const lead = child(l, [{ deco: true, text: mark }], [{ deco: true, text: ' '.repeat(cellWidth(mark)) }])
          const before = out.length
          blocks(item[0] === 'li' ? kids(item) : [item], lead, style, false)
          if (out.length === before) out.push(merge(lead.first.map(r => ({ ...r }))))
        }
      } else if (tag === 'li') {
        // An item outside a list: its children in place.
        blocks(kids(n), l, style, gap)
      } else if (tag === 'pre') {
        sep()
        const segs: Run[][] = [[]]
        inline(kids(n), {}, segs)
        const rows = segs.map(textOf)
        if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop()
        for (const row of rows) out.push(...codeLines(row, w, () => take(l)))
      } else if (tag === 'table') {
        sep()
        const rows: { cells: string[]; head: boolean }[] = []
        const walk = (ns: readonly unknown[], head: boolean) => {
          for (const r of ns) {
            if (!isEl(r)) continue
            if (r[0] === 'tr') {
              const cells = kids(r).filter(isEl).map(c => {
                const segs: Run[][] = [[]]
                inline(kids(c), {}, segs)
                return segs.map(textOf).join(' ').replace(/\s+/g, ' ').trim()
              })
              rows.push({ cells, head: head || kids(r).some(c => isEl(c) && c[0] === 'th') })
            } else walk(kids(r), head || r[0] === 'thead')
          }
        }
        walk(kids(n), false)
        for (const r of rows) {
          const lead = take(l)
          const room = Math.max(1, w - cellWidth(textOf(lead)))
          const line: Run[] = []
          r.cells.forEach((c, i) => {
            if (i) line.push({ ...style, dim: true, deco: true, text: ' │ ' })
            line.push({ ...style, ...(r.head ? { bold: true as const } : {}), text: c })
          })
          out.push(merge([...lead.map(x => ({ ...x })), ...cutRuns(line, room)]))
        }
      } else if (tag === 'hr') {
        sep()
        const lead = take(l)
        out.push(merge([...lead.map(x => ({ ...x })), { dim: true, deco: true, text: '─'.repeat(Math.max(1, w - cellWidth(textOf(lead)))) }]))
      }
    }
    flush()
  }

  blocks(doc, { first: [], hang: [], used: false }, {}, true)
  while (out.length && !out[out.length - 1]!.length) out.pop()
  return out
}

/** Runs cut to `width` cells, an ellipsis marking the cut. */
function cutRuns(runs: Run[], width: number): Run[] {
  if (cellWidth(textOf(runs)) <= width) return runs
  const out: Run[] = []
  let used = 0
  for (const r of runs) {
    const left = width - 1 - used
    if (left <= 0) break
    const w = cellWidth(r.text)
    if (w <= left) {
      out.push(r)
      used += w
      continue
    }
    out.push({ ...r, text: cut(r.text, left + 1).slice(0, -1) })
    break
  }
  out.push({ deco: true, dim: true, text: '…' })
  return out
}

/** A post without a doc (G11): its `content` as typed, wrapped. Never parsed; blank lines collapse to one. */
export function plainLines(content: string, width: number): Line[] {
  const w = Math.max(4, Math.floor(width))
  const out: Line[] = []
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      if (out.length && out[out.length - 1]!.length) out.push([])
      continue
    }
    out.push(...wrap([{ text: line }], w, [], []))
  }
  while (out.length && !out[out.length - 1]!.length) out.pop()
  return out
}
