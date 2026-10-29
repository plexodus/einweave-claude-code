import { describe, test, expect } from "bun:test";
import { createLabelSetting } from "../session-settings";

describe("label setting (RFC-028 D6: the server stores it, a client sends only a change)", () => {
  test("a window that did not rename sends no label, and adopts the one the server stored", () => {
    const s = createLabelSetting();
    expect(s.forFrame()).toBeUndefined();
    s.adopt("fixer");
    expect(s.current()).toBe("fixer");
    expect(s.forFrame(), "a takeover must not undo another window's rename").toBeUndefined();
  });

  test("a change made here rides the next frame once, then the server's copy is the label", () => {
    const s = createLabelSetting();
    s.adopt(null);
    s.change("reviewer");
    expect(s.current()).toBe("reviewer");
    expect(s.forFrame()).toBe("reviewer");
    s.adopt("reviewer");
    expect(s.forFrame()).toBeUndefined();
    expect(s.current()).toBe("reviewer");
  });

  test("the starting label (EINWEAVE_SESSION_LABEL) is a change: it rides the first frame only", () => {
    const s = createLabelSetting("from-env");
    expect(s.forFrame()).toBe("from-env");
    s.adopt("from-env");
    expect(s.forFrame()).toBeUndefined();
  });

  test("a change made after the frame left survives that frame's answer and rides the next", () => {
    const s = createLabelSetting();
    s.adopt("old");
    expect(s.forFrame()).toBeUndefined();
    s.change("late");
    s.adopt("old");
    expect(s.current()).toBe("late");
    expect(s.forFrame()).toBe("late");
  });

  test("the server's sanitised form wins over what was sent", () => {
    const s = createLabelSetting();
    s.change("  spaced  ");
    s.forFrame();
    s.adopt("spaced");
    expect(s.current()).toBe("spaced");
    expect(s.forFrame()).toBeUndefined();
  });

  test("null from the server is the derived name: the label is cleared", () => {
    const s = createLabelSetting();
    s.adopt("was");
    s.adopt(null);
    expect(s.current()).toBe("");
  });

  test("a rename the server stored (the label route) is the label, nothing pending", () => {
    const s = createLabelSetting();
    s.adopt(null);
    s.applied("named");
    expect(s.current()).toBe("named");
    expect(s.forFrame()).toBeUndefined();
    s.applied("");
    expect(s.current()).toBe("");
  });

  test("an older server stores nothing: the label rides every frame, as before", () => {
    const s = createLabelSetting();
    s.change("mine");
    expect(s.forFrame()).toBe("mine");
    s.adopt(undefined);
    expect(s.current()).toBe("mine");
    expect(s.forFrame()).toBe("mine");
    s.adopt(undefined);
    expect(s.forFrame()).toBe("mine");
    s.applied("renamed");
    expect(s.forFrame()).toBe("renamed");
  });
});
