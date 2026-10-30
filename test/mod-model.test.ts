/**
 * The einweave mod's rules (mod/model.ts): relay lines, the indicator's states, the band's grace
 * period and the `/einweave` verbs. The wiring to `$` is covered by the kit tests under mod/.
 */
import { describe, test, expect } from "bun:test";
import {
  ago, applySnapshot, BAND_GRACE_MS, CHANNEL_CAP, channelMeta, channelRows, channelsView, channelView, closeTab, EMPTY_TABS, EMPTY_VIEW, findInList, focusTarget, fold, fromTool, holdBadge,
  inbox, OLD_MS, quietFor, recordOf, indicator, needsBand, openTab, parseCommand, parseLine, scopeText, shownTab, statusSummary, takeOutcome, threadView, waitingIn,
} from "../mod/model";
import type { ChannelThread } from "../types";
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
    const u = parseCommand("frobnicate 3");
    expect(u.kind).toBe("usage");
    expect(u.kind === "usage" && u.text).toContain("/einweave take [N|id]");
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

describe("the Inbox and thread tabs", () => {
  const now = Date.parse("2026-10-30T10:00:00.000Z");
  const item = (threadId: string, why: "addressed" | "participant" | "channel", quietSince: string | null) =>
    ({ threadId, title: `T ${threadId}`, channel: "ops", why, hold: "unheld" as const, quietSince });

  test("For you holds addressed + participant, Open the channel tier, in the snapshot's order; quiet counts from the last post", () => {
    const box = inbox({ forYou: 3, channel: 1, more: false, top: [item("old", "participant", "2026-10-30T07:00:00.000Z"), item("new", "addressed", "2026-10-30T09:59:00.000Z"), item("bad", "addressed", "not a time"), item("none", "addressed", null), item("ch", "channel", "2026-10-29T10:00:00.000Z")] }, now);
    expect(box.forYou.map((r) => r.threadId)).toEqual(["old", "new", "bad", "none"]);
    expect(box.forYou.map((r) => r.age)).toEqual(["3h", "1m", null, null]);
    expect(box.open.map((r) => [r.threadId, r.age, r.meta])).toEqual([["ch", "1d", "unheld · new posts in your channel"]]);
    expect(inbox(null, now)).toEqual({ forYou: [], open: [] });
  });

  test("quietFor: a week to the millisecond is not old, past it is; no time is neither", () => {
    expect(quietFor(new Date(now - OLD_MS).toISOString(), now)).toEqual({ age: "7d", old: false });
    expect(quietFor(new Date(now - OLD_MS - 1).toISOString(), now)).toEqual({ age: "7d", old: true });
    expect(quietFor(null, now)).toEqual({ age: null, old: false });
    expect(quietFor("not a time", now)).toEqual({ age: null, old: false });
  });

  test("fold: recent rows in order, then the old ones in order", () => {
    const r = (id: string, old: boolean) => ({ id, old });
    expect(fold([r("a", true), r("b", false), r("c", true), r("d", false)])).toEqual({ recent: [r("b", false), r("d", false)], older: [r("a", true), r("c", true)] });
  });

  test("recordOf: the record an element belongs to; tabs, folds and the rest belong to none", () => {
    expect([recordOf("open:t1"), recordOf("take:t1"), recordOf("new:ch:c1"), recordOf("release:t1"), recordOf("join:ch:c1")]).toEqual(["t1", "t1", "ch:c1", "t1", "ch:c1"]);
    expect([recordOf("tab:inbox"), recordOf("fold:forYou"), recordOf(undefined), recordOf("")]).toEqual(["", "", "", ""]);
  });

  test("focusTarget: an action is no stop -- down goes on to the next stop, up back to its own title; past the last stop it stays", () => {
    const stops = ["open:a", "open:b", "fold:forYou", "open:c"];
    expect(focusTarget(stops, "open:a", "take:a")).toBe("open:b");
    expect(focusTarget(stops, "open:b", "take:b")).toBe("fold:forYou");
    expect(focusTarget(stops, "open:b", "new:a")).toBe("open:a");
    expect(focusTarget(stops, "fold:forYou", "release:b")).toBe("open:b");
    expect(focusTarget(stops, "open:c", "take:c")).toBe("take:c");
    expect(focusTarget(stops, "take:c", "new:c")).toBe("new:c");
    // Titles, tabs, the engine's own stops, and actions of records not drawn pass as they came.
    expect([focusTarget(stops, "", "open:b"), focusTarget(stops, "", "tab:held"), focusTarget(stops, "", undefined), focusTarget(stops, "", "take:zz")]).toEqual(["open:b", "tab:held", undefined, "take:zz"]);
  });

  test("ago: one short unit", () => {
    expect([ago(5_000), ago(125_000), ago(3 * 3_600_000), ago(50 * 3_600_000), ago(-1)]).toEqual(["5s", "2m", "3h", "2d", "0s"]);
  });

  test("takeOutcome: anything but the two known answers is shown as it came", () => {
    expect(takeOutcome("No takeable thread matches \"x\". Nothing was taken.")).toEqual({ kind: "other" });
    expect(takeOutcome("This session already held Fix the build.")).toEqual({ kind: "taken" });
    // The question without an id to confirm is not a question the mod can answer.
    expect(takeOutcome("Bob is online and working on this. Take it anyway?")).toEqual({ kind: "other" });
  });

  test("threadView: ui_thread's JSON, or its text as the error", () => {
    const v = threadView(JSON.stringify({ thread: { id: "t", title: "Hi", status: "open" }, messages: [{ sender: "K", content: "c", type: "text", ts: null }], has_older: true, older_count: 7 }));
    expect(v).toEqual({ title: "Hi", status: "open", messages: [{ sender: "K", content: "c", type: "text", ts: null }], older: 7, error: null, loading: false });
    // Older replies a server did not count: some; none at all: 0.
    expect(threadView(JSON.stringify({ messages: [], has_older: true, older_count: null })).older).toBeNull();
    expect(threadView(JSON.stringify({ messages: [], has_older: false, older_count: 0 })).older).toBe(0);
    expect(threadView("einweave is not connected")).toMatchObject({ error: "einweave is not connected", messages: [] });
  });

  test("tabs open once and show; closing the shown one goes back to the Inbox, another keeps what shows", () => {
    const a = openTab(EMPTY_TABS, "thread", "a", "A");
    const ab = openTab(openTab(a, "channel", "b", "#b"), "thread", "a", "A again");
    expect(ab).toEqual({ tab: "a", open: [{ kind: "thread", id: "a", title: "A" }, { kind: "channel", id: "b", title: "#b" }] });
    expect(closeTab(ab, "a")).toEqual({ tab: "inbox", open: [{ kind: "channel", id: "b", title: "#b" }] });
    // A tab naming one no longer in the list (closed meanwhile) draws the Inbox.
    expect(shownTab({ tab: "gone", open: [{ kind: "thread", id: "b", title: "B" }] })).toBe("inbox");
    expect(shownTab(ab)).toBe("a");
    expect(shownTab({ ...ab, tab: "held" })).toBe("held");
    expect(shownTab({ ...ab, tab: "channels" })).toBe("channels");
    expect(closeTab(ab, "b")).toEqual({ tab: "a", open: [{ kind: "thread", id: "a", title: "A" }] });
  });

  test("channel meta: waiting (unheld + parked), oldest, open; counts the server did not send are unknown, never 0", () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    expect(channelMeta({ open: 4, unheld: 1, parked: 1, oldestWaitingAt: "2026-10-30T09:00:00.000Z" }, now)).toBe("2 waiting · oldest 3h · 4 open");
    expect(channelMeta({ open: 3, unheld: 0, parked: 0, oldestWaitingAt: null }, now)).toBe("3 open");
    expect(channelMeta(undefined, now)).toBe("counts unknown");
    expect(waitingIn({ open: 9, unheld: 2, parked: 3, oldestWaitingAt: null })).toBe(5);
    expect(waitingIn(undefined)).toBe(0);
  });

  test("hold badge: held here wins; else held by X online/offline, parked, unheld; no hold from an older server: none", () => {
    const holder = { id: "s", label: "Bellman #cd34", online: true, parked: false };
    expect(holdBadge({ state: "held", holder }, true)?.text).toBe("held here");
    expect(holdBadge(undefined, true)?.text).toBe("held here");
    expect(holdBadge({ state: "held", holder }, false)?.text).toBe("held by Bellman #cd34 online");
    expect(holdBadge({ state: "held", holder: { ...holder, online: false } }, false)?.text).toBe("held by Bellman #cd34 offline");
    expect(holdBadge({ state: "parked", holder: { ...holder, online: false, parked: true } }, false)?.text).toBe("parked, Bellman #cd34 offline");
    expect(holdBadge({ state: "unheld", holder: null }, false)?.text).toBe("unheld");
    expect(holdBadge(undefined, false)).toBeNull();
  });

  test("channel rows: open first, then resolved, each in server order; cut at the cap with the rest counted", () => {
    const t = (id: string, status: string): ChannelThread => ({ id, title: id, status, kind: null, lastActivityAt: null });
    const { rows, more } = channelRows([t("r1", "resolved"), t("o1", "open"), t("r2", "resolved"), t("o2", "in_progress")]);
    expect(rows.map(r => [r.id, r.resolved])).toEqual([["o1", false], ["o2", false], ["r1", true], ["r2", true]]);
    expect(more).toBe(0);
    const many = channelRows(Array.from({ length: CHANNEL_CAP + 7 }, (_, n) => t(`t${n}`, "open")));
    expect(many.rows.length).toBe(CHANNEL_CAP);
    expect(many.more).toBe(7);
  });

  test("ui_channels / ui_channel JSON → views; anything else is an error to show", () => {
    const rows = [{ id: "c", name: "ops", role: "member" as const, following: false }];
    expect(channelsView(JSON.stringify({ agent: "bellman", channels: rows }))).toEqual({ agent: "bellman", channels: rows, error: null, loading: false });
    expect(channelsView("This einweave server is too old")).toMatchObject({ channels: [], error: "This einweave server is too old", loading: false });
    expect(channelView(JSON.stringify({ channel_id: "c", threads: [] }))).toEqual({ threads: [], error: null, loading: false });
    expect(channelView("")).toMatchObject({ error: "ui_channel answered nothing", loading: false });
  });

  test("find keeps the list's own numbers, needs every word, and passes a non-list answer through", () => {
    const list = "Threads this session could take:\n1. #general · Fix the build — unheld\n2. #ops · Review the build PR — unheld\n3. #ops · Release notes — unheld";
    expect(findInList(list, "BUILD pr")).toBe("2. #ops · Review the build PR — unheld\nTake one with /einweave take N.");
    expect(findInList(list, "nothing")).toBe('No takeable thread matches "nothing".');
    expect(findInList("No threads to take: nothing open.", "x")).toBe("No threads to take: nothing open.");
  });

  test("verbs: take [ref], find <words>", () => {
    expect(parseCommand("take")).toEqual({ kind: "tool", tool: "take", args: {} });
    expect(parseCommand("take 2")).toEqual({ kind: "take", ref: "2" });
    expect(parseCommand("find release notes")).toEqual({ kind: "find", words: "release notes" });
    expect(parseCommand("find").kind).toBe("usage");
  });
});
