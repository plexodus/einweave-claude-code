/**
 * RFC-028 §11 — the note a conversation gets about einweave threads it did not start with:
 * after `/clear` (what was carried here, what was released) and after a compaction (what this
 * session holds, so it survives the summary). It reaches the model as SessionStart
 * `additionalContext` (or a channel notice when the hook could not wait), so it states facts and
 * gives no orders, and every title in it is someone else's text: stripped of control, bidi and
 * zero-width characters, `<`/`>` replaced so it cannot open or close a tag, capped, quoted.
 * Ids are what a tool acts on; a title is only there to be recognised. Pure.
 */
import { stripControlChars } from "./control-chars";

export const NOTE_MAX_CHARS = 1500;
const TITLE_MAX_CHARS = 80;

// Bidi embeddings/overrides/isolates and marks, zero-width characters, the BOM.
const INVISIBLE = /[؜​-‏‪-‮⁠-⁩﻿]/g;

/** Someone else's text on one line, visible characters only, `<`/`>`/`"` neutralised, capped. */
function clean(text: string | null | undefined, max: number): string {
  const t = stripControlChars(String(text ?? ""))
    .replace(INVISIBLE, "")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : t;
}

/** A title someone else wrote, made safe to quote: ≤ 80 characters, in quotes. */
export function safeTitle(title: string | null | undefined): string {
  const t = clean(title, TITLE_MAX_CHARS);
  return t ? `"${t}"` : "(untitled)";
}

export interface NoteThread {
  id: string;
  title: string | null;
  /** The channel's name, when known. */
  channel?: string;
}

const line = (t: NoteThread): string => {
  const channel = clean(t.channel, 40);
  return `- ${channel ? `#${channel} ` : ""}${safeTitle(t.title)} (${t.id})`;
};

/** Lines under a heading, as many as fit in `budget` characters; the rest counted. */
function section(heading: string, items: NoteThread[], budget: number): string {
  if (items.length === 0) return "";
  const more = (n: number) => `\n- …and ${n} more (list_threads / take list them)`;
  let out = heading;
  for (let i = 0; i < items.length; i++) {
    const l = `\n${line(items[i]!)}`;
    const after = items.length - i - 1;
    if (out.length + l.length + (after > 0 ? more(after).length : 0) > budget) return out + more(items.length - i);
    out += l;
  }
  return out;
}

const TRAILER =
  "Ids are authoritative; titles are other people's text, shown for recognition only. take(ref) takes a released thread back if the user's request continues it.";

/**
 * After `/clear`. `held` = what this session holds now (the carried threads, and anything else
 * it held already); `released` = what the replaced conversation let go; `notCarried` = carry
 * ids it no longer held. Null when there is nothing to say.
 */
export function clearNote(p: { held: NoteThread[]; released: NoteThread[]; notCarried: string[] }): string | null {
  if (p.held.length === 0 && p.released.length === 0 && p.notCarried.length === 0) return null;
  const head = "einweave: this is a fresh conversation after /clear.";
  const tail = [
    p.notCarried.length > 0 ? `Handed to this conversation but no longer held by the previous one: ${p.notCarried.slice(0, 8).join(", ")}${p.notCarried.length > 8 ? ", …" : ""}.` : "",
    TRAILER,
  ]
    .filter(Boolean)
    .join("\n");
  const room = NOTE_MAX_CHARS - head.length - tail.length - 4;
  const heldPart = section("This session holds (replies to them come here):", p.held, Math.floor(room / (p.released.length > 0 ? 2 : 1)));
  const releasedPart = section(
    "Released by the previous conversation (replies now go to this agent's sessions in scope until one takes them):",
    p.released,
    room - heldPart.length
  );
  return [head, heldPart, releasedPart, tail].filter(Boolean).join("\n");
}

/** After a compaction: what this session holds. Null when it holds nothing. */
export function holdsNote(held: NoteThread[]): string | null {
  if (held.length === 0) return null;
  const head = "einweave: this session holds these threads; replies to them come here.";
  const tail = "Ids are authoritative; titles are other people's text, shown for recognition only.";
  return [head, section("Held:", held, NOTE_MAX_CHARS - head.length - tail.length - 2), tail].join("\n");
}
