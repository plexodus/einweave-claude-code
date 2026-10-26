/**
 * bridge #323 `for_you`: addressed work this window's scope did not take is kept until the next prompt and
 * told as ONE line (delivery/for-you.ts); the ctl answer carries it beside the missed notice (delivery-ctl.test.ts).
 */
import { describe, test, expect } from "bun:test";
import { forYouBox, forYouNote, type ForYouItem } from "../delivery/for-you";

const item = (over: Partial<ForYouItem> = {}): ForYouItem => ({
  entry: "thread_event",
  id: "e1",
  threadId: "t1",
  channelId: "c1",
  why: "assigned",
  title: "Renew the TLS wildcard",
  ...over,
});

describe("for_you note", () => {
  test("one item: named; several: counted, the newest named", () => {
    expect(forYouNote([item()])).toBe(
      'einweave: 1 new for you — assigned "Renew the TLS wildcard". This window\'s scope did not take it; /einweave:take picks it up.'
    );
    expect(forYouNote([item(), item({ entry: "message", id: "m1", why: "mention", title: "Deploy plan" })])).toBe(
      'einweave: 2 new for you (latest: mentioned you in "Deploy plan"). This window\'s scope did not take them; /einweave:take lists them.'
    );
    expect(forYouNote([])).toBeNull();
  });

  test("each kind reads as what happened; no title falls back to the thread id; control characters are stripped", () => {
    expect(forYouNote([item({ entry: "message", why: "thread", title: "Fix\u001b[31m the\nbuild" })])).toContain('new reply in "Fix the build"');
    expect(forYouNote([item({ entry: "message", why: "assignee", title: null })])).toContain("new post on thread t1, assigned to you");
    expect(forYouNote([item({ entry: "action_request", why: "health", threadId: null, title: null })])).toContain("action request health");
    expect(forYouNote([item({ why: "status" })])).toContain('status on "Renew the TLS wildcard"');
  });

  test("the box: told once, a replayed id is not told again, taking empties it", () => {
    const box = forYouBox();
    expect(box.take()).toBeNull();
    box.add(item());
    box.add(item()); // a resume replays the frame
    expect(box.take()).toContain("1 new for you");
    expect(box.take()).toBeNull();
    box.add(item()); // already told
    expect(box.take()).toBeNull();
  });
});
