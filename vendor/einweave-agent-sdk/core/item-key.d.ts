import type { WorkspaceLinks } from "./links";
export declare const ITEM_PREFIX_MIN: number;
export declare const ITEM_PREFIX_MAX: number;
/** What `deriveItemPrefix` answers when a name yields nothing usable. */
export declare const ITEM_PREFIX_FALLBACK: string;
export type ItemPrefixError = "too_short" | "too_long" | "invalid";
/** A prefix a person typed → its stored form (upper case), or why not: 2–5 characters, a letter first, then letters or digits. */
export declare const validateItemPrefix: (raw: string) => {
    ok: true;
    prefix: string;
} | {
    ok: false;
    error: ItemPrefixError;
};
/** The prefix a workspace gets from its name when nobody chose one. Always a valid prefix. */
export declare const deriveItemPrefix: (name: string) => string;
/** `EW`, `112` → `EW-112`. */
export declare const formatItemKey: (prefix: string, number: number) => string;
export interface ParsedItemKey {
    /** Upper-cased. */
    prefix: string;
    number: number;
}
/** A WHOLE string shaped like a key → its parts; else null. Shape only: whose prefix it is, the server answers. */
export declare const parseItemKey: (raw: string) => ParsedItemKey | null;
export interface ItemKeyMatch {
    /** Offsets into the text, `end` exclusive. */
    start: number;
    end: number;
    /** As typed (`ew-12`). */
    text: string;
    /** Upper-cased; may be a retired prefix. */
    prefix: string;
    number: number;
    /** `prefix-number`, upper-cased: what to ask `threads.keys` for. */
    key: string;
}
/**
 * Every key in a text, for the workspace's own prefixes (`me.workspace()`: `itemPrefix` +
 * `itemPrefixAliases`) — only those, because the shape alone also fits `UTF-8` and `SHA-256`.
 * Reads plain text: skip code and link nodes yourself.
 */
export declare const matchItemKeys: (text: string, prefixes: readonly string[]) => ItemKeyMatch[];
/** What a typed thread reference names, before the server is asked anything. */
export type ThreadRef = 
/** A thread id (lower-cased). */
{
    kind: "id";
    threadId: string;
}
/** A thread or message link of THIS workspace (the server's own templates), with the channel its `{channelId}` slot holds. */
 | {
    kind: "url";
    threadId: string;
    channelId?: string;
}
/** A work item key, upper-cased — resolve it with `threads.keys`. */
 | {
    kind: "key";
    key: string;
}
/** A link that is not one of this workspace's: another workspace, another site. Never followed. */
 | {
    kind: "foreign_url";
} | {
    kind: "invalid";
};
/**
 * What `input` names: a thread id, a thread / message link of the caller's OWN workspace (`links`
 * from `me.workspace()`; null = links unknown, so no link is accepted), or a key. Pure — it asks
 * nobody. A link to another workspace is `foreign_url`, never its thread id: the id in it is not
 * this workspace's to act on.
 */
export declare function parseThreadRef(input: string, links: WorkspaceLinks | null): ThreadRef;
