/**
 * RFC-031 §5: a search snippet is plain text with its hits wrapped in two private-use marks
 * (never HTML, never markdown). `snippetParts` is the one place a client splits it into runs;
 * the plugin's tool and mod both use it. Pure.
 */
/** Same values as the server's `MARK_START` / `MARK_END` (`packages/api/src/search/search.ts`). */
export declare const SEARCH_MARK_START = "\uE000";
export declare const SEARCH_MARK_END = "\uE001";
export interface SnippetPart {
    text: string;
    hit: boolean;
}
/**
 * Splits a snippet into plain and hit runs, in order; empty runs are dropped. An unclosed start mark
 * makes the rest a hit; a stray end mark is dropped. No mark character survives in the output.
 */
export declare function snippetParts(s: string): SnippetPart[];
