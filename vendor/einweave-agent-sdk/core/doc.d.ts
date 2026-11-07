export type Tag = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "ol" | "li" | "blockquote" | "pre" | "code" | "em" | "strong" | "s" | "a" | "img" | "table" | "thead" | "tbody" | "tr" | "th" | "td" | "hr" | "br" | "@"
/** RFC-035 D5: a reference to a message in this workspace (`m` = its id); children = the link's own text. */
 | "ref";
export interface Attrs {
    lang?: string;
    checked?: boolean;
    start?: number;
    href?: string;
    src?: string;
    alt?: string;
    /** `@`: the mentioned principal's id. */
    p?: string;
    /** `@`: its handle at send; null when it had none (clients fall back to a display name). */
    h?: string | null;
    /** `ref`: the referenced message's id. Readers hydrate it (`GET /api/messages/refs`); the doc never carries its text. */
    m?: string;
    /**
     * `ref`: the link's text WAS the link (a pasted URL) — a reader shows who wrote the message and what it
     * said instead. Absent: the writer named it (`[the port discussion](…)`), and that name is shown.
     */
    bare?: boolean;
}
export type DocNode = string | DocEl;
export type DocEl = [tag: Tag, attrs: Attrs | 0, ...children: DocNode[]];
export type Doc = DocNode[];
export interface DocCase {
    name: string;
    content: string;
    /** `code`: never parsed (D2), the doc is one `pre`. */
    type?: "code";
    /** Lowercased token → the principal it resolved to at send. */
    resolved?: Record<string, {
        p: string;
        h: string;
    }>;
    /** RFC-035 D5: the send's web origin + workspace — message links into it become `ref`. */
    refs?: {
        origin: string;
        workspaceId: string;
    };
    doc: Doc;
    /** `docText(doc)`, no `nameOf`. */
    text: string;
}
/** G11: a doc a release may receive that it must NOT render as a doc (or must, despite oddities). */
export interface DocForwardCase {
    name: string;
    content: string;
    doc?: unknown;
    docV?: number;
    render: "doc" | "content";
    text: string;
}
/** What a message carries for rendering: its text, and the doc when the server parsed one. */
export interface DocCarrier {
    content: string;
    doc?: unknown;
    docV?: number | null;
}
/** The doc format version this release reads and the server writes. 0 / absent = not parsed (show `content`). */
export declare const DOC_V: 1;
/** A doc as plain text, for previews and reply snippets (see the protocol's `docText`). */
export declare const docText: (doc: Doc, nameOf?: (principalId: string) => string | undefined) => string;
/** G11: the doc to render, or null = render `content` as plain text (see the protocol's `docToRender`). */
export declare const docToRender: (m: DocCarrier) => Doc | null;
/** G8: may a rendered doc link to this URL (http, https, mailto)? The server's rule; a renderer re-applies it. */
export declare const allowedLink: (u: unknown) => u is string;
/** G8: may a rendered doc show this image (https only)? The server's rule; a renderer re-applies it. */
export declare const allowedImage: (u: unknown) => u is string;
/** A message as plain text for previews: the rendered doc's text, else `content`. */
export declare const messageText: (m: DocCarrier, nameOf?: (principalId: string) => string | undefined) => string;
export declare const DOC_CORPUS: readonly DocCase[];
export declare const DOC_FORWARD_CASES: readonly DocForwardCase[];
