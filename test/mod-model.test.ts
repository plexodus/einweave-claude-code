/**
 * The einweave mod's rules (mod/model.ts): relay lines, the indicator's states, the band's grace
 * period and the `/einweave` verbs. The wiring to `$` is covered by the kit tests under mod/.
 */
import { describe, test, expect } from "bun:test";
import {
  ago, applySnapshot, BAND_GRACE_MS, CHANNEL_CAP, claudeCodeTooOld, MIN_CLAUDE_CODE, channelMeta, channelRows, channelsView, channelView, closeTab, EMPTY_TABS, EMPTY_VIEW, searchText, applySuggestion, fitSnippet, oneLine, focusTarget, fold, fromTool, holdBadge,
  inbox, OLD_MS, PALETTE, quietFor, recordOf, indicator, needsBand, openTab, parseCommand, parseLine, scopeText, shownTab, STALE_MS, stateLine, statusSummary, takeOutcome, threadView, waitingIn,
  landOff, olderCursor, POST_CAP, postKey, refreshed, scrollBy, windowOff, stack, revealOff, leadOf, hidden, cueText, SENDER_HUES, senderColor, tabRows, tabWidth, threadLayout, withOlder,
} from "../mod/model";
import type { ThreadMessage, ThreadView } from "../types";
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
    expect(box.forYou.map((r) => r.age)).toEqual(["3 h", "1 min", null, null]);
    // Quiet an hour or more: drawn amber (board Unowned).
    expect(box.forYou.map((r) => r.stale)).toEqual([true, false, false, false]);
    expect(box.forYou.map((r) => r.aimed)).toEqual([false, true, true, true]);
    expect(box.forYou[0]!.meta).toBe("you took part · unheld");
    expect(box.open.map((r) => [r.threadId, r.age, r.meta])).toEqual([["ch", "1 d", "new posts · unheld"]]);
    expect(inbox(null, now)).toEqual({ forYou: [], open: [] });
  });

  test("quietFor: a week to the millisecond is not old, past it is; no time is neither", () => {
    expect(quietFor(new Date(now - OLD_MS).toISOString(), now)).toEqual({ age: "7 d", old: false, stale: true });
    expect(quietFor(new Date(now - OLD_MS - 1).toISOString(), now)).toEqual({ age: "7 d", old: true, stale: true });
    expect(quietFor(new Date(now - STALE_MS + 1).toISOString(), now)).toEqual({ age: "59 min", old: false, stale: false });
    expect(quietFor(new Date(now - STALE_MS).toISOString(), now)).toEqual({ age: "1 h", old: false, stale: true });
    expect(quietFor(null, now)).toEqual({ age: null, old: false, stale: false });
    expect(quietFor("not a time", now)).toEqual({ age: null, old: false, stale: false });
  });

  test("fold: recent rows in order, then the old ones in order", () => {
    const r = (id: string, old: boolean) => ({ id, old });
    expect(fold([r("a", true), r("b", false), r("c", true), r("d", false)])).toEqual({ recent: [r("b", false), r("d", false)], older: [r("a", true), r("c", true)] });
  });

  test("recordOf: the record an element belongs to; tabs, folds and the rest belong to none", () => {
    expect([recordOf("mark:t1"), recordOf("open:t1"), recordOf("take:t1"), recordOf("new:ch:c1"), recordOf("release:t1"), recordOf("join:ch:c1")]).toEqual(["t1", "t1", "t1", "ch:c1", "t1", "ch:c1"]);
    expect([recordOf("tab:inbox"), recordOf("fold:forYou"), recordOf("foot:take"), recordOf(undefined), recordOf("")]).toEqual(["", "", "", "", ""]);
  });

  test("focusTarget: a record's mark is its only stop -- its title and actions are none: down goes on to the next stop, up back to its own mark; past the last stop it stays", () => {
    const stops = ["mark:a", "mark:b", "fold:forYou", "mark:c"];
    expect(focusTarget(stops, "mark:a", "open:a")).toBe("mark:b");
    expect(focusTarget(stops, "mark:a", "take:a")).toBe("mark:b");
    expect(focusTarget(stops, "mark:b", "open:b")).toBe("fold:forYou");
    expect(focusTarget(stops, "mark:b", "open:a")).toBe("mark:a");
    expect(focusTarget(stops, "fold:forYou", "release:b")).toBe("mark:b");
    expect(focusTarget(stops, "", "open:b")).toBe("mark:b");
    expect(focusTarget(stops, "mark:c", "open:c")).toBe("open:c");
    expect(focusTarget(stops, "open:c", "take:c")).toBe("take:c");
    // Marks, tabs, the footer, the engine's own stops, and records not drawn pass as they came.
    expect([focusTarget(stops, "", "mark:b"), focusTarget(stops, "", "tab:held"), focusTarget(stops, "mark:c", "foot:take"), focusTarget(stops, "", undefined), focusTarget(stops, "", "take:zz")]).toEqual(["mark:b", "tab:held", "foot:take", undefined, "take:zz"]);
  });

  test("ago: one unit, spaced as the canvas writes it", () => {
    expect([ago(5_000), ago(125_000), ago(3 * 3_600_000), ago(50 * 3_600_000), ago(-1)]).toEqual(["5 s", "2 min", "3 h", "2 d", "0 s"]);
  });

  test("takeOutcome: anything but the two known answers is shown as it came", () => {
    expect(takeOutcome("No takeable thread matches \"x\". Nothing was taken.")).toEqual({ kind: "other" });
    expect(takeOutcome("This session already held Fix the build.")).toEqual({ kind: "taken" });
    // The question without an id to confirm is not a question the mod can answer.
    expect(takeOutcome("Bob is online and working on this. Take it anyway?")).toEqual({ kind: "other" });
  });

  test("threadView: ui_thread's JSON, or its text as the error", () => {
    const v = threadView(JSON.stringify({ thread: { id: "t", title: "Hi", status: "open" }, channel: "ops", messages: [{ sender: "K", content: "c", type: "text", ts: null }], has_older: true, older_count: 7 }));
    expect(v).toEqual({ title: "Hi", channel: "ops", status: "open", messages: [{ sender: "K", content: "c", type: "text", ts: null }], older: 7, error: null, loading: false });
    // An older plugin's answer has no channel: the header then shows the title alone.
    expect(threadView(JSON.stringify({ messages: [] })).channel).toBeNull();
    // Older replies a server did not count: some; none at all: 0.
    expect(threadView(JSON.stringify({ messages: [], has_older: true, older_count: null })).older).toBeNull();
    expect(threadView(JSON.stringify({ messages: [], has_older: false, older_count: 0 })).older).toBe(0);
    expect(threadView("einweave is not connected")).toMatchObject({ error: "einweave is not connected", messages: [] });
    // A work item's header passes through; a conversation kind, or one that is not a header, has none.
    const work = { kind: "bug", status: "open", resolvedReason: null, assignee: "@bellman", fields: [], missing: [] };
    expect(threadView(JSON.stringify({ thread: { work }, messages: [] })).work).toEqual(work);
    expect(threadView(JSON.stringify({ thread: { work: { kind: "bug" } }, messages: [] }))).not.toHaveProperty("work");
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

  test("channel meta (board ChannelsTab): open, unowned (unheld + parked), oldest waiting; counts the server did not send are unknown, never 0", () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    expect(channelMeta({ open: 4, unheld: 1, parked: 1, oldestWaitingAt: "2026-10-30T09:00:00.000Z" }, now)).toBe("4 open · 2 unowned · oldest waiting 3 h");
    expect(channelMeta({ open: 3, unheld: 0, parked: 0, oldestWaitingAt: null }, now)).toBe("3 open");
    expect(channelMeta(undefined, now)).toBe("counts unknown");
    expect(waitingIn({ open: 9, unheld: 2, parked: 3, oldestWaitingAt: null })).toBe(5);
    expect(waitingIn(undefined)).toBe(0);
  });

  test("hold badge (board ChannelsTab): yours brand, nobody's amber, another session's dim; Take from an online holder asks", () => {
    const holder = { id: "s", label: "Bellman #cd34", online: true, parked: false };
    expect(holdBadge({ state: "held", holder }, true)).toEqual({ text: "held by you", tone: "brand", asks: false });
    expect(holdBadge(undefined, true)?.text).toBe("held by you");
    expect(holdBadge({ state: "held", holder }, false)).toEqual({ text: "held by Bellman #cd34 · online", tone: "dim", asks: true });
    expect(holdBadge({ state: "held", holder: { ...holder, online: false } }, false)).toEqual({ text: "held by Bellman #cd34 · offline", tone: "dim", asks: false });
    expect(holdBadge({ state: "parked", holder: { ...holder, online: false, parked: true } }, false)?.text).toBe("held by Bellman #cd34 · offline");
    expect(holdBadge({ state: "unheld", holder: null }, false)).toEqual({ text: "unheld", tone: "amber", asks: false });
    expect(holdBadge(undefined, false)).toBeNull();
  });

  test("stateLine: the counts with what is aimed at you amber; red when messages are not arriving", () => {
    const snap = (state: string, waiting: unknown = null) => ({ v: 1, connection: { state, detail: null }, session: { agent: null, label: null, kind: null, scope: null }, holds: [{ threadId: "t", title: null }], waiting, version: "x", staleSince: null }) as never;
    const at = (s: unknown, downSince: number | null = null) => stateLine({ ...EMPTY_VIEW, snap: s as never, downSince }, 100_000);
    expect(at(snap("connected", { forYou: 2, channel: 3, more: false, top: [] }))).toEqual([
      { text: "holds 1" }, { text: " · ", tone: "dim" }, { text: "2 for you", tone: "amber" }, { text: " · ", tone: "dim" }, { text: "3 unowned" },
    ]);
    expect(at(snap("connected"))).toEqual([{ text: "holds 1" }]);
    expect(at(snap("disconnected"), 0)).toEqual([{ text: "○ disconnected · messages are not arriving", tone: "red" }]);
    expect(at(snap("disconnected"), 99_000)).toEqual([{ text: "↻ reconnecting", tone: "amber" }]);
    expect(PALETTE).toEqual({ brand: "#4cc3ad", amber: "#e8b04a", blue: "#7ab4ff", red: "#f07a7a", pillBg: "#e4e4e4", pillFg: "#121212" });
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

  test("fitSnippet: a line that fits is untouched; a long one keeps context before the first hit, cut with … at either end", () => {
    const P = (text: string, hit = false) => ({ text, hit });
    expect(fitSnippet([P("short "), P("hit", true)], 40)).toEqual([P("short "), P("hit", true)]);
    const long = [P("bellman #4115 is being "), P("deployed", true), P(" right now and should be available in ten minutes")];
    const fit = fitSnippet(long, 30);
    expect(fit.map((p) => p.text).join("").length).toBe(30);
    expect(fit.find((p) => p.hit)).toEqual(P("deployed", true));
    expect(fit.at(-1)).toEqual(P("…"));
    // Far into the text: a leading … and the hit still whole.
    const deep = fitSnippet([P("x".repeat(100) + " before "), P("deploy", true), P(" after")], 24);
    expect(deep[0]).toEqual(P("…"));
    expect(deep.map((p) => p.text).join("").length).toBeLessThanOrEqual(24);
    expect(deep.find((p) => p.hit)).toEqual(P("deploy", true));
    // The window opens on a whole word, never mid-word ("…ellman").
    const words = fitSnippet([P("the rest of the bellman story is being "), P("deployed", true), P(" as we speak and more text to cut here")], 30);
    expect(words[0]).toEqual(P("…"));
    expect(words[1]!.text.startsWith(" ")).toBe(false);
    expect(["the", "rest", "of", "bellman", "story", "is", "being"].some((w) => words[1]!.text.startsWith(w))).toBe(true);
  });

  test("a snippet draws on one line: newlines and runs of spaces become one space, the ends trimmed", () => {
    expect(oneLine([{ text: "  line one\n\nline   two ", hit: false }, { text: "answered", hit: true }, { text: "\n by Brian\n", hit: false }])).toEqual([
      { text: "line one line two ", hit: false },
      { text: "answered", hit: true },
      { text: " by Brian", hit: false },
    ]);
    expect(oneLine([{ text: "\n  ", hit: false }])).toEqual([]);
  });

  test("the search field's filler is never a stop: from the field on to the first record, from elsewhere back into the field", () => {
    expect(focusTarget(["mark:a", "mark:b"], "search", "search-fill")).toBe("mark:a");
    expect(focusTarget([], "search", "search-fill")).toBe("search");
    expect(focusTarget(["mark:a", "mark:b"], "mark:a", "search-fill")).toBe("search");
    expect(focusTarget(["mark:a"], "", "search")).toBe("search");
  });

  test("a suggestion replaces the token as it stands: is: → is:answered, in:#opz → in:#ops; no token found → added", () => {
    expect(applySuggestion("deploy is:", "is:", "is:answered")).toBe("deploy is:answered");
    expect(applySuggestion("deploy in:#opz", "in:#opz", "in:#ops")).toBe("deploy in:#ops");
    expect(applySuggestion("deploy", "kind:bugg", "kind:bug")).toBe("deploy kind:bug");
  });

  test("find (searchText): a line per thread with where it matched and its id; refusal and non-JSON pass through", () => {
    const page = {
      results: [
        { thread_id: "t-1", title: "Deploy window today", channel: "ops", kind: "question", status: "open", matching_replies: 3, snippet_parts: [{ text: "after the ", hit: false }, { text: "deploy", hit: true }, { text: "  window", hit: false }] },
        { thread_id: "t-2", title: "Deployment checklist", channel: "ops", kind: "task", status: "todo", similar_title: true, matching_replies: 0, snippet_parts: [{ text: "Deployment checklist", hit: false }] },
      ],
      total: { count: 1000, capped: true },
    };
    expect(searchText(JSON.stringify(page), "deploy")).toBe(
      '1000+ for "deploy":\n#ops · Deploy window today — "after the deploy window" · 3 replies match\n   t-1\n#ops · Deployment checklist — similar title\n   t-2\nTake one with /einweave take <id>.',
    );
    expect(searchText(JSON.stringify({ results: [], total: { count: 0, capped: false } }), "zz")).toBe('Nothing matches "zz". Try fewer words, or drop a filter.');
    expect(searchText(JSON.stringify({ refused: { code: "unresolved_filter", message: "Nothing you can read matches in:#opz. Did you mean: in:#ops?" } }), "x")).toBe("Nothing you can read matches in:#opz. Did you mean: in:#ops?");
    expect(searchText("This einweave server is too old for search", "x")).toBe("This einweave server is too old for search");
  });

  test("verbs: take [ref], search <words>", () => {
    expect(parseCommand("take")).toEqual({ kind: "tool", tool: "take", args: {} });
    expect(parseCommand("take 2")).toEqual({ kind: "take", ref: "2" });
    expect(parseCommand("search release notes")).toEqual({ kind: "search", words: "release notes" });
    expect(parseCommand("search").kind).toBe("usage");
  });
});

describe("thread tab layout (layout A: chat order, own scroll, cap)", () => {
  const post = (seq: number, content: string, o: Partial<ThreadMessage> = {}): ThreadMessage => ({ sender: "K", content, type: "text", ts: null, seq, ...o });
  const root = post(1, "root", { root: true });

  test("rows: a blank between posts, the sender row, the lines; the gap row under the root while older replies exist", () => {
    const l = threadLayout([root, post(5, "a"), post(6, "b\nc")], 40, {}, 3);
    expect(l.blocks.map(b => [b.key, b.top, b.rows])).toEqual([["root", 0, 2], ["s5", 4, 3], ["s6", 7, 4]]);
    expect(l.gap).toEqual({ top: 2, rows: 2 });
    expect(l.total).toBe(11);
    expect(threadLayout([root, post(5, "a")], 40, {}, 0).gap).toBeNull();
  });

  test("a work item's root draws its header as blocks (RFC-029 D2): filed, a block per field under its label, missing; an empty root is no post", () => {
    const work = { kind: "feature", status: "triage", resolvedReason: null, assignee: null, fields: [{ key: "problem", label: "Problem", value: Array.from({ length: 9 }, (_, i) => `p${i}`).join("\n") }, { key: "proposal", label: "Proposal", value: "do it" }], missing: ["Acceptance criteria"] };
    const empty = post(1, "", { root: true });
    const l = threadLayout([empty, post(5, "a")], 40, {}, 0, true, work);
    // filed: its row; Problem: label + 6 lines + more; Proposal: label + 1; Missing: its row. No blank rows inside the header.
    expect(l.blocks.map(b => [b.key, b.top, b.rows, b.space])).toEqual([["filed", 0, 1, false], ["f:problem", 1, 8, false], ["f:proposal", 9, 2, false], ["missing", 11, 1, false], ["s5", 12, 3, true]]);
    expect(l.blocks[1]!.more).toBe(9 - POST_CAP);
    expect(l.blocks[3]!.head).toEqual({ label: "Missing: Acceptance criteria", missing: true });
    expect(threadLayout([empty], 40, { "f:problem": true }, 0, true, work).blocks[1]!.lines).toHaveLength(9);
    // A root its author wrote stays a post, under the header with a blank row above it.
    const said = threadLayout([root, post(5, "a")], 40, {}, 3, true, { ...work, fields: [], missing: [] });
    expect(said.blocks.map(b => [b.key, b.top, b.rows, b.space])).toEqual([["filed", 0, 1, false], ["root", 1, 3, true], ["s5", 6, 3, true]]);
    expect(said.gap).toEqual({ top: 4, rows: 2 });
  });

  test(`a post over ${POST_CAP + 1} lines shows ${POST_CAP} and a "more" row until opened; ${POST_CAP + 1} show whole`, () => {
    const long = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    const seven = Array.from({ length: POST_CAP + 1 }, (_, i) => `l${i}`).join("\n");
    const [b] = threadLayout([post(5, long)], 40, {}, 0).blocks;
    expect([b!.lines.length, b!.more, b!.rows]).toEqual([POST_CAP, 10 - POST_CAP, 1 + POST_CAP + 1]);
    expect(threadLayout([post(5, long)], 40, { s5: true }, 0).blocks[0]!.lines).toHaveLength(10);
    expect(threadLayout([post(5, seven)], 40, {}, 0).blocks[0]!.more).toBe(0);
  });

  test("lands with the first new post at the window's top, else the newest; never past the top", () => {
    const ms = [root, post(5, "a"), post(6, "b", { new: true }), post(7, "c", { new: true })];
    const l = threadLayout(ms, 40, {}, 0); // tops 0, 2, 5, 8; total 11
    // s6's sender row is row 6 (its blank row 5 above it): the window's top is there.
    expect(landOff(l, ms, 4)).toBe(11 - 4 - 6);
    expect(landOff(l, ms.map(m => ({ ...m, new: false })), 4)).toBe(0);
    expect(landOff(l, ms, 20)).toBe(0);
    expect(postKey(ms[2]!, 2)).toBe("s6");
  });

  test("the person's place holds while a live thread grows below it, follows the newest at 0, and clamps", () => {
    const ms = [post(5, "a"), post(6, "b")];
    const l = threadLayout(ms, 40, {}, 0); // total 5
    const grown = threadLayout([...ms, post(7, "c")], 40, {}, 0); // total 8
    expect(windowOff({ off: 1, newest: "s6", open: {} }, grown, 2, landOff(grown, ms, 2), "end")).toBe(1 + 3);
    expect(windowOff({ off: 0, newest: "s6", open: {} }, grown, 2, landOff(grown, ms, 2), "end")).toBe(0);
    expect(windowOff({ off: 99, newest: "s6", open: {} }, l, 2, landOff(l, ms, 2), "end")).toBe(3);
    // Not moved yet: where it lands, clamped.
    expect(windowOff(undefined, l, 2, 99, "end")).toBe(3);
  });

  // The pane's one window, every tab (plan 2026-11-04-mod-pinned-every-tab-plan.md).
  const list = stack([{ key: "a", rows: 2 }, { key: "b", rows: 3 }, { key: "c", rows: 2 }, { key: "d", rows: 3 }]); // tops 0, 2, 5, 7; total 10

  test("stack: each block under the last, its top and the height", () => {
    expect(list.blocks.map(b => [b.key, b.top])).toEqual([["a", 0], ["b", 2], ["c", 5], ["d", 7]]);
    expect(list.total).toBe(10);
  });

  test("a list lands at its top and stays there as rows arrive; moved down, its place holds", () => {
    const max = 10 - 4;
    expect(windowOff(undefined, list, 4, max, "top")).toBe(max);
    const grown = stack([{ key: "new", rows: 2 }, ...list.blocks]); // a row arrived above
    expect(windowOff({ off: max, newest: "d", open: {}, top: true }, grown, 4, 12 - 4, "top")).toBe(12 - 4);
    // Not at the top: rows above leave the window on the same rows (counted from the end).
    expect(windowOff({ off: 2, newest: "d", open: {} }, grown, 4, 12 - 4, "top")).toBe(2);
    // An end-anchored window (a thread) does not follow the top.
    expect(windowOff({ off: max, newest: "d", open: {}, top: true }, grown, 4, 0, "end")).toBe(max);
  });

  test("revealOff: the least move that shows a block whole, none when it shows", () => {
    // off 6 shows rows 0-3 (a, b's first two). b ends at row 5: down by one row.
    expect(revealOff(list, "b", 6, 4)).toBe(5);
    expect(revealOff(list, "a", 6, 4)).toBe(6);
    // d (rows 7-9) from the top: its foot at the window's foot.
    expect(revealOff(list, "d", 6, 4)).toBe(0);
    // From the end, a: its top at the window's top.
    expect(revealOff(list, "a", 0, 4)).toBe(6);
    // Taller than the window: its top.
    expect(revealOff(stack([{ key: "x", rows: 2 }, { key: "big", rows: 9 }]), "big", 7, 4)).toBe(11 - 4 - 2);
    expect(revealOff(list, "nope", 3, 4)).toBe(3);
  });

  test("revealOff: a section's first record brings its heading along when both fit; else the record alone", () => {
    // Rows: h(0) · r1(1-3, a blank on top) · note(4) · h2(5-6, a blank on top) · gw(7) · r2(8-10) · r3(11-13). Total 14.
    const l = stack([
      { key: "h", rows: 1, section: true },
      { key: "r1", rows: 3, stop: true, space: true },
      { key: "note", rows: 1 },
      { key: "h2", rows: 2, section: true, space: true },
      { key: "gw", rows: 1 },
      { key: "r2", rows: 3, stop: true },
      { key: "r3", rows: 3, stop: true, space: true },
    ]);
    expect(leadOf(l, "r1")?.key).toBe("h");
    // Over a row that is no stop (Unowned's gateway line) to the heading.
    expect(leadOf(l, "r2")?.key).toBe("h2");
    // Not a section's first: a stop comes first.
    expect(leadOf(l, "r3")).toBeUndefined();
    // From the end (off 0, rows 9-13 at room 5): r1 brings h, the window's top at row 0.
    expect(revealOff(l, "r1", 0, 5)).toBe(14 - 5);
    // h2's own blank row stays out: the window's top is its heading row, 6 (r2 ends at row 10, 5 rows).
    expect(revealOff(l, "r2", 0, 5)).toBe(14 - 5 - 6);
    // Too short for both (room 4: heading row 6 to row 10 is 5): the record alone, its top at the window's top.
    expect(revealOff(l, "r2", 0, 4)).toBe(14 - 4 - 8);
    // Moving down (from the top): the foot at the window's foot, the heading already in view.
    expect(revealOff(l, "r2", 14 - 5, 5)).toBe(14 - 11);
  });

  test("hidden + cueText: the rows above and below the window, only the sides that hide any", () => {
    expect(hidden(list, 6, 4)).toEqual({ above: 0, below: 6 });
    expect(hidden(list, 2, 4)).toEqual({ above: 4, below: 2 });
    expect(hidden(list, 0, 20)).toEqual({ above: 0, below: 0 });
    expect(cueText({ above: 0, below: 6 })).toBe("↓ 6");
    expect(cueText({ above: 4, below: 2 })).toBe("↑ 4 · ↓ 2");
    expect(cueText({ above: 0, below: 0 })).toBe("");
  });

  test("scrollBy: negative goes up; atTop once the top shows", () => {
    const l = threadLayout([post(5, "a"), post(6, "b")], 40, {}, 0); // total 5
    expect(scrollBy(0, -1, l, 2)).toEqual({ off: 1, atTop: false });
    expect(scrollBy(1, -10, l, 2)).toEqual({ off: 3, atTop: true });
    expect(scrollBy(3, 10, l, 2)).toEqual({ off: 0, atTop: false });
  });

  test("tabRows wraps as flex-wrap does; tabWidth pads a cell each side and counts the × as two", () => {
    expect(tabWidth("Inbox 3", false)).toBe(9);
    // Every opened tab's × is `× `, shown or not: a tab keeps its width when it becomes the shown one.
    expect(tabWidth("x", true)).toBe(5);
    expect(tabRows([9, 9, 9], 29)).toBe(1);
    expect(tabRows([9, 9, 9], 28)).toBe(2);
    expect(tabRows([9, 9, 9], 9)).toBe(3);
    // Any gap: the pane's header and a row of suggestions are two cells apart.
    expect(tabRows([9, 9, 9], 29, 2)).toBe(2);
    expect(tabRows([9, 9, 9], 31, 2)).toBe(1);
  });

  test("withOlder puts an older page between the root and the replies, once each; the cursor is the oldest reply", () => {
    const t: ThreadView = { title: "t", status: null, messages: [root, post(30, "c")], older: 2, error: null, loading: false };
    const page: ThreadView = { ...t, messages: [root, post(10, "a"), post(20, "b"), post(30, "c")], older: 0 };
    expect(olderCursor(t)).toBe(30);
    const merged = withOlder(t, page);
    expect(merged.messages.map(m => m.content)).toEqual(["root", "a", "b", "c"]);
    expect(merged.older).toBe(0);
    expect(olderCursor(merged)).toBe(10);
    // A live read after it brings the newest page again: the older ones loaded stay under it.
    const fresh: ThreadView = { ...t, messages: [root, post(30, "c"), post(40, "d")], older: 2 };
    const kept = refreshed(merged, fresh);
    expect(kept.messages.map(m => m.content)).toEqual(["root", "a", "b", "c", "d"]);
    expect(kept.older).toBe(0);
    expect(refreshed(undefined, fresh)).toBe(fresh);
  });
});

describe("senderColor", () => {
  test("one colour per id, never one that already means something, none without an id", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `0190a000-0000-7000-8000-${String(i).padStart(12, "0")}`);
    const got = ids.map(senderColor);
    // Pinned: the same person keeps their colour across releases (a hash change would reshuffle everyone).
    expect([senderColor("kevin"), senderColor("brian")]).toEqual(["#a8d672", "#f5a97f"]);
    // Spread: every hue used across 40 ids, and only those hues.
    expect(new Set(got)).toEqual(new Set(SENDER_HUES));
    for (const c of Object.values(PALETTE)) expect(SENDER_HUES as readonly string[]).not.toContain(c);
    // D2: light cyan, never a violet that a red-weak eye reads as PALETTE.blue (you).
    expect(SENDER_HUES).toEqual(["#9ce0e8", "#f29ac6", "#a8d672", "#f5a97f"]);
    expect(senderColor(null)).toBeUndefined();
    expect(senderColor("")).toBeUndefined();
  });
});

describe("claudeCodeTooOld (the mod's minimum Claude Code)", () => {
  test("older than the minimum is old; the minimum and later are not", () => {
    expect(MIN_CLAUDE_CODE).toBe("2.1.299");
    expect(claudeCodeTooOld("2.1.296")).toBe(true);
    expect(claudeCodeTooOld("2.1.298")).toBe(true);
    expect(claudeCodeTooOld("2.0.999")).toBe(true);
    expect(claudeCodeTooOld("2.1.299")).toBe(false);
    expect(claudeCodeTooOld("2.1.317")).toBe(false);
    expect(claudeCodeTooOld("2.2.0")).toBe(false);
    expect(claudeCodeTooOld("3.0.0")).toBe(false);
  });
  test("compares numbers, not strings: 2.1.1000 is newer than 2.1.299", () => {
    expect(claudeCodeTooOld("2.1.1000")).toBe(false);
    expect(claudeCodeTooOld("2.1.30")).toBe(true);
  });
  test("a development build reads as its release", () => {
    expect(claudeCodeTooOld("2.1.298-dev")).toBe(true);
    expect(claudeCodeTooOld("2.1.320-dev.20261101.t101500.sha1a2b3c4")).toBe(false);
  });
  test("unknown counts as old", () => {
    expect(claudeCodeTooOld(undefined)).toBe(true);
    expect(claudeCodeTooOld(null)).toBe(true);
    expect(claudeCodeTooOld("")).toBe(true);
    expect(claudeCodeTooOld("dev")).toBe(true);
  });
});
