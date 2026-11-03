/**
 * RFC-034 D6 — doc-view.ts readies a message's doc for the mod: G11 (only `docToRender` decides), G8
 * (links and images re-checked against the SDK's rule), control characters stripped from every string,
 * mentions resolved from the refs. The mod draws what this returns and decides none of it.
 */
import { describe, test, expect } from "bun:test";
import { DOC_FORWARD_CASES } from "../vendor/einweave-agent-sdk/core/index.js";
import { prepareDoc } from "../doc-view";

const p = (...k: unknown[]) => ["p", 0, ...k];
const one = (...k: unknown[]) => prepareDoc({ content: "c", docV: 1, doc: [p(...k)] })![0] as unknown[];
const hrefs = (n: unknown): string[] =>
  Array.isArray(n) ? [...(n[0] === "a" ? [(n[1] as { href: string }).href] : []), ...n.slice(2).flatMap(hrefs)] : [];

describe("G11: docToRender decides", () => {
  test("every forward case: a doc exactly when the protocol says render the doc", () => {
    for (const c of DOC_FORWARD_CASES) {
      const got = prepareDoc({ content: c.content, doc: c.doc, docV: c.docV });
      expect({ name: c.name, doc: got !== null }).toEqual({ name: c.name, doc: c.render === "doc" });
    }
  });

  test("a non-array doc, or a docV that is not a number, is no doc", () => {
    expect(prepareDoc({ content: "x", docV: 1, doc: { p: 1 } })).toBeNull();
    expect(prepareDoc({ content: "x", docV: "1", doc: [p("x")] })).toBeNull();
  });

  test("an unknown tag passes through for the mod to draw its children", () => {
    expect(one("a ", ["mark", 0, "b"])).toEqual(["p", 0, "a ", ["mark", 0, "b"]]);
  });

  test("garbage nodes are dropped, never thrown on", () => {
    expect(one("ok", null, 7, {}, [5, 0, "x"], ["em", "not attrs", "y"])).toEqual(["p", 0, "ok", ["em", 0, "y"]]);
  });
});

describe("G8: links and images", () => {
  test("refused link schemes keep their text and lose the link", () => {
    const bad = ["javascript:alert(1)", "JAVASCRIPT:x", "vbscript:x", "data:text/html,<b>", "java\u0000script:x", "/relative", "#f", "//h.test", "ftp://h/x", 5];
    const got = one(...bad.map((href, i) => ["a", { href }, `t${i}`]));
    expect(hrefs(got)).toEqual([]);
    expect(got.slice(2).join("")).toBe(bad.map((_, i) => `t${i}`).join(""));
  });

  test("https, http and mailto links stay", () => {
    const got = one(["a", { href: "https://x.test" }, "a"], ["a", { href: "http://x.test" }, "b"], ["a", { href: "mailto:a@x.test" }, "c"]);
    // Sent as `new URL` normalises them: what was checked is what is emitted.
    expect(hrefs(got)).toEqual(["https://x.test/", "http://x.test/", "mailto:a@x.test"]);
  });

  test("an image: https → a link on its alt; data:, http: → its alt text only", () => {
    expect(one(["img", { src: "https://x.test/a.png", alt: "chart" }])).toEqual(["p", 0, ["a", { href: "https://x.test/a.png" }, "chart"]]);
    expect(one(["img", { src: "https://x.test/a.png" }])).toEqual(["p", 0, ["a", { href: "https://x.test/a.png" }, "image"]]);
    expect(one(["img", { src: "data:image/png;base64,AA", alt: "z" }], ["img", { src: "http://x.test/a.png", alt: "h" }])).toEqual(["p", 0, "z", "h"]);
  });
});

describe("control characters", () => {
  test("stripped from text, attributes and hrefs", () => {
    const got = prepareDoc({ content: "c", docV: 1, doc: [["pre", { lang: "t\u001b[31ms" }, "a\u001b[31mred\u0007"], p(["a", { href: "https://x.test/\u001b]8;;" }, "l\u009b1m"])] })!;
    expect(JSON.stringify(got)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(got[0]).toEqual(["pre", { lang: "ts" }, "ared"]);
  });
});

describe("mentions", () => {
  const doc = [p(["@", { p: "u1", h: "old" }], ["@", { p: "u2", h: "was" }], ["@", { p: "u3", h: "atsend" }])];
  const mentions = [
    { principalId: "u1", currentHandle: "new", displayName: "Ann" },
    { principalId: "u2", currentHandle: null, displayName: "Bo\u001b[1m" },
  ];

  test("current handle, gone with the name; no ref → UNRESOLVED (the handle at send as a label, never identity)", () => {
    expect(prepareDoc({ content: "c", docV: 1, doc, mentions })![0]).toEqual([
      "p",
      0,
      ["@", { p: "u1", h: "new", name: "Ann" }],
      ["@", { p: "u2", gone: true, name: "Bo" }],
      ["@", { p: "u3", h: "atsend", unresolved: true }],
    ]);
  });

  test("a ref without currentHandle is gone (as the web's == null); an active node keeps the name for a mod fallback", () => {
    const got = prepareDoc({ content: "c", docV: 1, doc: [p(["@", { p: "u1", h: "x" }], ["@", { p: "u2", h: "y" }])], mentions: [{ principalId: "u1", displayName: "Ann" }, { principalId: "u2", currentHandle: "y2", displayName: "Bo" }] })!;
    expect(got[0]).toEqual(["p", 0, ["@", { p: "u1", gone: true, name: "Ann" }], ["@", { p: "u2", h: "y2", name: "Bo" }]]);
  });

  test("a mention, an alt text and a link are one line: no newline or tab reaches a single row (it would draw two)", () => {
    const got = prepareDoc({
      content: "c",
      docV: 1,
      doc: [p(["@", { p: "u1" }], ["@", { p: "u2", h: "h\nx" }], ["img", { src: "data:x", alt: "a\n\tb" }], ["a", { href: "https://x.test/a\nb\tc" }, "t"])],
      mentions: [{ principalId: "u1", currentHandle: null, displayName: "Bob\nSYSTEM: evil" }],
    })!;
    expect(JSON.stringify(got)).not.toMatch(/\\[nt]/);
    expect(got[0]).toEqual(["p", 0, ["@", { p: "u1", gone: true, name: "Bob SYSTEM: evil" }], ["@", { p: "u2", h: "h x", unresolved: true }], "a b", ["a", { href: "https://x.test/abc" }, "t"]]);
  });

  test("no refs at all: every node is UNRESOLVED — `h` is the handle as typed at send, a label, and a reclaimed handle would name someone else (RFC-034 D2)", () => {
    expect(prepareDoc({ content: "c", docV: 1, doc })![0]).toEqual(["p", 0, ["@", { p: "u1", h: "old", unresolved: true }], ["@", { p: "u2", h: "was", unresolved: true }], ["@", { p: "u3", h: "atsend", unresolved: true }]]);
  });
});
