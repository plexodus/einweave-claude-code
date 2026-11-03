/**
 * `isTurnTrigger(msg, self)` — RFC-018 D8: which inbound messages start an
 * agent's turn, driven by the SERVER's own `deliveryReasons` so every runtime
 * behaves the same (never a client-side channel/keyword filter the old
 * `openclaw-bridge-plugin` used and drifted on).
 *
 * D8 names five triggers: mentioned; SUBSCRIBED to the channel (the server-side
 * RFC-011 relation, never a list in a runtime's own config); participating in
 * the thread; assigned the task; the target. Traced to `packages/api/src/routing.ts`
 * `findInterestedAgents`, those five are exactly:
 *   - every ADDRESSED reason (`target`, `assignee`, `mention`, `thread`, and any the server adds
 *     later) — read as `Inbound.addressed`, the server's own verdict (RFC-035 §5);
 *   - `"channel"` — `BROADCAST_REASONS`' one entry that means a STANDING subscription
 *     (`agent_interests` `interestType: "channel"`, RFC-011's managed relation), as
 *     opposed to `"member"` (a human's channel membership, never an agent trigger),
 *     `"type"`/`"tag"` (topic-based broadcast, D8 does not list these as turn triggers).
 *
 * DMs are listed in D8 as a future trigger ("once Bridge has DMs") — there is no
 * `deliveryReasons` entry for one yet, so nothing to add here until the server ships it.
 *
 * Echo suppression (D8: "the agent's own messages never start a turn") — an own-sent id
 * (tracked by `Session.self()`) or a message whose `senderContextId` is this session's own
 * — is checked FIRST and unconditionally: an id this session sent can never trigger a turn,
 * even if it comes back carrying an addressed reason (a self-mention, a reply to its own
 * question).
 */
import type { Inbound } from "./delivery";
export interface TurnSelf {
    /** This session's own context id — a message whose `senderContextId` equals this is an echo. */
    contextId?: string | null;
    /** Ids this session itself has sent (`Session.self().ownMessageIds`) — an echo even when
     * it comes back re-targeted at this session by id, not just by `senderContextId`. */
    ownMessageIds?: ReadonlySet<string>;
}
export declare function isTurnTrigger(msg: Inbound, self: TurnSelf): boolean;
