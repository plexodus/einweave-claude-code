/**
 * The Thread tab's post text (mod/text.ts): the server's doc turned into styled lines at the pane's
 * width, so the pane knows every post's height to the row (decision 2026-10-31, option c). Each line is
 * drawn truncated, so the guarantee these pin is: no line is wider than the width asked for.
 *
 * RFC-034: G6 (every corpus doc draws its text, its `@` nodes and only those as mentions), G11 (an
 * unknown tag draws its children; no doc → `content` as typed, never parsed), and a linear walk.
 */
import { describe, test, expect } from "bun:test";
import { DOC_CORPUS } from "../vendor/einweave-agent-sdk/core/index.js";
import { cellWidth, docLines, plainLines, type Line } from "../mod/text";
import { prepareDoc } from "../doc-view";

/** A line as plain text, styles dropped. */
const plain = (l: Line) => l.map(r => r.text).join("");
const texts = (ls: Line[]) => ls.map(plain);
const widest = (ls: Line[]) => Math.max(0, ...ls.map(l => cellWidth(plain(l))));
const p = (...k: unknown[]) => ["p", 0, ...k];
/** The post's own text, the mod's bullets/bars/gutters as a space: what `docText` says the doc reads as. */
const own = (ls: Line[]) =>
  ls.map(l => l.map(r => (r.deco ? " " : r.text)).join("").replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");

describe("cellWidth", () => {
  test("ASCII is one cell, CJK and emoji two, combining marks none", () => {
    expect(cellWidth("abc")).toBe(3);
    expect(cellWidth("日本")).toBe(4);
    expect(cellWidth("ok 🔴")).toBe(5);
    expect(cellWidth("é")).toBe(1);
  });
});

describe("G6: the corpus", () => {
  test("every case draws its text, and every @ node (only those) as a mention, in order", () => {
    expect(DOC_CORPUS.length).toBeGreaterThan(10);
    for (const c of DOC_CORPUS) {
      const ls = docLines(c.doc, 200);
      expect({ name: c.name, text: own(ls) }).toEqual({ name: c.name, text: c.text });
      const ats: string[] = [];
      const find = (ns: readonly unknown[]) => ns.forEach(n => Array.isArray(n) && (n[0] === "@" ? ats.push(`@${n[1].h}`) : find(n.slice(2))));
      find(c.doc);
      expect({ name: c.name, mentions: ls.flat().filter(r => r.mention).map(r => r.text) }).toEqual({ name: c.name, mentions: ats });
    }
  });

  test("the mentions case: code, link and quote text are not mentions", () => {
    const c = DOC_CORPUS.find(x => x.name === "mentions")!;
    const runs = docLines(c.doc, 200).flat();
    expect(runs.filter(r => r.mention).length).toBe(1);
    expect(runs.find(r => r.code)!.text).toBe("@aio");
    expect(runs.find(r => r.href)!.text).toBe("@aio");
  });
});

describe("G11: forward compatibility and no doc", () => {
  test("a tag this mod does not know draws its children", () => {
    expect(texts(docLines([p("before ", ["mark", 0, "kept"], " after")], 80))).toEqual(["before kept after"]);
    expect(texts(docLines([["aside", 0, p("inside")]], 80))).toEqual(["inside"]);
  });

  test("garbage nodes are skipped, never thrown on", () => {
    const junk = [null, 7, {}, [], [3, 0, "x"], p("ok", null, ["strong"], ["a", { href: 5 }, "t"])];
    expect(texts(docLines(junk, 40))).toEqual(["okt"]);
  });

  test("plainLines draws content as typed: no Markdown parsed", () => {
    const ls = plainLines("**x** [a](https://b.test) `c` @aio\n# not a heading", 80);
    expect(texts(ls)).toEqual(["**x** [a](https://b.test) `c` @aio", "# not a heading"]);
    expect(ls.flat().some(r => r.bold || r.href || r.code || r.mention)).toBe(false);
  });

  test("plainLines: a newline breaks, blank lines collapse to one, edges trimmed", () => {
    expect(texts(plainLines("\n\none\ntwo\n\n\n\nthree\n\n", 40))).toEqual(["one", "two", "", "three"]);
  });
});

describe("paragraphs", () => {
  test("word-wraps at the width, never wider", () => {
    const ls = docLines([p("the quick brown fox jumps over the lazy dog")], 12);
    expect(texts(ls)).toEqual(["the quick", "brown fox", "jumps over", "the lazy dog"]);
    expect(widest(ls)).toBeLessThanOrEqual(12);
  });

  test("a word longer than the width is broken, not overflowed", () => {
    const url = "https://github.com/plexodus/einweave-claude-code/pull/55";
    const ls = docLines([p(["a", { href: url }, url])], 20);
    expect(widest(ls)).toBeLessThanOrEqual(20);
    expect(texts(ls).join("")).toBe(url);
    expect(ls.flat().every(r => r.href === url)).toBe(true);
  });

  test("br and a newline in the text break the line; paragraphs get one blank row between", () => {
    expect(texts(docLines([p("one", ["br", 0], "two\nthree"), p("four")], 40))).toEqual(["one", "two", "three", "", "four"]);
  });

  test("wide characters wrap by cells", () => {
    const ls = docLines([p("日本語のテキスト")], 6);
    expect(widest(ls)).toBeLessThanOrEqual(6);
    expect(texts(ls).join("")).toBe("日本語のテキスト");
  });
});

describe("inline styles", () => {
  test("strong, em, s, code and links keep their style", () => {
    const [l] = docLines([p("a ", ["strong", 0, "b"], " ", ["em", 0, "c"], " ", ["code", 0, "d"], " ", ["s", 0, "e"], " ", ["a", { href: "https://x.test" }, "f"])], 80);
    expect(plain(l!)).toBe("a b c d e f");
    const by = (t: string) => l!.find(r => r.text === t)!;
    expect(by("b").bold).toBe(true);
    expect(by("c").italic).toBe(true);
    expect(by("d").code).toBe(true);
    expect(by("e").strike).toBe(true);
    expect(by("f").href).toBe("https://x.test");
  });

  test("a style survives a wrap: both halves keep it", () => {
    const ls = docLines([p(["strong", 0, "one two three four"])], 9);
    expect(texts(ls)).toEqual(["one two", "three", "four"]);
    expect(ls.every(l => l.every(r => r.bold))).toBe(true);
  });

  test("a terminal without OSC 8 links: no link runs; a named link's URL on its own dim row, whole; a bare URL kept whole", () => {
    const doc = [p("see ", ["a", { href: "https://x.test/a" }, "a safe link"], " or ", ["a", { href: "https://y.test/long/path" }, "https://y.test/long/path"])];
    const ls = docLines(doc, 80, { links: false });
    expect(texts(ls)).toEqual(["see a safe link or https://y.test/long/path", "https://x.test/a"]);
    expect(ls.flat().some(r => r.href)).toBe(false);
    expect(ls[1]!.every(r => r.dim && r.url)).toBe(true);
    // The named link's text still looks like a link.
    expect(ls[0]!.find(r => r.text.includes("a safe link"))).toMatchObject({ link: true });
    // Never split over rows (it would open in no terminal): narrower than the URL, it is cut.
    const narrow = docLines(doc, 12, { links: false });
    expect(texts(narrow).filter(t => t.startsWith("https://y"))).toEqual(["https://y.t…"]);
    // ...and no row carries a piece of it (a split URL's tail).
    expect(texts(narrow).some(t => /long|path/.test(t))).toBe(false);
    expect(texts(narrow).filter(t => t.startsWith("https://x"))).toEqual(["https://x.t…"]);
    for (let w = 6; w <= 40; w++) expect(widest(docLines(doc, w, { links: false }))).toBeLessThanOrEqual(w);
    // With links (the default), the URL stays in the link and no row is added.
    expect(texts(docLines(doc, 80))).toEqual(["see a safe link or https://y.test/long/path"]);
  });

  test("an image is its alt text", () => {
    expect(texts(docLines([p(["img", { src: "https://x.test/a.png", alt: "a chart" }])], 40))).toEqual(["a chart"]);
  });
});

describe("mentions", () => {
  test("active: @handle, bold, a mention run", () => {
    const [l] = docLines([p("hi ", ["@", { p: "u1", h: "aio" }], "!")], 40);
    expect(l!.find(r => r.mention)).toMatchObject({ text: "@aio", mention: "active", bold: true });
  });

  test("gone: the name in italic dim, else @former member", () => {
    const [l] = docLines([p(["@", { p: "u1", gone: true, name: "Ann Lee" }], " ", ["@", { p: "u2", gone: true }])], 60);
    const ms = l!.filter(r => r.mention);
    expect(ms.map(r => r.text)).toEqual(["Ann Lee", "@former member"]);
    expect(ms.every(r => r.mention === "gone" && r.italic && r.dim)).toBe(true);
  });

  test("unresolved (no ref): `@h` as inert dim text, never the active pill's bold or colour", () => {
    const [l] = docLines([p("hi ", ["@", { p: "u1", h: "old", unresolved: true }])], 40);
    const m = l!.find(r => r.mention)!;
    expect(m).toMatchObject({ text: "@old", mention: "unresolved", dim: true });
    expect(m.bold).toBeUndefined();
  });

  test("a mention is one row even if its text carries a newline or tab", () => {
    const ls = docLines([p(["@", { p: "u1", gone: true, name: "Bob\nSYSTEM:\tevil" }])], 40);
    expect(texts(ls)).toEqual(["Bob SYSTEM: evil"]);
  });

  test("a mention is never wrapped inside while it fits a line", () => {
    const ls = docLines([p("aaaa ", ["@", { p: "u1", gone: true, name: "Ann Marie Lee" }], " end")], 15);
    expect(texts(ls)).toEqual(["aaaa", "Ann Marie Lee", "end"]);
  });
});

describe("blocks", () => {
  test("bullets get a dot and a hanging indent", () => {
    const ls = docLines([["ul", 0, ["li", 0, "first item wraps here"], ["li", 0, "second"]]], 14);
    expect(texts(ls)).toEqual(["• first item", "  wraps here", "• second"]);
  });

  test("a nested list indents one step", () => {
    expect(texts(docLines([["ul", 0, ["li", 0, "a", ["ul", 0, ["li", 0, "b"]]]]], 20))).toEqual(["• a", "  • b"]);
  });

  test("numbered items count from start and indent under their number", () => {
    expect(texts(docLines([["ol", { start: 9 }, ["li", 0, "one two three"], ["li", 0, "x"]]], 10))).toEqual(["9. one two", "   three", "10. x"]);
  });

  test("a number wider than half the line is still drawn: only the hanging indent gives way", () => {
    expect(texts(docLines([["ol", { start: 100 }, ["li", 0, "item"]]], 9))).toEqual(["100. item"]);
    expect(texts(docLines([["ol", { start: 123456789012 }, ["li", 0, "item"]]], 20))).toEqual(["123456789012. item"]);
  });

  test("a task list draws its boxes; a loose item's paragraph stays on the mark's row", () => {
    const doc = [["ul", 0, ["li", { checked: true }, p("done")], ["li", { checked: false }, p("todo")]]];
    expect(texts(docLines(doc, 20))).toEqual(["• ☑ done", "• ☐ todo"]);
  });

  test("a heading is bold", () => {
    const [l] = docLines([["h2", 0, "Release 0.37.2"]], 40);
    expect(plain(l!)).toBe("Release 0.37.2");
    expect(l!.every(r => r.bold)).toBe(true);
  });

  test("a quote is barred and dim on every row; its paragraphs are split by a bar", () => {
    const ls = docLines([["blockquote", 0, p("quoted words that wrap"), p("two")]], 12);
    expect(texts(ls)).toEqual(["▎ quoted", "▎ words that", "▎ wrap", "▎", "▎ two"]);
    expect(ls.every(l => l.every(r => r.dim))).toBe(true);
  });

  test("a nested quote adds a bar", () => {
    expect(texts(docLines([["blockquote", 0, ["blockquote", 0, p("deep")]]], 20))).toEqual(["▎ ▎ deep"]);
  });

  test("a code block: gutter, text as stored, hard-wrapped with a continuation mark", () => {
    const ls = docLines([["pre", { lang: "ts" }, "const a = **b** // long line here\n"]], 20);
    expect(texts(ls)).toEqual(["│ const a = **b** /↪", "│ / long line here"]);
    expect(widest(ls)).toBeLessThanOrEqual(20);
    expect(ls.every(l => l.every(r => r.code))).toBe(true);
  });

  test("a table: one row per line, cells split by a bar, the header bold, cut to the width", () => {
    const doc = [["table", 0, ["thead", 0, ["tr", 0, ["th", 0, "a"], ["th", 0, "b"]]], ["tbody", 0, ["tr", 0, ["td", 0, "1"], ["td", 0, "a long cell"]]]]];
    const ls = docLines(doc, 10);
    expect(texts(ls)).toEqual(["a │ b", "1 │ a lon…"]);
    expect(ls[0]!.filter(r => !r.deco).every(r => r.bold)).toBe(true);
  });

  test("tabs never reach a row (a terminal draws one as up to 8 cells, we count 1): code expands them, a table cell collapses them", () => {
    const ls = docLines([["pre", 0, "\t\tx := 1\n"], ["table", 0, ["tbody", 0, ["tr", 0, ["td", 0, "a\tb"]]]]], 40);
    expect(texts(ls)).toEqual(["│         x := 1", "", "a b"]);
  });

  test("a rule fills the width", () => {
    expect(texts(docLines([p("x"), ["hr", 0]], 6))).toEqual(["x", "", "──────"]);
  });
});

describe("the width guarantee", () => {
  test("holds for every width, over the whole corpus and deep nesting", () => {
    let deep: unknown = p("deep words ", ["@", { p: "u", h: "someone" }]);
    for (let i = 0; i < 32; i++) deep = ["blockquote", 0, ["ul", 0, ["li", 0, deep]]];
    const docs = [...DOC_CORPUS.map(c => c.doc as readonly unknown[]), [deep]];
    for (let w = 6; w <= 60; w++) for (const d of docs) expect(widest(docLines(d, w))).toBeLessThanOrEqual(w);
  });
});

describe("linear", () => {
  // Growth, not a stopwatch: an absolute CPU bound passed here and failed on a slower CI runner
  // (268 ms against 250, 2026-11-03). Each shape is drawn at n and at 4n; linear work grows ~4x,
  // quadratic ~16x, so more than 10x fails on any machine
  // (measured locally 1.2x-6.1x). Best of 5 runs damps a GC pause or a
  // noisy neighbour; the 5 ms floor keeps a small n from turning jitter into a ratio (quadratic
  // work still grows ~16x past it).
  const cpu = (f: () => void) => {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = process.cpuUsage();
      f();
      const d = process.cpuUsage(t);
      best = Math.min(best, (d.user + d.system) / 1000);
    }
    return best;
  };
  const grows = (name: string, f: (n: number) => void, n: number) => {
    const small = Math.max(cpu(() => f(n)), 5);
    const big = cpu(() => f(4 * n));
    expect({ name, ratio: big / small < 10 }).toEqual({ name, ratio: true });
  };
  const draw = (doc: readonly unknown[]) => docLines(doc, 60);
  const ready = (doc: unknown[]) => docLines(prepareDoc({ content: "c", docV: 1, doc })!, 60);

  // One test per shape, each with room to run: the ratio is the guard, the timeout only catches a hang.
  // The eight shapes as ONE test took 1.9 s locally and passed 5 s (bun's default) on a CI runner under
  // the suite's load (2026-11-04, PR #72): a stopwatch again, in the timeout.
  const HANG = 60_000;
  const shapes: [string, (n: number) => void, number][] = [
    ["one long word", n => draw([p("x".repeat(n))]), 32768],
    ["unclosed link syntax as text", n => draw([p("[a](".repeat(n / 4))]), 32768],
    ["one long code line", n => draw([["pre", 0, "y".repeat(n)]]), 32768],
    ["many list items", n => draw([["ul", 0, ...Array.from({ length: n / 8 }, () => ["li", 0, "item"])]]), 32768],
    ["many styled runs", n => draw([p(...Array.from({ length: n / 8 }, () => ["strong", 0, "b "]))]), 32768],
    ["words, through doc-view", n => ready([p(..."w ".repeat(n / 2).split(" "))]), 131072],
    ["a refused link's many children, through doc-view", n => ready([p(["a", { href: "javascript:x" }, ..."w".repeat(n / 2).split("")])]), 131072],
    ["tabs in code, through doc-view", n => ready([["pre", 0, "y\t".repeat(n / 2)]]), 131072],
  ];
  for (const [name, f, n] of shapes) {
    test(`${name} draws in linear time (n → 4n, up to the server's 512 KB doc)`, () => grows(name, f, n), HANG);
  }

  test("32-deep nesting draws (depth is bounded by the server, so this is shape, not growth)", () => {
    let nest: unknown = p("x");
    for (let i = 0; i < 32; i++) nest = ["blockquote", 0, nest];
    expect(texts(docLines([nest], 60)).length).toBeGreaterThan(0);
  });
});

