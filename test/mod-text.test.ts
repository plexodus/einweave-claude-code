/**
 * The Thread tab's post text (mod/text.ts): Markdown turned into styled lines at the pane's width, so
 * the pane knows every post's height to the row (decision 2026-10-31, option c). Each line is drawn
 * truncated, so the guarantee these pin is: no line is wider than the width asked for.
 */
import { describe, test, expect } from "bun:test";
import { cellWidth, renderPost, type Line } from "../mod/text";

/** A line as plain text, styles dropped. */
const plain = (l: Line) => l.map(r => r.text).join("");
const texts = (ls: Line[]) => ls.map(plain);
const widest = (ls: Line[]) => Math.max(0, ...ls.map(l => cellWidth(plain(l))));

describe("cellWidth", () => {
  test("ASCII is one cell, CJK and emoji two, combining marks none", () => {
    expect(cellWidth("abc")).toBe(3);
    expect(cellWidth("日本")).toBe(4);
    expect(cellWidth("ok 🔴")).toBe(5);
    expect(cellWidth("é")).toBe(1);
  });
});

describe("paragraphs", () => {
  test("word-wraps at the width, never wider", () => {
    const ls = renderPost("the quick brown fox jumps over the lazy dog", 12);
    expect(texts(ls)).toEqual(["the quick", "brown fox", "jumps over", "the lazy dog"]);
    expect(widest(ls)).toBeLessThanOrEqual(12);
  });

  test("a word longer than the width is broken, not overflowed", () => {
    const ls = renderPost("https://github.com/plexodus/einweave-claude-code/pull/55", 20);
    expect(widest(ls)).toBeLessThanOrEqual(20);
    expect(texts(ls).join("")).toBe("https://github.com/plexodus/einweave-claude-code/pull/55");
  });

  test("a single newline is a line break; blank lines collapse to one; edges trimmed", () => {
    expect(texts(renderPost("\n\none\ntwo\n\n\n\nthree\n\n", 40))).toEqual(["one", "two", "", "three"]);
  });

  test("wide characters wrap by cells", () => {
    const ls = renderPost("日本語のテキスト", 6);
    expect(widest(ls)).toBeLessThanOrEqual(6);
    expect(texts(ls).join("")).toBe("日本語のテキスト");
  });
});

describe("inline styles", () => {
  test("bold, italic and code lose their markers and keep their style", () => {
    const [l] = renderPost("a **b** *c* `d` __e__ _f_", 80);
    expect(plain(l!)).toBe("a b c d e f");
    const by = (t: string) => l!.find(r => r.text === t)!;
    expect(by("b").bold).toBe(true);
    expect(by("c").italic).toBe(true);
    expect(by("d").code).toBe(true);
    expect(by("e").bold).toBe(true);
    expect(by("f").italic).toBe(true);
  });

  test("markup inside code is literal", () => {
    const [l] = renderPost("run `**not bold**` now", 80);
    expect(plain(l!)).toBe("run **not bold** now");
    expect(l!.find(r => r.code)!.text).toBe("**not bold**");
  });

  test("an unclosed marker stays as typed; snake_case is not italic", () => {
    expect(plain(renderPost("2 ** 3 and a *b", 80)[0]!)).toBe("2 ** 3 and a *b");
    const [l] = renderPost("set snake_case_name", 80);
    expect(plain(l!)).toBe("set snake_case_name");
    expect(l!.some(r => r.italic)).toBe(false);
    // Closes cleanly before the space, so only the opening rule keeps it literal.
    const [m] = renderPost("open file_name_ here", 80);
    expect(plain(m!)).toBe("open file_name_ here");
    expect(m!.some(r => r.italic)).toBe(false);
  });

  test("a backslash escapes markup", () => {
    expect(plain(renderPost("\\*literal\\*", 80)[0]!)).toBe("*literal*");
  });

  test("[text](url) is a link on its text; a bare URL links itself", () => {
    const [l] = renderPost("see [PR 55](https://x.test/55) or https://y.test/a.", 80);
    expect(plain(l!)).toBe("see PR 55 or https://y.test/a.");
    expect(l!.find(r => r.text === "PR 55")!.href).toBe("https://x.test/55");
    expect(l!.find(r => r.text === "https://y.test/a")!.href).toBe("https://y.test/a");
  });

  test("a style survives a wrap: both halves keep it", () => {
    const ls = renderPost("**one two three four**", 9);
    expect(texts(ls)).toEqual(["one two", "three", "four"]);
    expect(ls.every(l => l.every(r => r.bold))).toBe(true);
  });
});

describe("blocks", () => {
  test("bullets get a dot and a hanging indent", () => {
    const ls = renderPost("- first item wraps here\n* second", 14);
    expect(texts(ls)).toEqual(["• first item", "  wraps here", "• second"]);
  });

  test("a nested bullet indents one step", () => {
    expect(texts(renderPost("- a\n  - b", 20))).toEqual(["• a", "  • b"]);
  });

  test("numbered items keep their number and indent under it", () => {
    expect(texts(renderPost("1. one two three\n10. x", 10))).toEqual(["1. one two", "   three", "10. x"]);
  });

  test("a heading is one bold line without the hashes", () => {
    const [l] = renderPost("## Release 0.37.2", 40);
    expect(plain(l!)).toBe("Release 0.37.2");
    expect(l!.every(r => r.bold)).toBe(true);
  });

  test("a quote is prefixed and dim, on every wrapped line", () => {
    const ls = renderPost("> quoted words that wrap", 12);
    expect(texts(ls)).toEqual(["▎ quoted", "▎ words that", "▎ wrap"]);
    expect(ls.every(l => l.every(r => r.dim))).toBe(true);
  });

  test("a code block: gutter, no inline parsing, hard-wrapped with a continuation mark", () => {
    const ls = renderPost("```ts\nconst a = **b** // long line here\n```", 20);
    expect(texts(ls)).toEqual(["│ const a = **b** /↪", "│ / long line here"]);
    expect(widest(ls)).toBeLessThanOrEqual(20);
    expect(ls.every(l => l.every(r => r.code))).toBe(true);
  });

  test("an unclosed fence runs to the end", () => {
    expect(texts(renderPost("```\nx\ny", 20))).toEqual(["│ x", "│ y"]);
  });

  test("a table falls back to its raw rows, cut to the width", () => {
    const ls = renderPost("| a | b |\n|---|---|\n| 1 | 2 |", 40);
    expect(texts(ls)).toEqual(["| a | b |", "|---|---|", "| 1 | 2 |"]);
  });
});

describe("the width guarantee", () => {
  test("holds for every width on a mixed post", () => {
    const post = [
      "Plugin **0.37.2** released. Run `/plugin` → Installed → einweave → Update now.",
      "- Fix (#55): sibling windows no longer share a session key",
      "- details: https://github.com/plexodus/einweave-claude-code/pull/55",
      "> quoted 日本語 text 🔴 with emoji",
      "```",
      "claude --dangerously-load-development-channels plugin:einweave@einweave-marketplace",
      "```",
      "1. numbered [link text](https://x.test) and _italic words_",
    ].join("\n");
    for (let w = 8; w <= 60; w++) expect(widest(renderPost(post, w))).toBeLessThanOrEqual(w);
  });
});
