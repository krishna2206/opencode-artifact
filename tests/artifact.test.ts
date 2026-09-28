import { describe, expect, it } from "bun:test";
import {
  addComment,
  agentEdit,
  agentWrite,
  checkBase,
  clearReview,
  EMPTY_ARTIFACT,
  fromStored,
  hasReview,
  instructionText,
  locateQuote,
  READ_MAX_BYTES,
  removeComment,
  renderForModel,
  reviewMessage,
  switchProblem,
  switchResult,
  switchTo,
  userSave,
  type Artifact,
  type Change,
} from "../src/artifact";

/** Applies changes one after another, keeping the revision texts like the store does. */
function track(start: Artifact = EMPTY_ARTIFACT) {
  let artifact = start;
  const texts = new Map<number, { title: string; content: string }>();
  const apply = (change: Change) => {
    if (change.put) texts.set(change.put.revision, change.put.snapshot);
    for (const revision of change.drop) texts.delete(revision);
    artifact = change.artifact;
    return artifact;
  };
  return {
    apply,
    get: () => artifact,
    texts,
    switch: (target: number, by: "user" | "agent" = "user", now = 9000) => apply(switchTo(artifact, target, texts.get(target)!, by, now)),
  };
}

const plan = agentWrite(EMPTY_ARTIFACT, "Plan", "# Plan\n\n1. Parse the input\n2. Store it\n", 1000).artifact;

describe("writes", () => {
  it("creates the artifact at revision 1 and keeps the title on later writes", () => {
    expect(plan.revision).toBe(1);
    expect(plan.latest).toBe(1);
    expect(agentWrite(plan, undefined, "new", 2000).artifact.title).toBe("Plan");
  });

  it("edits a unique passage, refuses a missing or ambiguous one", () => {
    expect(agentEdit(plan, "Store it", "Save it", false, 2000).artifact.content).toContain("2. Save it");
    expect(() => agentEdit(plan, "absent", "x", false, 2000)).toThrow("not found");
    const twice = agentWrite(plan, undefined, "a a", 2000).artifact;
    expect(() => agentEdit(twice, "a", "b", false, 3000)).toThrow("2 times");
    expect(agentEdit(twice, "a", "b", true, 3000).artifact.content).toBe("b b");
  });

  it("refuses an edit before any write", () => {
    expect(() => agentEdit(EMPTY_ARTIFACT, "a", "b", false, 1000)).toThrow("no artifact");
  });

  it("makes each change a revision and keeps its text", () => {
    const history = track();
    history.apply(agentWrite(EMPTY_ARTIFACT, "Plan", "one", 1000));
    history.apply(agentEdit(history.get(), "one", "two", false, 2000));
    history.apply(userSave(history.get(), "three", 3000));
    expect(history.get().revision).toBe(3);
    expect(history.get().history.map((info) => [info.revision, info.by, info.kind])).toEqual([
      [1, "agent", "write"],
      [2, "agent", "edit"],
      [3, "user", "save"],
    ]);
    expect(history.texts.get(2)?.content).toBe("two");
  });

  it("ignores a save without change", () => {
    expect(userSave(plan, plan.content, 2000).artifact).toBe(plan);
  });

  it("drops the oldest revisions beyond the limit", () => {
    const history = track();
    for (let index = 1; index <= 5; index++) history.apply(agentWrite(history.get(), "Plan", `v${index}`, index, { maxRevisions: 3 }));
    expect(history.get().history.map((info) => info.revision)).toEqual([3, 4, 5]);
    expect([...history.texts.keys()].sort()).toEqual([3, 4, 5]);
    expect(switchProblem(history.get(), 2)).toContain("revisions available are 3–5");
  });
});

describe("append", () => {
  it("extends the agent's own last write instead of making a revision per part", () => {
    const history = track();
    history.apply(agentWrite(EMPTY_ARTIFACT, "Long", "part 1\n", 1000));
    history.apply(agentWrite(history.get(), undefined, "part 2\n", 2000, { append: true }));
    expect(history.get().revision).toBe(1);
    expect(history.get().content).toBe("part 1\npart 2\n");
    expect(history.texts.get(1)?.content).toBe("part 1\npart 2\n");
  });

  it("makes a revision after an edit, a save or a switch", () => {
    const history = track();
    history.apply(agentWrite(EMPTY_ARTIFACT, "Long", "a\n", 1000));
    history.apply(agentEdit(history.get(), "a", "b", false, 2000));
    history.apply(agentWrite(history.get(), undefined, "c\n", 3000, { append: true }));
    expect(history.get().revision).toBe(3);
    expect(history.get().content).toBe("b\nc\n");
  });
});

describe("undo and redo", () => {
  const four = () => {
    const history = track();
    for (let index = 1; index <= 4; index++) history.apply(agentWrite(history.get(), `T${index}`, `v${index}`, index * 1000));
    return history;
  };

  it("moves the cursor back and forward without changing any revision", () => {
    const history = four();
    history.switch(3);
    expect(history.get()).toMatchObject({ revision: 3, latest: 4, content: "v3", title: "T3" });
    expect(history.texts.size).toBe(4);
    history.switch(4);
    expect(history.get()).toMatchObject({ revision: 4, content: "v4" });
  });

  it("starts the next change from the current revision and replaces the redo ones", () => {
    const history = four();
    history.switch(2);
    const change = agentEdit(history.get(), "v2", "v2 bis", false, 10_000);
    expect(change.drop).toEqual([4]);
    expect(change.put?.revision).toBe(3);
    history.apply(change);
    expect(history.get()).toMatchObject({ revision: 3, latest: 3, content: "v2 bis" });
    expect(history.get().history.map((info) => info.revision)).toEqual([1, 2, 3]);
    expect(history.texts.get(3)?.content).toBe("v2 bis");
  });

  it("tells who moved it, and what stays for redo", () => {
    const history = four();
    history.switch(3, "user", 0);
    expect(history.get().events.at(-1)?.text).toBe(
      "the user went back from revision 4 to revision 3 (undo). Revision 4 was kept for redo until the next write or edit, which becomes the new revision 4.",
    );
    history.switch(1, "agent", 0);
    expect(history.get().events.at(-1)?.text).toContain("you (the agent) went back from revision 3 to revision 1. Revisions 2–4 were kept");
    history.switch(2, "user", 0);
    expect(history.get().events.at(-1)?.text).toContain("moved forward from revision 1 to revision 2 (redo)");
    expect(switchResult(history.get())).toBe(
      'The artifact "T2" is now on revision 2 of 4. Revisions 3–4 stay available (redo) until the next write or edit, which becomes the new revision 3.',
    );
  });

  it("refuses a revision that is current or not kept", () => {
    const history = four();
    expect(switchProblem(history.get(), 4)).toContain("already on revision 4");
    expect(switchProblem(history.get(), 7)).toContain("not kept");
    expect(switchProblem(EMPTY_ARTIFACT, 1)).toContain("no artifact");
  });

  it("tells the agent about a save that replaced redo revisions", () => {
    const history = four();
    history.switch(2);
    history.apply(userSave(history.get(), "mine", 5000));
    expect(history.get().events.at(-1)?.text).toBe(
      "the user saved their own edits as revision 3. Revisions 3–4, kept for redo, were replaced.",
    );
  });

  it("refuses a write based on a revision the user moved away from", () => {
    const history = four();
    history.switch(3);
    expect(() => checkBase(history.get(), 4)).toThrow("on revision 3 of 4, not revision 4: the user went back");
    expect(() => checkBase(history.get(), 3)).not.toThrow();
    expect(() => checkBase(history.get(), undefined)).not.toThrow();
  });
});

describe("instruction entry", () => {
  it("lists the changes the agent did not make, the last five", () => {
    const history = track();
    history.apply(agentWrite(EMPTY_ARTIFACT, "Plan", "v1", 1000));
    expect(instructionText(history.get())).toBeUndefined();
    history.apply(agentWrite(history.get(), undefined, "v2", 2000));
    for (let index = 0; index < 3; index++) {
      history.switch(1);
      history.switch(2);
    }
    const text = instructionText(history.get(), (at) => `t${at}`)!;
    expect(text.split("\n")).toHaveLength(7);
    expect(text).toStartWith('Changes to the session\'s artifact "Plan"');
    expect(text).toContain("- t9000 the user moved forward from revision 1 to revision 2 (redo).");
    expect(text).toEndWith("Call artifact_read before changing the artifact.");
  });
});

describe("stored artifacts from the first version", () => {
  it("become their own revision, comments kept", () => {
    const old = { revision: 7, title: "Old", content: "text", updatedAt: 5, updatedBy: "user", editedByUser: true, comments: [] };
    const { artifact, legacy } = fromStored(old)!;
    expect(legacy).toBe(true);
    expect(artifact).toMatchObject({ revision: 7, latest: 7, seq: 7, content: "text" });
    expect(artifact.history).toEqual([{ revision: 7, title: "Old", by: "user", kind: "write", at: 5, lines: 1 }]);
    expect(fromStored({ nothing: true })).toBeUndefined();
    expect(fromStored(plan)!.legacy).toBe(false);
  });
});

describe("review", () => {
  it("adds and removes comments without making a revision", () => {
    const commented = addComment(plan, "Store it", "Where?", 2000);
    expect(commented.comments).toHaveLength(1);
    expect(commented.revision).toBe(plan.revision);
    expect(commented.seq).toBe(plan.seq + 1);
    expect(removeComment(commented, commented.comments[0]!.id).comments).toHaveLength(0);
    expect(() => addComment(plan, "x", "   ", 2000)).toThrow();
  });

  it("builds a compact message and clears the review once sent", () => {
    const reviewed = addComment(addComment(plan, "Store it", "In SQLite?", 3000), "", "Shorter", 4000);
    expect(hasReview(reviewed)).toBe(true);
    const text = reviewMessage(reviewed);
    expect(text).toContain('Review of the artifact "Plan" (revision 1)');
    expect(text).toContain('1. On "Store it": In SQLite?');
    expect(text).toContain("2. Shorter");
    expect(hasReview(clearReview(reviewed))).toBe(false);
  });
});

describe("renderForModel", () => {
  it("returns a short document whole", () => {
    expect(renderForModel(plan)).toBe(`# Plan (revision 1 of 1)\n\n${plan.content}`);
    expect(renderForModel(EMPTY_ARTIFACT)).toContain("no artifact");
  });

  it("pages a long document by lines and by bytes", () => {
    const content = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n");
    const long = agentWrite(EMPTY_ARTIFACT, "Long", content, 1).artifact;
    const first = renderForModel(long);
    expect(first).toContain("line 2000\n\n[Lines 1–2000 of 5000. Read on with offset=2001.]");
    const page = renderForModel(long, undefined, { offset: 4990, limit: 50 });
    expect(page).toContain("line 4990\n");
    expect(page).toEndWith("line 5000\n\n[Lines 4990–5000 of 5000.]");
    expect(() => renderForModel(long, undefined, { offset: 6000 })).toThrow("past the end");

    const wide = agentWrite(EMPTY_ARTIFACT, "Wide", Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n"), 1).artifact;
    const cut = renderForModel(wide);
    expect(new TextEncoder().encode(cut).length).toBeLessThan(READ_MAX_BYTES + 200);
    expect(cut).toContain("Read on with offset=");
  });

  it("says when the revision read is not the current one", () => {
    const history = track();
    history.apply(agentWrite(EMPTY_ARTIFACT, "Plan", "v1", 1));
    history.apply(agentWrite(history.get(), undefined, "v2", 2));
    const text = renderForModel(history.get(), { ...history.texts.get(1)!, revision: 1 });
    expect(text).toBe("# Plan (revision 1 of 2, not the current revision 2)\n\nv1");
  });
});

describe("locateQuote", () => {
  it("finds the exact passage, else one that differs only by whitespace", () => {
    expect(locateQuote("abc Store it", "Store it")).toEqual({ start: 4, end: 12 });
    expect(locateQuote("1. Parse\n   the input", "Parse the input")).toEqual({ start: 3, end: 21 });
    expect(locateQuote("abc", "zzz")).toBeUndefined();
    expect(locateQuote("abc", "")).toBeUndefined();
  });

  it("matches a passage selected in the rendered view", () => {
    const source = "# Plan\n\n1. **Boil fresh water**: heat it.\n2. Pour\n\n> a *quoted* line\n";
    const bold = locateQuote(source, "Boil fresh water: heat");
    expect(source.slice(bold!.start, bold!.end)).toBe("Boil fresh water**: heat");
    const across = locateQuote(source, "heat it.\n2. Pour");
    expect(source.slice(across!.start, across!.end)).toBe("heat it.\n2. Pour");
    const quoted = locateQuote(source, "│ a quoted line");
    expect(source.slice(quoted!.start, quoted!.end)).toBe("a *quoted* line");
  });
});
