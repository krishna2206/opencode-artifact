import { describe, expect, it } from "bun:test";
import {
  addComment,
  agentEdit,
  agentWrite,
  checkBase,
  clearReview,
  EMPTY_ARTIFACT,
  EMPTY_META,
  fromStored,
  hasReview,
  instructionText,
  listText,
  locateQuote,
  READ_MAX_BYTES,
  removeComment,
  renderForModel,
  retitle,
  reviewMessage,
  slugify,
  summarize,
  switchProblem,
  switchResult,
  switchTo,
  uniqueId,
  userSave,
  withEvent,
  type Artifact,
  type Change,
} from "../src/artifact";

const empty = (id = "plan"): Artifact => ({ ...EMPTY_ARTIFACT, id });

/** Applies changes one after another, keeping the revision texts like the store does. */
function track(start: Artifact = empty()) {
  let artifact = start;
  const texts = new Map<number, { title: string; content: string }>();
  const events: string[] = [];
  const apply = (change: Change) => {
    if (change.put) texts.set(change.put.revision, change.put.snapshot);
    for (const revision of change.drop) texts.delete(revision);
    if (change.event) events.push(change.event);
    artifact = change.artifact;
    return artifact;
  };
  return {
    apply,
    get: () => artifact,
    texts,
    events,
    switch: (target: number, by: "user" | "agent" = "user", now = 9000) => apply(switchTo(artifact, target, texts.get(target)!, by, now)),
  };
}

const edit = (old_string: string, new_string: string, replace_all?: boolean) => ({ old_string, new_string, replace_all });
const plan = agentWrite(empty(), "Plan", "# Plan\n\n1. Parse the input\n2. Store it\n", 1000).artifact;

describe("writes", () => {
  it("creates the artifact at revision 1 and keeps the title on later writes", () => {
    expect(plan).toMatchObject({ id: "plan", revision: 1, latest: 1, createdAt: 1000 });
    expect(agentWrite(plan, undefined, "new", 2000).artifact.title).toBe("Plan");
  });

  it("refuses an edit before any write", () => {
    expect(() => agentEdit(empty(), [edit("a", "b")], 1000)).toThrow("does not exist");
  });

  it("makes each change a revision and keeps its text", () => {
    const history = track();
    history.apply(agentWrite(empty(), "Plan", "one", 1000));
    history.apply(agentEdit(history.get(), [edit("one", "two")], 2000));
    history.apply(userSave(history.get(), "three", 3000));
    expect(history.get().history.map((info) => [info.revision, info.by, info.kind])).toEqual([
      [1, "agent", "write"],
      [2, "agent", "edit"],
      [3, "user", "save"],
    ]);
    expect(history.texts.get(2)?.content).toBe("two");
    expect(history.events).toEqual(["the user saved their own edits as revision 3."]);
  });

  it("ignores a save without change", () => {
    expect(userSave(plan, plan.content, 2000).artifact).toBe(plan);
  });

  it("drops the oldest revisions beyond the limit, 30 by default", () => {
    const history = track();
    for (let index = 1; index <= 5; index++) history.apply(agentWrite(history.get(), "Plan", `v${index}`, index, { maxRevisions: 3 }));
    expect(history.get().history.map((info) => info.revision)).toEqual([3, 4, 5]);
    expect([...history.texts.keys()].sort()).toEqual([3, 4, 5]);
    expect(switchProblem(history.get(), 2)).toContain("revisions available are 3–5");
    const many = track();
    for (let index = 1; index <= 35; index++) many.apply(agentWrite(many.get(), "Plan", `v${index}`, index));
    expect(many.get().history).toHaveLength(30);
  });
});

describe("edits in one call", () => {
  it("applies them in order, as one revision", () => {
    const change = agentEdit(plan, [edit("Parse", "Read"), edit("Read the input", "Read the file"), edit("Store", "Save")], 2000);
    expect(change.artifact.revision).toBe(2);
    expect(change.artifact.content).toBe("# Plan\n\n1. Read the file\n2. Save it\n");
  });

  it("applies none when one fails, and says which", () => {
    expect(() => agentEdit(plan, [edit("Parse", "Read"), edit("absent", "x")], 2000)).toThrow(
      "Edit 2 of 2 (looked for in the text the edits before it left): old_string was not found in the artifact.",
    );
    expect(() => agentEdit(plan, [edit("absent", "x")], 2000)).toThrow(/^old_string was not found/);
    const twice = agentWrite(plan, undefined, "a a", 2000).artifact;
    expect(() => agentEdit(twice, [edit("a", "b")], 3000)).toThrow("2 times");
    expect(agentEdit(twice, [edit("a", "b", true)], 3000).artifact.content).toBe("b b");
    expect(() => agentEdit(plan, [], 2000)).toThrow("edits is empty");
  });

  it("makes no revision when the text ends up the same", () => {
    expect(agentEdit(plan, [edit("Parse", "Read"), edit("Read", "Parse")], 2000).artifact).toBe(plan);
  });
});

describe("append", () => {
  it("extends the agent's own last write instead of making a revision per part", () => {
    const history = track();
    history.apply(agentWrite(empty(), "Long", "part 1\n", 1000));
    history.apply(agentWrite(history.get(), undefined, "part 2\n", 2000, { append: true }));
    expect(history.get().revision).toBe(1);
    expect(history.texts.get(1)?.content).toBe("part 1\npart 2\n");
  });

  it("makes a revision after an edit", () => {
    const history = track();
    history.apply(agentWrite(empty(), "Long", "a\n", 1000));
    history.apply(agentEdit(history.get(), [edit("a", "b")], 2000));
    history.apply(agentWrite(history.get(), undefined, "c\n", 3000, { append: true }));
    expect(history.get().revision).toBe(3);
    expect(history.get().content).toBe("b\nc\n");
  });
});

describe("undo and redo", () => {
  const four = () => {
    const history = track();
    for (let index = 1; index <= 4; index++) history.apply(agentWrite(history.get(), "Plan", `v${index}`, index * 1000));
    return history;
  };

  it("moves the cursor back and forward without changing any revision, nor the title", () => {
    const history = four();
    history.apply(agentWrite(history.get(), "Renamed", "v5", 5000));
    history.switch(3);
    expect(history.get()).toMatchObject({ revision: 3, latest: 5, content: "v3", title: "Renamed" });
    expect(history.texts.size).toBe(5);
  });

  it("starts the next change from the current revision and replaces the redo ones", () => {
    const history = four();
    history.switch(2);
    const change = agentEdit(history.get(), [edit("v2", "v2 bis")], 10_000);
    expect(change.drop).toEqual([4]);
    expect(change.put?.revision).toBe(3);
    history.apply(change);
    expect(history.get()).toMatchObject({ revision: 3, latest: 3, content: "v2 bis" });
  });

  it("tells who moved it, and what stays for redo", () => {
    const history = four();
    history.switch(3, "user", 0);
    expect(history.events.at(-1)).toBe(
      "the user went back from revision 4 to revision 3 (undo). Revision 4 was kept for redo until the next write or edit, which becomes the new revision 4.",
    );
    history.switch(1, "agent", 0);
    expect(history.events.at(-1)).toContain("you (the agent) went back from revision 3 to revision 1. Revisions 2–4 were kept");
    history.switch(2, "user", 0);
    expect(history.events.at(-1)).toContain("moved forward from revision 1 to revision 2 (redo)");
    expect(switchResult(history.get())).toBe(
      'The artifact plan ("Plan") is now on revision 2 of 4. Revisions 3–4 stay available (redo) until the next write or edit, which becomes the new revision 3.',
    );
  });

  it("refuses a revision that is current or not kept", () => {
    const history = four();
    expect(switchProblem(history.get(), 4)).toContain("already on revision 4");
    expect(switchProblem(history.get(), 7)).toContain("not kept");
  });

  it("refuses a write based on a revision the user moved away from", () => {
    const history = four();
    history.switch(3);
    expect(() => checkBase(history.get(), 4, history.events.at(-1))).toThrow(
      "The artifact plan is on revision 3 of 4, not revision 4: the user went back",
    );
    expect(() => checkBase(history.get(), 3)).not.toThrow();
    expect(() => checkBase(history.get(), undefined)).not.toThrow();
  });
});

describe("identifiers and titles", () => {
  it("makes an identifier from a title, unique in the session", () => {
    expect(slugify("Spec — Suivi des soldes des SIM (finance-management, lot 1)")).toBe("spec-suivi-des-soldes-des-sim");
    expect(slugify("!!!")).toBe("artifact");
    expect(uniqueId("lot-1", new Set(["lot-1", "lot-1-2"]))).toBe("lot-1-3");
  });

  it("retitles without a revision", () => {
    const renamed = retitle(plan, " New ");
    expect(renamed).toMatchObject({ title: "New", revision: 1, seq: plan.seq + 1 });
    expect(retitle(plan, "Plan")).toBe(plan);
    expect(() => retitle(plan, " ")).toThrow("empty");
  });
});

describe("instruction entry", () => {
  it("lists the last changes of every artifact the agent did not make", () => {
    expect(instructionText(EMPTY_META)).toBeUndefined();
    let meta = EMPTY_META;
    for (let index = 0; index < 10; index++) meta = withEvent(meta, { artifact: index % 2 ? "lot-1" : "lot-2", at: index, text: `change ${index}` });
    const text = instructionText(meta, undefined, (at) => `t${at}`)!;
    expect(meta.seq).toBe(10);
    expect(text.split("\n")).toHaveLength(10);
    expect(text).toContain("- t9 [lot-1] change 9");
    expect(text).not.toContain("change 1\n");
    expect(text).toEndWith("Call artifact_read on an artifact before changing it.");
  });

  it("says which artifact the user has open, alone or before the changes", () => {
    const shown = { id: "lot-2", title: "Lot 2", revision: 4 };
    expect(instructionText({ ...EMPTY_META, shown: "lot-2" }, shown)).toBe(
      'The user has the artifact lot-2 ("Lot 2", revision 4) open in the artifact panel.',
    );
    const meta = withEvent({ ...EMPTY_META, shown: "lot-2" }, { artifact: "lot-1", at: 0, text: "x" });
    expect(meta.shown).toBe("lot-2");
    expect(instructionText(meta, shown, () => "t")!.split("\n")).toHaveLength(4);
  });
});

describe("listing", () => {
  it("describes each artifact without its text", () => {
    const now = new Date(2026, 9, 1, 15, 0).getTime();
    const today = new Date(2026, 9, 1, 14, 20).getTime();
    const before = new Date(2026, 8, 30, 9, 5).getTime();
    const lot = { ...agentWrite(empty("lot-1"), "Lot 1", "a\nb", before).artifact };
    const moved = { ...agentWrite(agentWrite(empty("lot-2"), "Lot 2", "x", today).artifact, undefined, "y", today).artifact };
    const back = addComment({ ...moved, revision: 1 }, "x", "why?", today);
    const text = listText([summarize(lot), summarize(back)], now);
    expect(text).toBe(
      [
        "2 artifacts in this session:",
        '- lot-1 — "Lot 1" — revision 1, 2 lines, 3 B, updated 2026-09-30 09:05',
        '- lot-2 — "Lot 2" — revision 1 of 2 (1 kept for redo), 1 lines, 1 B, 1 unsent comment, updated 14:20',
      ].join("\n"),
    );
    expect(listText([])).toContain("no artifact yet");
  });
});

describe("stored artifacts from earlier versions", () => {
  it("take the identifier given, keep their comments and hand over their events", () => {
    const first = { revision: 7, title: "Old", content: "text", updatedAt: 5, updatedBy: "user", editedByUser: true, comments: [] };
    const parsed = fromStored(first, "old")!;
    expect(parsed.legacy).toBe(true);
    expect(parsed.artifact).toMatchObject({ id: "old", revision: 7, latest: 7, createdAt: 5 });
    const second = { ...plan, id: undefined, events: [{ at: 1, text: "the user undid" }] };
    const migrated = fromStored(second, "plan-2")!;
    expect(migrated.artifact.id).toBe("plan-2");
    expect(migrated.events).toEqual([{ at: 1, text: "the user undid" }]);
    expect("events" in migrated.artifact).toBe(false);
    expect(fromStored({ nothing: true })).toBeUndefined();
  });
});

describe("review", () => {
  it("adds and removes comments without making a revision", () => {
    const commented = addComment(plan, "Store it", "Where?", 2000);
    expect(commented).toMatchObject({ revision: 1, seq: plan.seq + 1 });
    expect(removeComment(commented, commented.comments[0]!.id).comments).toHaveLength(0);
    expect(() => addComment(plan, "x", "   ", 2000)).toThrow();
  });

  it("builds a compact message naming the artifact and clears the review once sent", () => {
    const reviewed = addComment(addComment(plan, "Store it", "In SQLite?", 3000), "", "Shorter", 4000);
    expect(hasReview(reviewed)).toBe(true);
    const text = reviewMessage(reviewed);
    expect(text).toStartWith('Review of the artifact plan, "Plan" (revision 1)');
    expect(text).toContain('1. On "Store it": In SQLite?');
    expect(text).toContain("questions in the chat, without changing the artifact");
    expect(text).toContain("only for the comments that ask for a change, with one artifact_edit call");
    expect(hasReview(clearReview(reviewed))).toBe(false);
  });
});

describe("renderForModel", () => {
  it("returns a short document whole", () => {
    expect(renderForModel(plan)).toBe(`# Plan (artifact plan, revision 1 of 1)\n\n${plan.content}`);
    expect(renderForModel(empty())).toContain("does not exist");
  });

  it("pages a long document by lines and by bytes", () => {
    const content = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n");
    const long = agentWrite(empty(), "Long", content, 1).artifact;
    expect(renderForModel(long)).toContain("line 2000\n\n[Lines 1–2000 of 5000. Read on with offset=2001.]");
    expect(renderForModel(long, undefined, { offset: 4990, limit: 50 })).toEndWith("line 5000\n\n[Lines 4990–5000 of 5000.]");
    expect(() => renderForModel(long, undefined, { offset: 6000 })).toThrow("past the end");
    const wide = agentWrite(empty(), "Wide", Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n"), 1).artifact;
    const cut = renderForModel(wide);
    expect(new TextEncoder().encode(cut).length).toBeLessThan(READ_MAX_BYTES + 200);
    expect(cut).toContain("Read on with offset=");
  });

  it("says when the revision read is not the current one", () => {
    const history = track();
    history.apply(agentWrite(empty(), "Plan", "v1", 1));
    history.apply(agentWrite(history.get(), undefined, "v2", 2));
    expect(renderForModel(history.get(), { content: "v1", revision: 1 })).toBe(
      "# Plan (artifact plan, revision 1 of 2, not the current revision 2)\n\nv1",
    );
  });
});

describe("locateQuote", () => {
  it("finds the exact passage, else one that differs only by whitespace or markers", () => {
    expect(locateQuote("abc Store it", "Store it")).toEqual({ start: 4, end: 12 });
    expect(locateQuote("1. Parse\n   the input", "Parse the input")).toEqual({ start: 3, end: 21 });
    expect(locateQuote("abc", "zzz")).toBeUndefined();
    const source = "# Plan\n\n1. **Boil fresh water**: heat it.\n2. Pour\n\n> a *quoted* line\n";
    const bold = locateQuote(source, "Boil fresh water: heat");
    expect(source.slice(bold!.start, bold!.end)).toBe("Boil fresh water**: heat");
    const quoted = locateQuote(source, "│ a quoted line");
    expect(source.slice(quoted!.start, quoted!.end)).toBe("a *quoted* line");
  });
});
