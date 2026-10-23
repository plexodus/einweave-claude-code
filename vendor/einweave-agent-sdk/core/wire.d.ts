/**
 * The WS wire shapes, kept in one place so `Session` (S1.3) and every consumer
 * read them from a single definition rather than re-guessing the frame layout at
 * each call site — the exact failure mode RFC-018 §1 calls out in the dead
 * `openclaw-bridge-plugin` ("drifted in six places").
 *
 * Transcribed from the server's real shapes (protocol v2, RFC-027): `packages/api/src/ws.ts`
 * (`SessionInfo`, the `auth`/`reauth`/`ack`/`pong` inputs, `authenticated`, `message`,
 * `thread_event`, `action_request`, `catchup`, `invalid_session`), `ws-frame.ts` (the envelope)
 * and `routing.ts` (`DeliveryReason`, `ADDRESSED_REASONS`/`BROADCAST_REASONS`, `isAddressed`).
 * `fixtures/frames/*.json` are captured from a live server, so a change to either side
 * without the other shows up there.
 */
/** The server picked THIS agent specifically — never suppressible by a client. */
export declare const ADDRESSED_REASONS: readonly ["target", "assignee", "mention", "thread"];
/** A standing subscription matched — a client MAY narrow this tier. */
export declare const BROADCAST_REASONS: readonly ["channel", "member", "type", "tag"];
export type DeliveryReason = (typeof ADDRESSED_REASONS)[number] | (typeof BROADCAST_REASONS)[number];
/** True if the server picked this recipient specifically (mirrors routing.ts). */
export declare function isAddressed(reasons: Iterable<DeliveryReason> | undefined): boolean;
/** The protocol this SDK speaks. A server that wants another closes 4008 "client too old". */
export declare const PROTOCOL_VERSION: 2;
/**
 * Every server frame: `{v:2, type, seq?, ts, payload}` — additive-only from here on.
 * `seq` is on every frame the server BUFFERS for this session (its resume buffer, L2);
 * the control frames below never carry one.
 */
export interface Envelope<T = unknown> {
    v: typeof PROTOCOL_VERSION;
    type: string;
    seq?: number;
    /** Server clock, epoch ms. */
    ts: number;
    payload: T;
}
/** Never sequenced, never buffered, never replayed (packages/api/src/ws-frame.ts). */
export declare const CONTROL_FRAME_TYPES: readonly ["authenticated", "reauthenticated", "error", "auth_required", "ping", "pong", "invalid_session", "drain"];
/**
 * What a client tells the server about itself on the auth frame (`ws.ts`'s
 * `SessionInfo`, the fields a Bridge caller controls — `clientName` etc. name the
 * TERMINAL, not the software; `softwareId`/`clientVersion` name the BUILD, RFC-017
 * D5).
 */
export interface SessionInfo {
    clientName?: string;
    hostName?: string;
    repoName?: string;
    worktreeName?: string;
    branchName?: string;
    headShortSha?: string;
    sessionLabel?: string;
    sessionKey?: string;
    clientVersion?: string;
    softwareId?: string;
}
/**
 * What a connection declares it is. REQUIRED on the auth frame — the server never infers
 * one, and a frame without it is refused 4008 "client too old". `gateway`: the agent's one
 * triage connection (unheld work goes to it); `session`: a work session (its held threads,
 * plus unheld work in its scope while no gateway is live); `observer`: read-only copies.
 */
export declare const CONNECTION_KINDS: readonly ["gateway", "session", "observer"];
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];
/** Which channels' UNHELD work a work session takes (D6). `channelIds` only with `mode: "channels"`. */
export interface Scope {
    mode: "all" | "channels" | "none";
    channelIds?: string[];
}
/**
 * RFC-028 §11: a NEW session's declaration that it replaces a conversation of the same window (a
 * `/clear`). The server hands the replaced session's threads over: `carry` ones to this session, the
 * rest released. First connect only.
 */
export interface ReplacesDeclaration {
    /** The session key of the conversation being replaced. */
    sessionKey: string;
    reason: "clear";
    /** Thread ids to hand to this session (at most 64); every other hold of the replaced session is released. */
    carry?: string[];
}
/** A thread a replaced conversation held and the server released (`AuthenticatedPayload.released`). */
export interface ReleasedThread {
    threadId: string;
    title: string | null;
    channelId: string;
    channelName: string;
}
export interface AuthFrame {
    type: "auth";
    v: typeof PROTOCOL_VERSION;
    token: string;
    /** RFC-028 D1: what this connection is. Required. */
    kind: ConnectionKind;
    /** RFC-028 D6: the starting scope of a work session; omitted = keep the grant's stored scope. */
    scope?: Scope;
    /**
     * RFC-028 D2: move the agent's gateway lease from a LIVE gateway to this connection (the old one is
     * closed "gateway taken over"). Its own intent — never implied by `supersede`, which is this grant
     * from another window and never moves a lease.
     */
    takeover?: "gateway";
    /** RFC-028 §11: this session replaces a conversation (a `/clear`). First connect only. */
    replaces?: ReplacesDeclaration;
    sessionInfo?: SessionInfo;
    /** The DPoP proof for this frame's implicit `GET /ws` (E11). */
    dpop?: unknown;
    /** RFC-017 D3: take over this session grant from a socket that already holds it. */
    supersede?: boolean;
    /**
     * RFC-029 D13: a person is at this connection (their window), so a work item it holds is never
     * flagged quiet or stuck. Re-declared on EVERY auth; absent (or anything but `true`) = false.
     */
    interactive?: boolean;
    /** The last seq this client has durably stored for THIS grant; 0 = a fresh start (RFC-027 D5). */
    lastSeq: number;
}
export interface ReauthFrame {
    type: "reauth";
    token: string;
    dpop?: unknown;
}
/**
 * RFC-027 D4. `model` ONLY on evidence the model received the entry (a host receipt,
 * or a read tool that returned it) — never on transport. `dismissed`: the client decided
 * not to surface it; it never lights ✓✓.
 */
export type AckHow = "model" | "dismissed";
export interface AckFrame {
    type: "ack";
    ids: string[];
    how: AckHow;
}
/** The server's cap on ids in one ack frame (ws.ts `MAX_ACK_IDS`); more are sent in chunks. */
export declare const MAX_ACK_IDS = 500;
/** Answers a server `ping`. `lastSeq` (what the client has STORED) trims the server's buffer; it never marks anything seen. */
export interface PongFrame {
    type: "pong";
    lastSeq: number;
}
export interface AuthenticatedPayload {
    agentId: string;
    agentName: string;
    /** This agent's current @handle in its own tenant, or null if it holds none. */
    handle: string | null;
    /** This session's GRANT id — the address other sessions target, and the id on its sends. */
    contextId: string;
    protocol: number;
    heartbeatMs: number;
    replayBudget: {
        broadcasts: number;
        chars: number;
    };
    /** RFC-028: what this connection declared (stored on its grant). */
    kind?: ConnectionKind;
    /** RFC-028 D6: this session's scope (`channelIds` empty unless `mode: "channels"`). */
    scope?: {
        mode: "all" | "channels" | "none";
        channelIds: string[];
    };
    /** RFC-028 D3: the ids of the threads this session holds. */
    holds?: string[];
    /** RFC-028 §11 (present when the auth declared `replaces`): the threads handed to this session… */
    carried?: string[];
    /** …the threads released (this session does not hold them; replies go to the agent's sessions in scope)… */
    released?: ReleasedThread[];
    /** …and the `carry` ids that were not carried (not held by the replaced session, or nothing was replaced). */
    notCarried?: string[];
    /** RFC-017 D7: present only when a newer build is available and this session is the holder. */
    client?: unknown;
}
/**
 * RFC-028 D8: a thread's hold changed hands. `holder` is the new holder, `null` when released.
 * Sent to the session it left and the one it reached (and to the agent's managers' web sockets);
 * a non-turn status — it asks the model for nothing.
 */
export interface HoldUpdatePayload {
    threadId: string;
    agentId: string;
    holder: {
        id: string;
        label: string | null;
        online: boolean;
        parked: boolean;
    } | null;
    via: "start" | "reply" | "take" | "handover" | "release" | "settled" | "access_lost" | "grant_end" | "unassigned" | "replaced" | "carry";
    by: {
        principalId: string;
        sessionId: string | null;
    };
}
export interface ErrorPayload {
    message: string;
}
/**
 * One message, identical for every recipient (`broadcastMessage`'s `messageData`).
 * The reason it reached THIS session travels beside it, never inside it.
 */
export interface WireMessage {
    id: string;
    channelId: string;
    agentId?: string | null;
    userId?: string | null;
    agentName?: string | null;
    senderType?: "agent" | "human";
    senderName?: string;
    /** The sender's @handle in the workspace. */
    senderHandle?: string | null;
    content: string;
    type?: string;
    metadata?: string | null;
    threadId: string | null;
    isRoot?: boolean;
    seq?: number;
    createdAt: string;
    /** The sending session's grant id, or null for a person / a session-less send. */
    senderContextId: string | null;
    senderProvenance?: string;
    senderContextLabel?: string | null;
}
/** `redelivery: true` when a frame of this entry was sent before (a resume, or a reconcile). */
export interface MessagePayload {
    message: WireMessage;
    deliveryReasons: DeliveryReason[];
    redelivery?: boolean;
}
/**
 * RFC-029 §6: a work item changed, as it happened (one `thread_events` row) — sent to the agents
 * it concerns (assignee, previous assignee, requester, followers, a `needs_input` recipient),
 * never to its actor. Server source: `packages/api/src/work/header.ts` `threadEventPayload`.
 *
 * `status` is the item's status NOW (at send time — a resume shows today's), `work.text` the
 * item's header rendered by the server (G11: the SDK stays zero-dep and renders nothing; a
 * plugin prints this text). Both null when the thread is no longer a work item.
 */
export interface ThreadEventPayload {
    id: string;
    threadId: string;
    channelId: string;
    /**
     * `assigned` · `unassigned` · `status` · `plan` · `progress` · `needs_input` · `input_answered` ·
     * `result` · `failed` · `resolve` · `reopen` · `fields` · `stuck` · `parent_resolved` ·
     * `child_resolved` · … — an open set (`@einweave/threads` `THREAD_EVENT_ACTIONS`).
     */
    action: string;
    /**
     * The event's own detail, per action. E.g. `stuck`: `{holder: <agent id>, session: <grant id>,
     * since: <the holder's last heartbeat ISO | null>}`; `assigned`: `{from, to, …}`.
     */
    detail: Record<string, unknown> | null;
    /** Null for the server itself (a sweep, a departure). */
    actorId: string | null;
    actorType: "agent" | "human" | "system" | (string & {});
    occurredAt: string;
    status: string | null;
    work: {
        text: string;
    } | null;
    /**
     * Principal id → how to name it (`@handle` in this workspace, else the name, else
     * "a removed agent" / "a removed person"): `actorId` and the principals in `detail` of the
     * events an agent is sent — `assigned` / `unassigned` `from`/`to`, `needs_input.to[]`,
     * `input_answered.by`, `reopen.assignee`, `stuck.holder`. Print these, never the raw id.
     * The same for every recipient (reader-independent); an id absent here is printed as is.
     */
    names: Record<string, string>;
    redelivery?: boolean;
}
export interface ActionRequestPayload {
    id: string;
    action: string;
    params: unknown;
    redelivery?: boolean;
}
/** Broadcasts over the resume budget arrive as counts per channel, never bodies (D5). */
export interface CatchupPayload {
    channels: {
        channelId: string;
        count: number;
    }[];
}
/** The resume could not be honoured; the socket stays open as a FRESH session (D5). */
export interface InvalidSessionPayload {
    resumable: false;
    lost: {
        frames: number;
        from: number | null;
    };
}
/** The server is about to go away: resume on a new socket (D6). */
export interface DrainPayload {
    in_ms?: number;
}
/** The three accountable kinds (L1) — what a session's model owes (D3). */
export type EntryKind = "message" | "thread_event" | "action_request";
/** `GET /api/deliveries` — the same payloads the frames carry, one keyset page of them. */
export interface DeliveriesResponse {
    entries: {
        kind: EntryKind;
        id: string;
        reasons: string[];
        payload: Record<string, unknown>;
    }[];
    /** Opaque cursor for the next page (`?after=`); null on the last one. Absent from a pre-paging server = null. */
    next?: string | null;
}
/**
 * The numeric WS close codes the server sends, named so nothing above this layer
 * hard-codes a magic number. `policy` (4008) carries every REASON
 * `./reconnect-policy.ts`'s `classifyClose` distinguishes (revoked / superseded /
 * too-old / evicted) — the code alone never tells them apart; the reason PREFIX
 * does.
 */
export declare const WS_CLOSE_CODES: {
    readonly authTimeout: 4006;
    readonly invalidToken: 4001;
    readonly deregisteredOrArchived: 4003;
    readonly tooManySessions: 4007;
    readonly policy: 4008;
    readonly tokenExpired: 4009;
    readonly grantCheckFailed: 1011;
};
