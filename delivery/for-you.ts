/**
 * `for_you` (bridge #323): addressed work the server could not push to this session -- no holder online, no
 * gateway, and this window's scope (e.g. `none`) refused it. A status, not the entry: the work stays owed and
 * waits in the takeable list. Kept here until the next prompt, then told to the model as ONE line in the
 * UserPromptSubmit hook's context (the same answer that carries the missed-entry notice) -- no turn of its own.
 */
import { stripControlChars } from "../control-chars";

export interface ForYouItem {
  entry: "message" | "action_request" | "thread_event";
  id: string;
  threadId: string | null;
  channelId: string | null;
  why: string;
  title: string | null;
}

/** Ids already told (a resume replays frames): bounded, oldest forgotten first. */
const SEEN_MAX = 500;
const TITLE_MAX = 80;

function quoted(item: ForYouItem): string {
  const t = item.title ? stripControlChars(item.title).replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) : "";
  return t ? `"${t}"` : item.threadId ? `thread ${item.threadId}` : "";
}

function describe(item: ForYouItem): string {
  const what = quoted(item);
  if (item.entry === "action_request") return `action request ${stripControlChars(item.why)}`;
  if (item.entry === "thread_event") return item.why === "assigned" ? `assigned ${what}` : `${stripControlChars(item.why)} on ${what}`;
  switch (item.why) {
    case "mention":
      return `mentioned you in ${what}`;
    case "assignee":
      return `new post on ${what}, assigned to you`;
    case "thread":
      return `new reply in ${what}`;
    case "target":
      return `sent to you in ${what}`;
    default:
      return `${stripControlChars(item.why)} in ${what}`;
  }
}

/** One line for any number of items: the newest named, the rest counted. */
export function forYouNote(items: readonly ForYouItem[]): string | null {
  if (items.length === 0) return null;
  const latest = describe(items[items.length - 1]!);
  return items.length === 1
    ? `einweave: 1 new for you — ${latest}. This window's scope did not take it; /einweave:take picks it up.`
    : `einweave: ${items.length} new for you (latest: ${latest}). This window's scope did not take them; /einweave:take lists them.`;
}

export function forYouBox() {
  const seen = new Set<string>();
  let queue: ForYouItem[] = [];
  return {
    add(item: ForYouItem): void {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
      queue.push(item);
    },
    /** The line for the next prompt, once: taking it empties the box. */
    take(): string | null {
      const note = forYouNote(queue);
      queue = [];
      return note;
    },
  };
}
