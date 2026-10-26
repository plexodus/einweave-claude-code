/** The server picked THIS agent specifically — never suppressible by a client. */
export declare const ADDRESSED_REASONS: readonly ["target", "assignee", "mention", "thread"];
/** A standing subscription matched — a client MAY narrow this tier. */
export declare const BROADCAST_REASONS: readonly ["channel", "member", "type", "tag"];
export type DeliveryReason = (typeof ADDRESSED_REASONS)[number] | (typeof BROADCAST_REASONS)[number];
/** True if the server picked this recipient specifically. */
export declare const isAddressed: (reasons: Iterable<string> | undefined) => boolean;
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
/** Never sequenced, never buffered, never replayed. */
export declare const CONTROL_FRAME_TYPES: readonly ["authenticated", "reauthenticated", "error", "auth_required", "ping", "pong", "invalid_session", "drain"];
/**
 * What a connection declares it is. REQUIRED on the auth frame — the server never infers
 * one, and a frame without it is refused 4008 "client too old". `gateway`: the agent's one
 * triage connection (unheld work goes to it); `session`: a work session (its held threads,
 * plus unheld work in its scope while no gateway is live); `observer`: read-only copies.
 */
export declare const CONNECTION_KINDS: readonly ["gateway", "session", "observer"];
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];
/**
 * RFC-027 D4. `model` ONLY on evidence the model received the entry (a host receipt,
 * or a read tool that returned it) — never on transport. `dismissed`: the client decided
 * not to surface it; it never lights ✓✓.
 */
export type AckHow = AckFrame["how"];
/** The server's cap on ids in one ack frame; more are sent in chunks. */
export declare const MAX_ACK_IDS = 500;
/** The three accountable kinds (L1) — what a session's model owes (D3). */
export declare const ENTRY_KINDS: readonly ["message", "action_request", "thread_event"];
export type EntryKind = (typeof ENTRY_KINDS)[number];
/**
 * The numeric WS close codes the server sends, named so nothing above this layer
 * hard-codes a magic number. `policy` (4008) carries every REASON
 * `./reconnect-policy.ts`'s `classifyClose` distinguishes — the code alone never
 * tells them apart; the reason (or its PREFIX) does.
 */
export declare const WS_CLOSE_CODES: {
    readonly authTimeout: 4006;
    readonly invalidToken: 4001;
    readonly deregisteredOrArchived: 4003;
    readonly tooManySessions: 4007;
    readonly policy: 4008;
    readonly tokenExpired: 4009;
    readonly grantCheckFailed: 1011;
    readonly membershipRevoked: 4004;
    readonly tenantSwitched: 4005;
    readonly goingAway: 1001;
    readonly policyViolation: 1008;
};
/** Every close reason the server sends — the whole text, or the PREFIX before `: <detail>`. */
export declare const WS_CLOSE_REASONS: {
    readonly tooManySessions: "Too many sessions";
    readonly invalidToken: "Invalid token";
    readonly authTimeout: "Authentication timeout";
    readonly tokenExpired: "token expired";
    readonly grantCheckFailed: "grant check failed";
    readonly sessionEvicted: "session evicted";
    readonly deregistered: "deregistered";
    readonly workspaceArchived: "workspace archived";
    readonly heartbeatMissed: "heartbeat missed";
    readonly sessionInUse: "session already connected";
    readonly gatewayTakenOver: "gateway taken over";
    readonly gatewayInUse: "gateway in use";
    readonly kindNotAllowed: "kind not allowed";
    readonly invalidScope: "invalid scope";
    readonly invalidReplaces: "invalid replaces";
    readonly invalidAuth: "invalid auth";
    readonly conversationReplaced: "conversation replaced";
    readonly sessionStopped: "session stopped";
    readonly sessionRevoked: "session revoked";
    readonly installationRevoked: "installation revoked";
    readonly installationLocked: "installation locked";
    readonly sessionSuperseded: "session superseded";
    readonly clientTooOld: "client too old";
    readonly clientBlocked: "client version withdrawn";
    readonly protocolUnsupported: "protocol unsupported";
    readonly membershipRevoked: "membership revoked";
    readonly tenantSwitched: "tenant switched";
    readonly serverShuttingDown: "server shutting down";
    readonly slowConsumer: "slow consumer";
};
declare const WIRE: {
    sessionInfo: {
        clientVersion?: string | undefined;
        clientName?: string | undefined;
        hostName?: string | undefined;
        repoName?: string | undefined;
        worktreeName?: string | undefined;
        branchName?: string | undefined;
        headShortSha?: string | undefined;
        sessionLabel?: string | undefined;
        sessionKey?: string | undefined;
        softwareId?: string | undefined;
    };
    scope: {
        channelIds?: string[] | undefined;
        mode: "all" | "channels" | "none";
    };
    replaces: {
        carry?: "all" | string[] | undefined;
        reason: "clear";
        sessionKey: string;
    };
    released: {
        title: string | null;
        channelId: string;
        threadId: string;
        channelName: string;
    };
    auth: {
        interactive?: unknown;
        scope?: {
            channelIds?: string[] | undefined;
            mode: "all" | "channels" | "none";
        } | undefined;
        takeover?: "gateway" | undefined;
        replaces?: {
            carry?: "all" | string[] | undefined;
            reason: "clear";
            sessionKey: string;
        } | undefined;
        sessionInfo?: {
            clientVersion?: string | undefined;
            clientName?: string | undefined;
            hostName?: string | undefined;
            repoName?: string | undefined;
            worktreeName?: string | undefined;
            branchName?: string | undefined;
            headShortSha?: string | undefined;
            sessionLabel?: string | undefined;
            sessionKey?: string | undefined;
            softwareId?: string | undefined;
        } | undefined;
        dpop?: unknown;
        supersede?: boolean | undefined;
        type: "auth";
        kind: "gateway" | "session" | "observer";
        v: 2;
        token: string;
        lastSeq: number;
    };
    reauth: {
        dpop?: unknown;
        type: "reauth";
        token: string;
    };
    ack: {
        type: "ack";
        ids: string[];
        how: "model" | "dismissed";
    };
    pong: {
        type: "pong";
        lastSeq: number;
    };
    authenticated: {
        client?: {
            pending_minimum?: string | undefined;
            minimum_from?: string | undefined;
            minimum: string;
            recommended: string;
            advice: string;
        } | undefined;
        carried?: string[] | undefined;
        released?: {
            title: string | null;
            channelId: string;
            threadId: string;
            channelName: string;
        }[] | undefined;
        notCarried?: string[] | undefined;
        handle: string | null;
        kind: "gateway" | "session" | "observer";
        agentId: string;
        agentName: string;
        contextId: string;
        scope: {
            mode: "all" | "channels" | "none";
            channelIds: string[];
        };
        holds: string[];
        protocol: number;
        capabilities: string[];
        heartbeatMs: number;
        replayBudget: {
            broadcasts: number;
            chars: number;
        };
    };
    hold_update: {
        agentId: string;
        threadId: string;
        holder: {
            online: boolean;
            label: string | null;
            parked: boolean;
            id: string;
        } | null;
        via: "start" | "reply" | "take" | "handover" | "release" | "settled" | "access_lost" | "grant_end" | "unassigned" | "replaced" | "carry";
        by: {
            principalId: string;
            sessionId: string | null;
        };
    };
    for_you: {
        id: string;
        title: string | null;
        channelId: string | null;
        threadId: string | null;
        entry: "message" | "action_request" | "thread_event";
        why: string;
    };
    error: {
        message: string;
    };
    wireMessage: {
        type?: string | undefined;
        agentId?: string | null | undefined;
        userId?: string | null | undefined;
        agentName?: string | null | undefined;
        senderType?: "agent" | "human" | undefined;
        senderName?: string | undefined;
        senderHandle?: string | null | undefined;
        metadata?: string | null | undefined;
        isRoot?: boolean | undefined;
        seq?: number | undefined;
        senderProvenance?: string | undefined;
        senderContextLabel?: string | null | undefined;
        mentions?: {
            kind: "agent" | "human" | null;
            principalId: string;
            handleAtSend: string | null;
            currentHandle: string | null;
            displayName: string | null;
        }[] | undefined;
        id: string;
        channelId: string;
        content: string;
        threadId: string | null;
        createdAt: string;
        senderContextId: string | null;
    };
    message: {
        redelivery?: boolean | undefined;
        message: {
            type?: string | undefined;
            agentId?: string | null | undefined;
            userId?: string | null | undefined;
            agentName?: string | null | undefined;
            senderType?: "agent" | "human" | undefined;
            senderName?: string | undefined;
            senderHandle?: string | null | undefined;
            metadata?: string | null | undefined;
            isRoot?: boolean | undefined;
            seq?: number | undefined;
            senderProvenance?: string | undefined;
            senderContextLabel?: string | null | undefined;
            mentions?: {
                kind: "agent" | "human" | null;
                principalId: string;
                handleAtSend: string | null;
                currentHandle: string | null;
                displayName: string | null;
            }[] | undefined;
            id: string;
            channelId: string;
            content: string;
            threadId: string | null;
            createdAt: string;
            senderContextId: string | null;
        };
        deliveryReasons: ("target" | "assignee" | "mention" | "thread" | "channel" | "member" | "type" | "tag")[];
    };
    thread_event: {
        work: {
            text: string;
        } | null;
        id: string;
        status: string | null;
        channelId: string;
        threadId: string;
        redelivery?: boolean | undefined;
        action: string;
        detail: {
            [x: string]: unknown;
        } | null;
        actorId: string | null;
        occurredAt: string;
        names: {
            [x: string]: string;
        };
    };
    actor: {
        actorType: "agent" | "human" | "system" | "external";
    };
    action_request: {
        redelivery?: boolean | undefined;
        params: unknown;
        id: string;
        action: string;
    };
    catchup: {
        channels: {
            channelId: string;
            count: number;
        }[];
    };
    invalid_session: {
        resumable: false;
        lost: {
            frames: number;
            from: number | null;
        };
    };
    drain: {
        in_ms?: number | undefined;
    };
    receipt: {
        firstSeen?: boolean | undefined;
        at: string;
        state: "sent" | "seen";
        agentId: string;
        contextId: string;
        messageId: string;
        contextLabel: string | null;
    };
};
type _SessionInfo = typeof WIRE.sessionInfo;
/**
 * What a client tells the server about itself on the auth frame — `clientName` etc. name the
 * TERMINAL, not the software; `softwareId`/`clientVersion` name the BUILD (RFC-017 D5).
 */
export interface SessionInfo extends _SessionInfo {
}
type _Scope = typeof WIRE.scope;
/** Which channels' UNHELD work a work session takes (RFC-028 D6). `channelIds` only with `mode: "channels"`. */
export interface Scope extends _Scope {
}
type _Replaces = typeof WIRE.replaces;
/**
 * RFC-028 §11: a NEW session's declaration that it replaces a conversation of the same window (a
 * `/clear`). The server hands the replaced session's threads over: `carry` ones (`"all"`, or a list of
 * at most 64) to this session, the rest released. First connect only.
 */
export interface ReplacesDeclaration extends _Replaces {
}
type _ReleasedThread = typeof WIRE.released;
/** A thread a replaced conversation held and the server released (`AuthenticatedPayload.released`). */
export interface ReleasedThread extends _ReleasedThread {
}
type _AuthFrame = typeof WIRE.auth;
/**
 * The first frame on a socket. `kind` is required (RFC-028 D1); `scope` omitted = keep the grant's
 * stored scope; `takeover: "gateway"` moves the agent's gateway lease from a LIVE gateway (never
 * implied by `supersede`, which is this grant from another window); `interactive: true` = a person is
 * at this connection (RFC-029 D13, re-declared on every auth); `lastSeq` = the last seq this client
 * durably stored for THIS grant, 0 = a fresh start (RFC-027 D5).
 */
export interface AuthFrame extends _AuthFrame {
}
type _ReauthFrame = typeof WIRE.reauth;
export interface ReauthFrame extends _ReauthFrame {
}
type _AckFrame = typeof WIRE.ack;
export interface AckFrame extends _AckFrame {
}
type _PongFrame = typeof WIRE.pong;
/** Answers a server `ping`. `lastSeq` (what the client has STORED) trims the server's buffer; it never marks anything seen. */
export interface PongFrame extends _PongFrame {
}
type _AuthenticatedPayload = typeof WIRE.authenticated;
/**
 * The server accepted the auth. `contextId` is this session's GRANT id (the address other sessions
 * target, the id on its sends); `kind`/`scope`/`holds` what it holds now (RFC-028); `carried` /
 * `released` / `notCarried` only when the auth declared `replaces`; `client` only when a newer build
 * is available and this session is the holder (RFC-017 D7).
 */
export interface AuthenticatedPayload extends _AuthenticatedPayload {
}
type _HoldUpdatePayload = typeof WIRE.hold_update;
/**
 * RFC-028 D8: a thread's hold changed hands. `holder` is the new holder, `null` when released.
 * Sent to the session it left and the one it reached (and to the agent's managers' web sockets);
 * a non-turn status — it asks the model for nothing.
 */
export interface HoldUpdatePayload extends _HoldUpdatePayload {
}
type _ForYouPayload = typeof WIRE.for_you;
/**
 * Addressed work this session was NOT pushed: it reached none of the agent's sockets (no holder online, no
 * live gateway, every work session's scope refused it). A non-turn status -- the entry stays owed
 * (`read_deliveries`, the takeable list's "for you"). `why`: the addressed reason of a message, the action of
 * a `thread_event`, the name of an `action_request`.
 */
export interface ForYouPayload extends _ForYouPayload {
}
type _ErrorPayload = typeof WIRE.error;
export interface ErrorPayload extends _ErrorPayload {
}
type _WireMessage = typeof WIRE.wireMessage;
/**
 * One message, identical for every recipient. The reason it reached THIS session travels beside
 * it, never inside it. `senderContextId`: the sending session's grant id, or null for a person / a
 * session-less send.
 */
export interface WireMessage extends _WireMessage {
}
type _MessagePayload = typeof WIRE.message;
/** `redelivery: true` when a frame of this entry was sent before (a resume, or a reconcile). */
export interface MessagePayload extends _MessagePayload {
}
type _ThreadEventPayload = typeof WIRE.thread_event;
/**
 * RFC-029 §6: a work item changed, as it happened (one `thread_events` row) — sent to the agents
 * it concerns (assignee, previous assignee, requester, followers, a `needs_input` recipient),
 * never to its actor.
 *
 * `action` is an open set (`assigned` · `status` · `progress` · `needs_input` · `stuck` · …);
 * `detail` the event's own, per action. `status` is the item's status NOW (at send time — a resume
 * shows today's), `work.text` its header rendered by the server (G11: the SDK renders nothing).
 * Both null when the thread is no longer a work item. `names`: principal id → how to name it; print
 * these, never the raw id (an id absent here is printed as is).
 */
export interface ThreadEventPayload extends _ThreadEventPayload {
    /** Null `actorId` = the server itself. Open: a value a later server adds is not an error. */
    actorType: (typeof WIRE.actor)["actorType"] | (string & {});
}
type _ActionRequestPayload = typeof WIRE.action_request;
export interface ActionRequestPayload extends _ActionRequestPayload {
}
type _CatchupPayload = typeof WIRE.catchup;
/** Broadcasts over the resume budget arrive as counts per channel, never bodies (D5). */
export interface CatchupPayload extends _CatchupPayload {
}
type _InvalidSessionPayload = typeof WIRE.invalid_session;
/** The resume could not be honoured; the socket stays open as a FRESH session (D5). */
export interface InvalidSessionPayload extends _InvalidSessionPayload {
}
type _DrainPayload = typeof WIRE.drain;
/** The server is about to go away: resume on a new socket (D6). */
export interface DrainPayload extends _DrainPayload {
}
type _ReceiptPayload = typeof WIRE.receipt;
/** A message's receipt — for the channels this agent receives, and always for its own sends. */
export interface ReceiptPayload extends _ReceiptPayload {
}
/** The server frames this SDK acts on, discriminated on `type` (any other type is ignored). */
export type AgentFrame = (Envelope<AuthenticatedPayload> & {
    type: "authenticated";
}) | (Envelope<Record<string, never>> & {
    type: "ping";
}) | (Envelope<MessagePayload> & {
    type: "message";
}) | (Envelope<ThreadEventPayload> & {
    type: "thread_event";
}) | (Envelope<ActionRequestPayload> & {
    type: "action_request";
}) | (Envelope<CatchupPayload> & {
    type: "catchup";
}) | (Envelope<InvalidSessionPayload> & {
    type: "invalid_session";
}) | (Envelope<DrainPayload> & {
    type: "drain";
}) | (Envelope<HoldUpdatePayload> & {
    type: "hold_update";
}) | (Envelope<ForYouPayload> & {
    type: "for_you";
}) | (Envelope<ReceiptPayload> & {
    type: "receipt";
}) | (Envelope<ErrorPayload> & {
    type: "error";
});
/**
 * `GET /api/deliveries` — the same payloads the frames carry, one keyset page of them. Hand-typed
 * until the HTTP shapes move onto the protocol (its entries carry `id`, not the protocol's `entryId`).
 */
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
export {};
