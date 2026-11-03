/**
 * RFC-034 D6 — a message's doc made ready for the mod to draw. The mod imports nothing from the plugin
 * (its sandbox holds only `mod/` and `types/`), so every decision a renderer must make about the doc is
 * made HERE, once, with the SDK's own rules:
 *
 * - G11: `docToRender` alone decides whether there is a doc to draw. `null` → the mod draws `content` as
 *   plain text, never parsed.
 * - G8: an `a` whose `href` fails `allowedLink` becomes its children; an `img` whose `src` fails
 *   `allowedImage` becomes its alt text; an allowed one becomes a link on its alt text (a terminal has
 *   no images). The stored doc is data: the server applied the same rule, and we do not rely on it.
 * - Every string, text and attribute alike, goes through `stripControlChars`, as `content` does: the
 *   pane draws all of it, and an escape sequence in it would style the terminal. What the mod draws as
 *   ONE row (a mention, an alt text, an attribute, a URL) also loses its newlines and tabs: a newline
 *   there would draw two rows where the pane counts one, the second free text the author controls.
 * - A URL is checked as it will be emitted: cleaned first, then `allowedLink`/`allowedImage`, then sent
 *   normalised by `new URL` (never the raw string the check saw).
 * - An `@` node is resolved from the message's mention refs: the current handle, or `gone` with the
 *   person's name when they hold none (`currentHandle == null`, as the web's "gone" pill). No ref: the
 *   handle at send. An active node carries the name too, for when it has no handle at all.
 *
 * A node that is neither text nor an element is dropped, never thrown on; a tag this release does not
 * know passes through for the mod to draw its children.
 */
import { allowedImage, allowedLink, docToRender } from "./vendor/einweave-agent-sdk/core/index.js";
import { stripControlChars } from "./control-chars";

export interface MentionRefLike {
  principalId?: unknown;
  currentHandle?: unknown;
  displayName?: unknown;
}

export interface DocMessage {
  content?: unknown;
  doc?: unknown;
  docV?: unknown;
  mentions?: unknown;
}

type Node = string | unknown[];

/** One row's worth of text: cleaned, whitespace runs (newlines, tabs) to one space. */
const line = (v: unknown): string | null => (typeof v === "string" ? stripControlChars(v).replace(/\s+/g, " ").trim() : null);
/** A URL as it will be emitted, when the rule allows it; else null. */
const url = (v: unknown, allowed: (u: unknown) => u is string): string | null => {
  const u = typeof v === "string" ? stripControlChars(v) : null;
  return allowed(u) ? new URL(u).href : null;
};

export function prepareDoc(m: DocMessage): Node[] | null {
  const doc = docToRender({ content: String(m.content ?? ""), doc: m.doc, docV: typeof m.docV === "number" ? m.docV : null });
  if (!doc) return null;
  const refs = new Map<string, MentionRefLike>();
  if (Array.isArray(m.mentions)) for (const r of m.mentions as MentionRefLike[]) if (r && typeof r.principalId === "string") refs.set(r.principalId, r);

  const walk = (nodes: readonly unknown[]): Node[] => {
    const out: Node[] = [];
    for (const n of nodes) {
      if (typeof n === "string") {
        out.push(stripControlChars(n));
        continue;
      }
      if (!Array.isArray(n) || typeof n[0] !== "string") continue;
      const tag = stripControlChars(n[0]);
      const a = n[1] && typeof n[1] === "object" && !Array.isArray(n[1]) ? (n[1] as Record<string, unknown>) : {};
      const kids = walk(n.slice(2));
      if (tag === "a") {
        const href = url(a.href, allowedLink);
        if (href) out.push(["a", { href }, ...kids]);
        else out.push(...kids);
        continue;
      }
      if (tag === "img") {
        const alt = line(a.alt) ?? "";
        const src = url(a.src, allowedImage);
        if (src) out.push(["a", { href: src }, alt || "image"]);
        else if (alt) out.push(alt);
        continue;
      }
      if (tag === "@") {
        const p = line(a.p);
        const ref = p ? refs.get(p) : undefined;
        const name = ref ? line(ref.displayName) : null;
        if (ref && ref.currentHandle == null) out.push(["@", { p, gone: true, name }]);
        else out.push(["@", { p, h: (ref && line(ref.currentHandle)) || line(a.h), ...(name ? { name } : {}) }]);
        continue;
      }
      // Every other attribute the mod reads is a string, a number or a boolean: copy those, cleaned.
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a)) {
        if (typeof v === "string") clean[k] = line(v);
        else if (typeof v === "number" || typeof v === "boolean") clean[k] = v;
      }
      out.push([tag, Object.keys(clean).length ? clean : 0, ...kids]);
    }
    return out;
  };
  return walk(doc);
}
