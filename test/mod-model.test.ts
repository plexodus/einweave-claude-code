/**
 * The einweave mod's rules (mod/model.ts): relay lines, the indicator's states, the band's grace
 * period and the `/einweave` verbs. The wiring to `$` is covered by the kit tests under mod/.
 */
import { describe, test, expect } from "bun:test";
import { applySnapshot, BAND_GRACE_MS, EMPTY_VIEW, fromTool, indicator, needsBand, parseCommand, parseLine, scopeText, statusSummary } from "../mod/model";
import type { UiSnapshot, View } from "../types";

const SNAP: UiSnapshot = {
  v: 1,
  connection: { state: "connected", detail: null },
  session: { agent: "bellman", label: "probe", kind: "session", scope: { mode: "none", channelIds: [] } },
  holds: [{ threadId: "t1", title: "Fix the build" }],
  waiting: { forYou: 2, channel: 14, more: false, top: [] },
  version: "0.38.0",
  staleSince: null,
};
const down = (detail = "disconnected (reconnect attempt 1, in 2s)"): UiSnapshot => ({ ...SNAP, connection: { state: "disconnected", detail }, holds: [], waiting: null });
const seen = (snap: UiSnapshot, rev = 1, now = 0, from: View = EMPTY_VIEW): View => applySnapshot(from, rev, snap, now);

describe("parseLine", () => {
  test("a snapshot line", () => {
    expect(parseLine(JSON.stringify({ ok: true, op: "watch", rev: 3, state: SNAP }))).toEqual({ rev: 3, snap: SNAP });
  });
  test("a refusal carries its reason", () => {
    expect(parseLine(JSON.stringify({ ok: false, error: "no control socket" }))).toEqual({ error: "no control socket" });
  });
  test("noise, half lines and other shapes are dropped", () => {
    expect(parseLine("{\"ok\":tr")).toBeNull();
    expect(parseLine("42")).toBeNull();
    // A future snapshot version is not read as v1, whatever else it carries.
    expect(parseLine(JSON.stringify({ ok: true, rev: 1, state: { ...SNAP, v: 2 } }))).toBeNull();
  });
});

test("fromTool reads ui_state's structuredContent, or the JSON text where the host drops it (Claude Code does)", () => {
  const text = (t: string) => [{ type: "text", text: t }];
  expect(fromTool({ structuredContent: { rev: 7, ...SNAP } })).toEqual({ rev: 7, snap: SNAP });
  expect(fromTool({ content: text(JSON.stringify({ rev: 8, ...SNAP })) })).toEqual({ rev: 8, snap: SNAP });
  expect(fromTool({ structuredContent: { ...SNAP } })).toBeNull();
  expect(fromTool({ content: text("not json") })).toBeNull();
  expect(fromTool({ content: text(JSON.stringify({ ...SNAP })) })).toBeNull();
  expect(fromTool({})).toBeNull();
});

describe("applySnapshot", () => {
  test("an older rev does not overwrite a newer one (a poll answered after a push)", () => {
    const v = seen(SNAP, 5);
    expect(applySnapshot(v, 4, down(), 0)).toBe(v);
  });
  test("a restarted plugin starts again at rev 1, and that is taken", () => {
    const v = seen(SNAP, 5);
    expect(applySnapshot(v, 1, down(), 0, true).rev).toBe(1);
  });
  test("downSince is set at the first disconnected snapshot, kept while it lasts, cleared on reconnect", () => {
    const a = seen(down(), 1, 1000);
    expect(a.downSince).toBe(1000);
    const b = applySnapshot(a, 2, down("disconnected (reconnect attempt 2, in 4s)"), 5000);
    expect(b.downSince).toBe(1000);
    expect(applySnapshot(b, 3, SNAP, 6000).downSince).toBeNull();
  });
  test("a snapshot clears the last error", () => {
    expect(seen(SNAP, 1, 0, { ...EMPTY_VIEW, error: "boom" }).error).toBeNull();
  });
});

describe("indicator", () => {
  test("connected: holds, for you and open; zero counts left out", () => {
    expect(indicator(seen(SNAP), 0)).toEqual({ kind: "connected", text: "einweave · holds 1 · 2 for you · 14 open" });
    expect(indicator(seen({ ...SNAP, waiting: { forYou: 0, channel: 0, more: false, top: [] } }), 0).text).toBe("einweave · holds 1");
    expect(indicator(seen({ ...SNAP, waiting: null }), 0).text).toBe("einweave · holds 1");
  });
  test("a drop is 'reconnecting' for the grace period, then 'disconnected' and only then the band", () => {
    const v = seen(down(), 1, 1000);
    const early = indicator(v, 1000 + BAND_GRACE_MS - 1);
    expect(early.kind).toBe("reconnecting");
    expect(needsBand(early)).toBe(false);
    const late = indicator(v, 1000 + BAND_GRACE_MS);
    expect(late.kind).toBe("disconnected");
    expect(needsBand(late)).toBe(true);
  });
  test("tools answering is not 'connected': idle and standby are their own states", () => {
    expect(indicator(seen({ ...SNAP, connection: { state: "idle", detail: null } }), 0).kind).toBe("idle");
    expect(indicator(seen({ ...SNAP, connection: { state: "standby", detail: null } }), 0).kind).toBe("standby");
  });
  test("taken over by another window: says so at once, in the band too (no grace period: it never comes back by itself)", () => {
    const i = indicator(seen({ ...SNAP, connection: { state: "superseded", detail: null } }), 0);
    expect(i).toEqual({ kind: "superseded", text: "einweave · moved to another window" });
    expect(needsBand(i)).toBe(true);
  });
  test("no snapshot: starting, or not answering once a read failed", () => {
    expect(indicator(EMPTY_VIEW, 0).kind).toBe("starting");
    expect(indicator({ ...EMPTY_VIEW, error: "ui_state failed" }, 0).kind).toBe("no-answer");
  });
  test("the band shows for nothing else", () => {
    for (const st of ["idle", "standby", "connected"] as const) expect(needsBand(indicator(seen({ ...SNAP, connection: { state: st, detail: null } }), 1e9))).toBe(false);
  });
});

describe("parseCommand", () => {
  test("bare opens the pane", () => {
    expect(parseCommand("")).toEqual({ kind: "pane" });
    expect(parseCommand("   ")).toEqual({ kind: "pane" });
  });
  test("each verb calls the plugin's own tool", () => {
    expect(parseCommand("status")).toEqual({ kind: "status", full: false });
    expect(parseCommand("status full")).toEqual({ kind: "status", full: true });
    expect(parseCommand("connect")).toEqual({ kind: "connect" });
    expect(parseCommand("Disconnect")).toEqual({ kind: "tool", tool: "disconnect", args: {} });
    expect(parseCommand("rename  review bot ")).toEqual({ kind: "tool", tool: "set_session_label", args: { label: "review bot" } });
    expect(parseCommand('rename ""')).toEqual({ kind: "tool", tool: "set_session_label", args: { label: "" } });
    expect(parseCommand("scope")).toEqual({ kind: "tool", tool: "scope", args: {} });
    expect(parseCommand("scope #a #b")).toEqual({ kind: "tool", tool: "scope", args: { channels: "#a #b" } });
    expect(parseCommand("held")).toEqual({ kind: "tool", tool: "release", args: {} });
    expect(parseCommand("release 2")).toEqual({ kind: "tool", tool: "release", args: { ref: "2" } });
    expect(parseCommand("handover")).toEqual({ kind: "tool", tool: "handover", args: {} });
    expect(parseCommand("handover 1")).toEqual({ kind: "tool", tool: "handover", args: { ref: "1" } });
    expect(parseCommand("handover 1 review bot")).toEqual({ kind: "tool", tool: "handover", args: { ref: "1", to: "review bot" } });
  });
  test("rename without a name, and unknown verbs, answer with usage and call nothing", () => {
    expect(parseCommand("rename").kind).toBe("usage");
    const u = parseCommand("take 3");
    expect(u.kind).toBe("usage");
    expect(u.kind === "usage" && u.text).toContain("/einweave:take");
  });
});

describe("statusSummary", () => {
  const STATUS = {
    websocket: "connected",
    agent: "bellman",
    label: "testar_igen",
    kind: "session",
    scope: { mode: "channels", channelIds: ["c1", "c2"] },
    holds: [],
    session_key: "b379faaf",
    session_key_resumable: true,
    version: "0.37.1",
    installed_version: "0.37.1",
    stale_since: null,
    server_versions: { minimum: "0.32.0", recommended: "0.37.1" },
    advice: "ok",
    delivery: { state: "awaiting confirmation" },
    other_processes: [
      { pid: 1, state: "disconnected", sessionKey: "other" },
      { pid: 80194, state: "superseded", sessionKey: "b379faaf" },
    ],
    configured: true,
  };
  test("the lines a person acts on; nothing about other sessions' windows", () => {
    expect(statusSummary(JSON.stringify(STATUS), { forYou: 19, channel: 0, more: true, top: [] })).toBe(
      [
        "connected · agent bellman · name testar_igen",
        "scope 2 channels",
        "holds 0 · 19+ for you (/einweave:take)",
        "plugin 0.37.1",
        "session b379faaf",
        "also open in pid 80194 (superseded)",
        "to make a window its own session: claude --resume b379faaf --fork-session",
      ].join("\n"),
    );
  });
  test("advice, a newer recommended version, a stale copy and a delivery hint are said", () => {
    const out = statusSummary(JSON.stringify({ ...STATUS, advice: "update", server_versions: { recommended: "0.38.0" }, stale_since: "x", installed_version: "0.38.0", delivery: { state: "missed", hint: "run read_deliveries" } }));
    expect(out).toContain("plugin 0.37.1 · recommended 0.38.0 · update");
    expect(out).toContain("updated on disk to 0.38.0");
    expect(out).toContain("delivery missed: run read_deliveries");
  });
  test("a key --resume does not take gets no fork hint", () => {
    expect(statusSummary(JSON.stringify({ ...STATUS, session_key_resumable: false }))).not.toContain("--fork-session");
  });
  test("not signed in, and text that is not JSON", () => {
    expect(statusSummary(JSON.stringify({ configured: false }))).toContain("/einweave:login");
    expect(statusSummary("status failed: boom")).toBe("status failed: boom");
  });
});

describe("scopeText", () => {
  test("names the scope's channels, three at most, then counts the rest", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(scopeText({ mode: "channels", channelIds: ids.slice(0, 2), channelNames: ["general", "ops"] })).toBe("#general #ops");
    expect(scopeText({ mode: "channels", channelIds: ids, channelNames: ["a1", "b1", "c1", "d1", "e1"] })).toBe("#a1 #b1 #c1 +2");
  });

  test("a channel without a name is counted, and none named falls back to the count", () => {
    expect(scopeText({ mode: "channels", channelIds: ["a", "b"], channelNames: ["general", null] })).toBe("#general +1");
    expect(scopeText({ mode: "channels", channelIds: ["a", "b"] })).toBe("2 channels");
  });

  test("none and all say what they let in", () => {
    expect(scopeText({ mode: "none", channelIds: [] })).toBe("none · only threads this session holds");
    expect(scopeText({ mode: "all", channelIds: [] })).toBe("all · unheld work from every channel");
  });
});
