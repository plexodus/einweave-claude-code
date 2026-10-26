/**
 * `AgentClient.api` — typed HTTP methods for every endpoint the plugin's
 * `server.ts` calls (RFC-018 S1.3 plan item 3), built on ONE request function
 * that carries DPoP + the resource nonce + a single 401 retry + 429
 * `Retry-After`, adapted from the plugin's `apiFetch`.
 *
 * DIVERGES from the plugin in one deliberate way: `apiFetch` left its
 * `deadline()` uncleared on the success path so a CALLER reading the response
 * body afterwards stayed inside the same budget. Every method here reads the
 * body itself before returning, so `request()` clears the deadline in a
 * `finally` — matching `../core/deadline.ts`'s own documented contract
 * ("callers MUST call clear() … skipping it leaks both") rather than the
 * plugin's caller-specific workaround.
 */
import { type ConnectionKind, type DeliveryReason, type DeliveriesResponse, type Scope } from "../core";
import type { Runtime } from "./ports";
import type { AgentClient } from "./client";
export declare class ApiRequestError extends Error {
    readonly name = "ApiRequestError";
    readonly status: number;
    readonly body: unknown;
    readonly retryAfterS?: number;
    constructor(status: number, body: unknown, retryAfterS?: number);
}
export declare function isApiRequestError(e: unknown): e is ApiRequestError;
export interface ChannelSummary {
    id: string;
    name: string;
    visibility?: "public" | "private";
    [k: string]: unknown;
}
export interface ReadStateEntry {
    channelId: string;
    lastReadSeq?: number;
    unreadThreads?: number;
    [k: string]: unknown;
}
export interface MarkReadResult {
    ok: true;
    advanced: boolean;
    lastReadSeq: number;
    readAt: string;
}
/** What a read-and-mark (`messages.read` / `threads.read`) did with its run: `read` when the POST answered, `readError` when it failed — neither when nothing was to be marked. */
export interface ReadOutcome {
    read?: MarkReadResult;
    readError?: unknown;
}
export interface MessageEnvelope {
    id: string;
    channelId: string;
    threadId: string | null;
    seq?: number;
    content: string;
    type: string;
    agentId?: string | null;
    agentName?: string | null;
    /** The sending session's grant id, or null for a person / a session-less send. */
    senderContextId?: string | null;
    createdAt: string;
    [k: string]: unknown;
}
/**
 * What a post may carry. There is NO `contextId` / `broadcast` (RFC-028 D7): the thread's
 * hold is the target, from outside the agent and inside it; to move work to another
 * session of the agent, `threads.hold({action: "handover"})`. The server answers 400 to
 * a body that still names either.
 */
export interface SendBody {
    content: string;
    type?: string;
    /** RFC-028 D3: this reply takes the thread's hold (from a live holder only with `confirm`). Replies only. */
    take?: boolean;
    confirm?: boolean;
    clientMsgId?: string;
    metadata?: Record<string, unknown>;
    /**
     * RFC-029 D4, a REPLY only: assign the work item as you reply (a handle, an id or `me`).
     * The result carries `assign: {assignee: {id, name, handle, kind}, assigneeJoined?}`. A root names its assignee in
     * `threads.create` instead.
     */
    assignee?: string;
}
/** A session as a hold shows it (RFC-028 D3/D4). `parked`: not online and past the 120 s grace — nobody is there. */
export interface HoldHolder {
    id: string;
    label: string | null;
    online: boolean;
    parked?: boolean;
}
/** Where the posting session stands on the thread: it `held` it, or only `contribution`s to a sibling's hold (offer `take`). */
export interface SendHold {
    state: "held" | "contribution";
    holder: HoldHolder;
}
export interface SendResult {
    id: string;
    channelId?: string;
    /** RFC-028: present for an agent's post. */
    hold?: SendHold;
    /** RFC-029 D4: a reply naming an `assignee` answers the assign, named (S14) — `assigneeJoined` when it joined them. */
    assign?: {
        assignee: WorkPrincipal;
        assigneeJoined?: true;
    };
    [k: string]: unknown;
}
/** One row of `GET /api/threads?takeable=1` (RFC-028 D8): a thread this session could take. */
export interface TakeableThread {
    thread: {
        id: string;
        title: string;
        kind?: string;
        status?: string;
        replyCount?: number;
        lastActivityAt?: string;
    };
    channel: {
        id: string;
        name: string;
    };
    hold: {
        state: "unheld" | "parked" | "held";
        holder: (HoldHolder & {
            parked: boolean;
        }) | null;
    };
    /** `channel`: unread in a channel the agent subscribes to — only with `include: "channel"`. */
    why: "addressed" | "participant" | "channel";
}
export interface TakeableResult {
    threads: TakeableThread[];
    /** Opaque cursor for the next page (`cursor`); null on the last one. */
    next: string | null;
    /** With `include: "channel"` only (absent from an older server): unheld + parked rows per tier, all pages. */
    counts?: {
        forYou: number;
        channel: number;
    };
}
/** `POST /api/threads/:id/hold` (RFC-028 D3/D8). */
export type HoldRequest = {
    action: "take";
    confirm?: boolean;
} | {
    action: "release";
    agentId?: string;
} | {
    action: "handover";
    to: string;
    agentId?: string;
};
export interface HoldResult {
    threadId: string;
    agentId: string;
    hold: {
        state: "held";
        holder: HoldHolder;
    } | null;
    changed: boolean;
    moved: number;
}
/** One session of an agent (`GET /api/agents/:id/sessions`, RFC-028 D8). */
export interface AgentSession {
    id: string;
    label: string | null;
    /** null: it has not connected since kinds existed. */
    kind: ConnectionKind | null;
    scope: {
        mode: "all" | "channels" | "none";
        channelIds: string[];
    };
    state: "live" | "parked";
    online: boolean;
    parked: boolean;
    lastSeenAt: string | null;
    createdAt: string;
    /** Thread ids this session holds. */
    holds: string[];
}
export interface ThreadSummary {
    id: string;
    title: string;
    kind?: ThreadKind;
    status?: string;
    replyCount?: number;
    unreadCount?: number;
    lastActivityAt?: string;
    [k: string]: unknown;
}
export interface ThreadResult {
    threadId: string;
    kind?: string;
    status?: string;
    answerMessageId?: string | null;
    [k: string]: unknown;
}
/**
 * `GET /api/threads/:id/messages` (`routes/threads.ts`) — NOT `{ messages: [...] }`
 * (that shape is `GET /api/messages`'s, `messages.list` below). A thread's own read
 * names its root separately (`parent`, `null` for a thread with none) from its
 * replies, and pages by `sinceSeq`/`hasMore`/`nextSinceSeq` — `since` (an ISO
 * timestamp) is not an accepted query param here, unlike the channel view.
 * RFC-018 S1.5 conformance caught this: `threads.messages` used to claim the
 * `messages.list` shape and every read against a real server threw at `.messages.some(...)`.
 */
export interface ThreadMessagesResult {
    thread: {
        id: string;
        channelId: string;
        title: string;
        kind?: string;
        status?: string;
        answerMessageId: string | null;
        replyCount: number;
        lastSeq: number;
        /** THIS reader's reply read position: replies above it are unread, and a read must be contiguous from it. */
        readSeq: number;
        /** RFC-029 G11: a work item's header for THIS reader; null for a conversation kind. */
        work?: ThreadReadWork | null;
    } | null;
    parent: (MessageEnvelope & {
        deliveryReasons?: DeliveryReason[];
    }) | null;
    replies: (MessageEnvelope & {
        deliveryReasons?: DeliveryReason[];
    })[];
    hasMore: boolean;
    /** Replies exist below the first one returned (page into them with `beforeSeq`). */
    hasOlder?: boolean;
    /** How many replies lie below the first one returned (exact). */
    olderCount?: number;
    nextSinceSeq: number;
    agent: string;
}
export interface AgentSummary {
    id: string;
    name: string;
    handle: string | null;
    online?: boolean;
    state?: string;
    [k: string]: unknown;
}
/**
 * One principal in `GET /api/presence` (RFC-025): every person and agent in the workspace
 * who is connected or was seen in the last 30 days. `lastSeenAt` is exact; null only when
 * never seen. `handle` is what an @mention resolves (null when none) — `id` is opaque.
 */
export interface PresencePrincipal {
    id: string;
    name: string;
    handle: string | null;
    kind: "agent" | "human";
    connected: boolean;
    connectedAt: string | null;
    lastSeenAt: string | null;
}
/**
 * `presenceEnabled: false` — a workspace admin turned presence off (RFC-025 D10): people
 * are OMITTED, not offline; only agents (and nobody else) are listed. Read it before
 * concluding from an empty people list that nobody is around.
 */
export interface PresenceList {
    principals: PresencePrincipal[];
    presenceEnabled: boolean;
}
export interface ContextSummary {
    id: string;
    label?: string | null;
    state: string;
    lastHeartbeatAt?: string;
    clientVersion?: string | null;
    [k: string]: unknown;
}
export type ConversationKind = "discussion" | "question";
export type WorkKind = "task" | "bug" | "feature" | "request";
export type ThreadKind = ConversationKind | WorkKind;
export type WorkStatus = "triage" | "todo" | "in_progress" | "needs_input" | "in_review" | "resolved";
export type ResolvedReason = "done" | "not_planned" | "duplicate" | "outdated" | "cannot_reproduce";
export type LinkType = "pull_request" | "commit" | "branch" | "issue" | "build" | "deploy" | "release" | "url";
export type LinkRelation = "related" | "fixes";
export type AttentionState = "not_picked_up" | "quiet" | "stuck";
/** A fix: an http(s) URL only (422 otherwise). */
export interface WorkFix {
    type: LinkType;
    url: string;
    title?: string;
}
/** The root a `threads.create` sends: a message plus the item it starts. */
export interface CreateItemBody extends Omit<SendBody, "take" | "confirm" | "assignee"> {
    title?: string;
    /**
     * Default: `question` for a `type: "question"` root, else `discussion` — NOT the channel's
     * `defaultThreadKind` (that is the composer's default; the server never applies it). Name a
     * work kind to create an item.
     */
    kind?: ThreadKind;
    /** The kind's fields (`work.schema()`), its `required` ones included. */
    fields?: Record<string, unknown>;
    /** A handle (`@name` / `name`), a principal id, or `me`. */
    assignee?: string;
    labels?: string[];
    /** A calendar date, `YYYY-MM-DD` (422 `due_must_be_date` otherwise). */
    due?: string;
    /** The parent item's thread id (same channel). */
    parent?: string;
    review?: boolean;
    /** File the bug although a near-identical one exists (after a 409 `similar_exists`). */
    confirmNew?: boolean;
}
/** A similar thread, as create (and its 409 `similar_exists`) names it. `reason`: a resolved one's reason. */
export interface SimilarThread {
    threadId: string;
    /** The candidate's root message (null for a thread with none). */
    rootMessageId: string | null;
    title: string;
    status: string;
    kind: string;
    reason: string | null;
    score: number;
}
export interface CreateItemResult extends SendResult {
    threadId: string;
    /**
     * A work kind only. `status` is `triage` (D8) when an AGENT created a root item naming no assignee,
     * itself, or an agent it manages — or, for any creator, in an intake channel (`triageNewItems`).
     * A child of a WORK item never starts in triage (it splits accepted work, intake channel included);
     * a child of a conversation counts as a root here.
     */
    item?: {
        threadId: string;
        kind: WorkKind;
        status: WorkStatus;
        /** Named, never a bare id: a `WorkPrincipal`. */
        assignee: WorkPrincipal | null;
        parentThreadId: string | null;
        dueAt: string | null;
        labels: string[];
        review: boolean | null;
        assigneeJoined?: true;
    };
    similar?: SimilarThread[];
}
/** `PUT /api/threads/:id/work`. Name at least one field (422 otherwise). */
export interface WorkEditBody {
    kind?: ThreadKind;
    /** An open-side status; `text` says why (required when sending an `in_review` item back). */
    status?: Exclude<WorkStatus, "resolved">;
    text?: string;
    /** A handle, an id or `me`; `null` unassigns. */
    assignee?: string | null;
    /** A merge patch: a key set to `null` is removed. */
    fields?: Record<string, unknown>;
    labels?: {
        add?: string[];
        remove?: string[];
    };
    /** `YYYY-MM-DD`, or `null` to clear. */
    due?: string | null;
    title?: string;
    /** `null` follows the channel's review policy again. */
    review?: boolean | null;
    expectedStatus?: string;
}
/** `POST /api/threads/:id/resolve` (D6). */
export interface ResolveBody {
    reason?: ResolvedReason;
    /** With `reason: "duplicate"` only. */
    duplicateOf?: string;
    conclusion?: string;
    fix?: WorkFix;
    resolvedIn?: {
        component: string;
        version: string;
    };
    /** A person channel owner only, not under `fast`. */
    withoutReview?: {
        reason: string;
    };
    /** The `result` approved (the header's `latestResult.id`); `null` = "I saw none"; absent = no check. */
    resultEventId?: string | null;
    expectedStatus?: string;
}
/** `POST /api/threads/:id/reopen`. */
export interface ReopenBody {
    regression?: boolean;
    /** The regression report, a reply of this thread. */
    messageId?: string;
    text?: string;
    expectedStatus?: string;
}
/** `POST /api/threads/:id/triage` (D8). */
export type TriageBody = {
    action: "accept";
    assignee?: string;
    expectedStatus?: string;
} | {
    action: "decline";
    reason: string;
    expectedStatus?: string;
} | {
    action: "duplicate";
    duplicateOf: string;
    expectedStatus?: string;
};
/** `POST /api/threads/:id/activity` (D5). */
export type ActivityBody = {
    type: "plan";
    items: {
        text: string;
        done?: boolean;
    }[];
    expectedStatus?: string;
} | {
    type: "progress";
    text: string;
    expectedStatus?: string;
}
/** `to`: 1–5 handles / ids who can read the item; default the requester. */
 | {
    type: "needs_input";
    text: string;
    to?: string[];
    expectedStatus?: string;
} | {
    type: "result";
    text: string;
    fix?: WorkFix;
    conclusion?: string;
    proposed?: {
        reason: ResolvedReason;
        duplicateOf?: string;
    };
    expectedStatus?: string;
} | {
    type: "failed";
    text: string;
    expectedStatus?: string;
};
/**
 * THE shape of every work principal (S15): an `assignee` (frames, results, `work.list`,
 * `children`), `createdBy`, a link's `addedBy`. Name it with `principalLabel(p, self?)`
 * (this SDK; the server's header / `thread_event` `names` rule): `@handle`, else `name`,
 * else "a removed agent" / "a removed person" by `kind`; your own id → "you" — never `id`.
 */
export interface WorkPrincipal {
    id: string;
    /** Null when the principal has none left (a removed agent). */
    name: string | null;
    handle: string | null;
    kind: "agent" | "human";
}
/** A thread as a header names it (`@einweave/threads` `WorkHeaderThreadRef`). */
export interface WorkThreadRef {
    id: string;
    title: string;
    kind: ThreadKind;
    status: string;
}
/** A principal as a header names it (`WorkHeaderPrincipal`): `handle` null when none is left. */
export interface WorkHeaderPrincipal {
    id: string;
    handle: string | null;
    name: string | null;
    kind: "agent" | "human";
}
/**
 * The answer of every work write (`work`, `resolve`, `reopen`, `triage`, `activity`): the
 * thread's frame, a work item's header fields (absent for a conversation kind), `createdBy`
 * (named, never a bare id — S15) and `changed`.
 */
export interface WorkItemFrame {
    threadId: string;
    channelId: string;
    title: string;
    titleSource?: string;
    kind: ThreadKind;
    status: string;
    resolvedReason: string | null;
    conclusion: string | null;
    answerMessageId: string | null;
    updatedAt: string;
    /** Named (S15): `name`/`handle` null when none is left — print a fallback, never the id. */
    createdBy: WorkPrincipal;
    changed: boolean;
    assignee?: WorkPrincipal | null;
    dueAt?: string | null;
    fields?: Record<string, unknown>;
    /** Label ids. */
    labels?: string[];
    /** How many links (`links.add` lists none here). */
    links?: number;
    /** The parent item (`WorkHeaderThreadRef`): note `id`, not `threadId`. */
    parent?: WorkThreadRef | null;
    children?: {
        n: number;
        open: number;
    };
    latestActivity?: {
        action: string;
        text: string | null;
        at: string;
        by: WorkHeaderPrincipal | null;
    } | null;
    /** D13, rendered; null when it does not apply (no agent assignee, triage, resolved). */
    liveness?: {
        state: string;
        text: string;
    } | null;
    /** Resolved by a person owner without review: who, and why. */
    withoutReview?: {
        by: WorkHeaderPrincipal;
        reason: string;
    };
    /** The review policy the item was resolved under. */
    resolvedPolicy?: string;
    assigneeJoined?: true;
    [k: string]: unknown;
}
/**
 * What THIS reader may do now (server-computed, S10) — each flag: the route would accept the
 * caller's canonical request. Advice for what to offer; the route re-decides under its locks.
 */
export interface WorkReaderMay {
    resolve: boolean;
    withdraw: boolean;
    withoutReview: boolean;
    triage: {
        accept: boolean;
        assign: boolean;
        decline: boolean;
    };
    changesRequested: boolean;
    assign: boolean;
    claim: boolean;
    reopen: boolean;
    regression: boolean;
}
/** `thread.work` on `threads.messages` (G11): the header rendered for this reader. A plugin prints `text`. */
export interface ThreadReadWork {
    /** The renderer's structured model (what the web draws) — opaque here. */
    model: Record<string, unknown>;
    text: string;
    may: WorkReaderMay;
    /**
     * The current round's latest `result`: send its `id` as the resolve's `resultEventId`; `detail`
     * (`text`, `proposed`, `fix`, `conclusion`) is what that resolve approves. Null: none this round.
     */
    latestResult: {
        id: string;
        detail: Record<string, unknown>;
    } | null;
    /** The item has had a `result` in any round (a withdrawal is then closed). */
    everHadResult: boolean;
}
export interface WorkLink {
    id: string;
    type: LinkType;
    url: string;
    title: string | null;
    relation: LinkRelation;
    provider: string | null;
    externalId: string | null;
    /** Named (S15), the frame's `assignee` shape; null when no one added it (a resolve's fix link). */
    addedBy: WorkPrincipal | null;
    createdAt: string;
}
export interface AddLinkBody {
    type: LinkType;
    /** http(s) only. */
    url: string;
    title?: string;
    /** Default `related`; a re-add may turn it into `fixes`. */
    relation?: LinkRelation;
    /** An open registry id (`github`, `azure-devops`, …). */
    provider?: string;
    externalId?: string;
}
export interface WorkChildren {
    threadId: string;
    children: {
        threadId: string;
        kind: WorkKind;
        status: WorkStatus;
        title: string;
        resolvedReason: string | null;
        assignee: WorkPrincipal | null;
        dueAt: string | null;
        createdAt: string;
    }[];
    n: number;
    open: number;
}
export interface WorkListQuery {
    /** One channel (id or name); omitted = every channel the caller reads. */
    channel?: string;
    /** Title / text search. */
    query?: string;
    kind?: WorkKind | readonly WorkKind[];
    /** Default: the open side. */
    status?: WorkStatus | readonly WorkStatus[];
    /** A handle, an id or `me`. */
    assignee?: string;
    label?: string;
    /** A parent item's thread id. */
    parent?: string;
    severity?: string | readonly string[];
    /** `YYYY-MM-DD`. */
    dueBefore?: string;
    /** `component[@version]`. */
    resolvedIn?: string;
    withoutReview?: boolean;
    attention?: AttentionState | readonly AttentionState[];
    /** ISO timestamp. */
    updatedAfter?: string;
    sort?: "updated" | "created" | "due" | "severity";
    /** ≤ 50. */
    limit?: number;
    cursor?: string;
}
export interface WorkListItem {
    threadId: string;
    kind: WorkKind;
    status: WorkStatus;
    title: string;
    channelId: string;
    channelName: string;
    assignee: WorkPrincipal | null;
    resolvedReason: string | null;
    parentThreadId: string | null;
    dueAt: string | null;
    /** Bugs only. */
    severity?: string | null;
    labels: string[];
    attention?: AttentionState;
    /** Named (S15): `name`/`handle` null when none is left — print a fallback, never the id. */
    createdBy: WorkPrincipal;
    createdAt: string;
    updatedAt: string;
    lastActivityAt: string | null;
    /** Unread messages for THIS reader — the thread list's rule, so the two agree. */
    unreadCount: number;
}
export interface WorkListResult {
    scope: "work";
    items: WorkListItem[];
    /** Opaque cursor for the next page; null on the last one. */
    next: string | null;
}
/** One entry of a kind's intake template, in the order it is asked and shown. */
export interface WorkFieldTemplate {
    key: string;
    label: string;
    shape: string;
    required: boolean;
    /** `enum` only. */
    values?: string[];
}
export interface WorkSchema {
    kinds: ({
        kind: ConversationKind;
        category: "conversation";
        reasons: string[];
    } | {
        kind: WorkKind;
        category: "work";
        fields: Record<string, unknown>;
        required: string[];
        template: WorkFieldTemplate[];
        reasons: string[];
    })[];
    statuses: {
        conversation: string[];
        work: WorkStatus[];
    };
    openStatuses: WorkStatus[];
    movableStatuses: WorkStatus[];
    reasons: ResolvedReason[];
    severities: string[];
    linkTypes: LinkType[];
    linkRelations: LinkRelation[];
    reviewPolicies: string[];
    labels: {
        id: string;
        name: string;
        color: string | null;
        description: string | null;
    }[];
    /** With `channel`: that channel's settings. */
    channel?: {
        id: string;
        name: string;
        reviewPolicy: string;
        triageNewItems: boolean;
        defaultThreadKind: ThreadKind;
    };
}
export type Api = ReturnType<typeof createApi>;
export declare function createApi(rt: Runtime, client: AgentClient): {
    channels: {
        /** `includeArchived`: an archived channel resolves too (so join/leave can say "archived", not "no such channel"). */
        list: (p?: {
            includeArchived?: boolean;
        }) => Promise<{
            channels: ChannelSummary[];
        }>;
        join: (channelId: string) => Promise<unknown>;
        leave: (channelId: string) => Promise<unknown>;
        /** Who will read what is posted here (decision 17). */
        audience: (channelId: string) => Promise<unknown>;
        readState: () => Promise<{
            channels: ReadStateEntry[];
        }>;
        markRead: (channelId: string, body?: {
            lastReadSeq?: number;
            fromSeq?: number;
        }) => Promise<MarkReadResult>;
    };
    messages: {
        list: (p: {
            channel: string;
            limit?: number;
            since?: string;
            sinceSeq?: number;
        }) => Promise<{
            messages: (MessageEnvelope & {
                deliveryReasons?: DeliveryReason[];
            })[];
        }>;
        /**
         * Read a page of a channel's roots AND mark what it covered as read — `threads.read`'s rule for a
         * channel. Marks `(sinceSeq ?? 0, highest seq returned]` ONLY when that run is contiguous:
         *   - `sinceSeq`: from it (the server refuses the mark if the reader has not reached it). ✓
         *   - no cursor, a SHORT newest page: it holds the whole channel, so from 0. ✓
         *   - no cursor, a FULL newest page: older messages may be withheld — marking would clear them. ✗
         *   - `since` (a time filter): not anchored to a seq. ✗
         * The highest seq, not the last row: the newest page is ordered by created_at. `markRead: false`
         * peeks. `limit` is clamped to the server's own bounds (default 50, max 200) and always sent, so
         * "full page" is judged against the page the server actually served.
         */
        read: (p: {
            channel: string;
            limit?: number;
            since?: string;
            sinceSeq?: number;
            markRead?: boolean;
        }) => Promise<{
            messages: (MessageEnvelope & {
                deliveryReasons?: DeliveryReason[];
            })[];
        } & ReadOutcome>;
        /** Root-only (RFC-012 slice 5.4) — `body` must never carry `threadId`/`parentId`; reply with `threads.reply`. */
        create: (channelId: string, body: SendBody & {
            title?: string;
        }) => Promise<SendResult>;
        receipts: (ids: string[]) => Promise<{
            receipts: unknown[];
        }>;
    };
    threads: {
        list: (p: {
            channel: string;
            query?: string;
        }) => Promise<{
            channelId: string | null;
            threads: ThreadSummary[];
        }>;
        /**
         * RFC-028 D8: the open threads this session could take — addressed to the agent or posted in by it, not held
         * by this session: unheld › parked › held by another live session, newest first, cursor-paged (default 10).
         * `channel` narrows to one channel; omitted = across the agent's channels. Agents only.
         * `include: "channel"` adds, after those, the threads with something unread in a subscribed channel
         * (`why: "channel"`) and `counts` — for a session in scope `none`. An older server ignores it.
         */
        takeable: (p?: {
            channel?: string;
            limit?: number;
            cursor?: string;
            include?: "channel";
        }) => Promise<TakeableResult>;
        /**
         * RFC-028 D3: `take` | `release` | `handover {to}` on a thread's hold. An agent acts for its calling
         * session. A take from an ONLINE holder needs `confirm: true` (409 `holder_online` otherwise, naming
         * the holder — an `ApiRequestError` with `body.holder`).
         */
        hold: (threadId: string, body: HoldRequest) => Promise<HoldResult>;
        /** `{ thread, parent, replies, hasMore, nextSinceSeq }` — see `ThreadMessagesResult`. */
        messages: (threadId: string, p?: {
            limit?: number;
            sinceSeq?: number;
            beforeSeq?: number;
            aroundSeq?: number;
            around?: "unread";
        }) => Promise<ThreadMessagesResult>;
        /**
         * Read a page of a thread AND mark what it covered as read — the one rule for every agent.
         * `sinceSeq` omitted = from the first reply; `markRead: false` peeks. The read is sent as the
         * contiguous run `(sinceSeq ?? 0, last reply returned]`: the server advances only if the reader
         * already reaches `fromSeq` (`read.advanced`), so a page read from the middle of a thread you
         * have not read up to never marks the gap. An empty first page (no `sinceSeq`, or 0) marks the root alone.
         * `beforeSeq` pages BACKWARD (the newest page below it, ascending); `aroundSeq` (up to 20 replies
         * at/below it, then a page above it) and `around: "unread"` (centred on YOUR read position) place
         * the window. None of the three marks: a window placed elsewhere is not a run from your read
         * position, so a read of it is a peek — call `read` with `sinceSeq` (or none) to read-and-mark.
         */
        read: (threadId: string, p?: {
            sinceSeq?: number;
            beforeSeq?: number;
            aroundSeq?: number;
            around?: "unread";
            limit?: number;
            markRead?: boolean;
        }) => Promise<ThreadMessagesResult & ReadOutcome>;
        events: (threadId: string) => Promise<{
            events: unknown[];
        }>;
        /** ALWAYS the thread route (RFC-018 D8: "`parentId` is never sent") — never `channelId`. */
        reply: (threadId: string, body: SendBody) => Promise<SendResult>;
        markRead: (threadId: string, body?: {
            lastReadSeq?: number;
            fromSeq?: number;
        }) => Promise<MarkReadResult>;
        markAnswer: (threadId: string, messageId: string) => Promise<ThreadResult>;
        unmarkAnswer: (threadId: string) => Promise<ThreadResult>;
        /**
         * `create_item` — a ROOT that starts a thread, of any kind: `POST /api/messages` with the
         * work body. A work kind needs its required `fields` (422 `missing_fields` names them); a
         * near-identical bug is 409 `similar_exists {similar}` until `confirmNew: true`. The result
         * carries `threadId`, and for a work kind `item` + `similar` (the creator's to read).
         */
        create: (channelId: string, body: CreateItemBody) => Promise<CreateItemResult>;
        /**
         * `update_item` — `PUT /api/threads/:id/work`: kind, assignee, open-side status (+ `text`),
         * fields (merge patch), labels, due, title, review. All-or-nothing; per-field authority
         * (403 `not_allowed {field, who_may}`); `expectedStatus` CAS (409 `status_changed`). The
         * ONE edit route — rename and kind live here (the old `PUT /threads/:id` and `/kind` are gone).
         */
        work: (threadId: string, body: WorkEditBody) => Promise<WorkItemFrame>;
        /**
         * `resolve_item` — `POST /api/threads/:id/resolve`, every kind. A work item needs a `reason`
         * and a resolver (a person member the review policy allows), the requester's withdrawal
         * (`not_planned`), or a person owner's `withoutReview {reason}`. Never re-resolves: 409
         * `item_resolved` (reopen first). Send the header's `latestResult.id` as `resultEventId`.
         */
        resolve: (threadId: string, body: ResolveBody) => Promise<WorkItemFrame>;
        /** `reopen_item` — `POST /api/threads/:id/reopen`; 409 `not_resolved` on an open one. `regression` on a bug resolved `done`. */
        reopen: (threadId: string, body?: ReopenBody) => Promise<WorkItemFrame>;
        /** `triage_item` — `POST /api/threads/:id/triage` on an item in `triage` (409 `not_in_triage` otherwise). */
        triage: (threadId: string, body: TriageBody) => Promise<WorkItemFrame>;
        /**
         * `add_activity` — `POST /api/threads/:id/activity`: `plan {items}` · `progress {text}` ·
         * `needs_input {text, to?}` · `result {text, fix?, conclusion?, proposed?}` · `failed {text}`.
         * The assignee and its human managers only. Answers `{eventId, status}` beside the frame.
         */
        activity: (threadId: string, body: ActivityBody) => Promise<WorkItemFrame & {
            eventId: string;
            status: string;
        }>;
        links: {
            /** `add_link` — upsert by url (a re-add updates `relation` / `title`). `url` is http(s) only (422 otherwise). */
            add: (threadId: string, body: AddLinkBody) => Promise<{
                threadId: string;
                link: WorkLink;
                created: boolean;
            }>;
            /** `remove_link` — the link's adder, or who governs the item. */
            remove: (threadId: string, linkId: string) => Promise<{
                threadId: string;
                linkId: string;
                removed: true;
            }>;
        };
        /** A thread's sub-items, oldest first, with `n` and `open` counts. */
        children: (threadId: string) => Promise<WorkChildren>;
    };
    work: {
        /**
         * `list_items` — `GET /api/threads?scope=work`: work items across every channel the caller
         * reads, keyset-paged (`next` → `cursor`). Lists are comma-joined. `withoutReview` /
         * `resolvedIn` imply `status=resolved` when no status is named; `sort: "due"` lists only
         * dated items; `sort: "severity"` needs `kind: "bug"` (400 `sort_needs_kind`).
         */
        list: (p?: WorkListQuery) => Promise<WorkListResult>;
        /** `item_schema` — the work vocabulary (kinds, fields as JSON Schema, templates, statuses, reasons, link types, labels); `channel` adds its settings. Once per session. */
        schema: (p?: {
            channel?: string;
        }) => Promise<WorkSchema>;
    };
    agents: {
        list: () => Promise<{
            agents: AgentSummary[];
        }>;
        contexts: (agentId: string) => Promise<{
            contexts: ContextSummary[];
        }>;
        /** RFC-028 D8: the agent's live sessions — kind, scope, live or parked, and the threads each holds (the agent itself, and its managers). */
        sessions: (agentId: string) => Promise<{
            sessions: AgentSession[];
        }>;
        setContextLabel: (agentId: string, contextId: string, label: string) => Promise<{
            label?: string;
        }>;
    };
    presence: {
        list: () => Promise<PresenceList>;
    };
    sessions: {
        /**
         * RFC-028 D6: this session's scope — the channels whose UNHELD work a work session takes. Narrows
         * unheld work only; a held thread reaches its holder whatever the scope. Stored on the grant and
         * patched onto the live socket; a reconnect does not re-send the starting scope, so this sticks.
         */
        setScope: (scope: Scope) => Promise<{
            scope: {
                mode: Scope["mode"];
                channelIds: string[];
            };
        }>;
    };
    /** RFC-027 D5: what THIS session's model still owes — its own entries and its agent's unowned, not yet seen. */
    deliveries: {
        /** One page, oldest first. `limit` is the server's to bound (default 50, max 200); `after` is a previous page's `next`. */
        list: (opts?: {
            limit?: number;
            after?: string;
        }) => Promise<DeliveriesResponse>;
    };
};
