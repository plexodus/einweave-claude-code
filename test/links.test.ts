/**
 * mod/links.ts: does the terminal draw OSC 8 links? Claude Code 2.1.317's own answer (read from its
 * build), because the kit's `Link` follows it: a mismatch either way overflows rows (we draw a Link the
 * kit prints as text + URL) or hides links that would have worked.
 */
import { describe, test, expect } from "bun:test";
import { hyperlinks, type LinkEnv } from "../mod/links";

const cases: [string, LinkEnv, boolean][] = [
  ["Terminal.app", { TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }, false],
  ["nothing known", {}, false],
  ["VS Code 1.72", { TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.72.0" }, true],
  ["VS Code 1.71", { TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.71.2" }, false],
  ["iTerm 3.1 (and its own list says yes at any version)", { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "2.9" }, true],
  ["WezTerm", { TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "20240203-110809-5046fc22" }, true],
  ["WezTerm too old", { TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "20200101" }, false],
  ["Ghostty", { TERM_PROGRAM: "ghostty" }, true],
  ["kitty by TERM", { TERM: "xterm-kitty" }, true],
  ["Alacritty", { TERM: "alacritty" }, true],
  ["Warp", { TERM_PROGRAM: "WarpTerminal" }, true],
  ["Windows Terminal", { WT_SESSION: "x" }, true],
  ["JetBrains", { TERMINAL_EMULATOR: "JetBrains-JediTerm" }, true],
  ["VTE 0.76", { VTE_VERSION: "7602" }, true],
  ["VTE 0.50.0 (broken release)", { VTE_VERSION: "0.50.0" }, false],
  ["VTE 0.48", { VTE_VERSION: "4802" }, false],
  ["tmux 3.4", { TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.4" }, true],
  ["tmux 3.3a", { TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.3a" }, false],
  ["iTerm under tmux via LC_TERMINAL", { TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.2", LC_TERMINAL: "iTerm2" }, true],
  ["CI", { CI: "true", TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.90.0" }, false],
  ["FORCE_HYPERLINK=1 on Terminal.app", { FORCE_HYPERLINK: "1", TERM_PROGRAM: "Apple_Terminal" }, true],
  ["FORCE_HYPERLINK=0 on Ghostty", { FORCE_HYPERLINK: "0", TERM_PROGRAM: "ghostty" }, false],
  ["FORCE_HYPERLINK=off", { FORCE_HYPERLINK: "off", TERM_PROGRAM: "ghostty" }, false],
];

describe("hyperlinks: Claude Code's decision", () => {
  for (const [name, env, want] of cases) test(name, () => expect(hyperlinks(env)).toBe(want));

  test("the `hyperlinks` setting wins over everything", () => {
    expect(hyperlinks({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(true);
    expect(hyperlinks({ TERM_PROGRAM: "ghostty", FORCE_HYPERLINK: "1" }, false)).toBe(false);
    expect(hyperlinks({ TERM_PROGRAM: "ghostty" }, "yes")).toBe(true);
  });
});
