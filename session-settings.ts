/**
 * RFC-028 D6: a session's settings belong to the server. The label is stored on the grant
 * (server #327, like scope): an auth frame that carries `sessionLabel` replaces it, one that
 * omits it keeps it, and `authenticated.label` reports it. So a client sends the label only
 * as a CHANGE and adopts what the server stored on every auth -- a window taking a session
 * back no longer undoes a rename made in another.
 *
 * Pure: server.ts reads `forFrame()` as each auth frame is built and calls `adopt()` on each
 * `authenticated`. A change counts as delivered only once a frame CARRIED it and the server
 * answered that frame; a change made while a frame was in flight rides the next one.
 *
 * An older server sends no `label` (adopt(undefined)) and stores nothing: the label then
 * rides every frame, as it did before.
 */
export type LabelSetting = ReturnType<typeof createLabelSetting>;

/** `initial` is a change made at launch (EINWEAVE_SESSION_LABEL): it rides the first frame. */
export function createLabelSetting(initial = "") {
  /** The server's copy; "" = derived. */
  let stored = "";
  /** A change made here the server has not answered yet. */
  let pending: string | undefined = initial || undefined;
  /** What the last frame carried. */
  let sent: string | undefined;
  /** The last `authenticated` reported a label: the server stores it. */
  let serverStores = false;

  return {
    /** The raw label this session goes by ("" = the server derives one). */
    current: (): string => pending ?? stored,

    /** What the next auth frame's `sessionInfo.sessionLabel` carries; undefined = keep the stored one. */
    forFrame(): string | undefined {
      sent = pending;
      if (pending !== undefined) return pending;
      return serverStores ? undefined : stored || undefined;
    },

    /** An `authenticated` answered: `label` is the server's copy (null = derived, undefined = an older server). */
    adopt(label: string | null | undefined): void {
      serverStores = label !== undefined;
      const delivered = pending !== undefined && pending === sent;
      if (serverStores) stored = label ?? "";
      else if (delivered) stored = pending!;
      if (delivered) pending = undefined;
      sent = undefined;
    },

    /** A change made here while no rename can reach the server (not authenticated). "" is ignored: a frame cannot clear. */
    change(label: string): void {
      if (label) pending = label;
    },

    /** The label route stored `label` ("" = cleared): it is the server's copy now. */
    applied(label: string): void {
      stored = label;
      pending = undefined;
      sent = undefined;
    },
  };
}
