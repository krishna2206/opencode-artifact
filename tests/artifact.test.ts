import { describe, expect, it } from "bun:test";
import {
  addComment,
  agentEdit,
  agentWrite,
  clearReview,
  EMPTY_ARTIFACT,
  hasReview,
  locateQuote,
  removeComment,
  reviewMessage,
  userSave,
} from "../src/artifact";

const plan = agentWrite(EMPTY_ARTIFACT, "Plan", "# Plan\n\n1. Parse the input\n2. Store it\n", 1000);

describe("writes", () => {
  it("creates the artifact at revision 1 and keeps the title on later writes", () => {
    expect(plan.revision).toBe(1);
    expect(agentWrite(plan, undefined, "new", 2000).title).toBe("Plan");
  });

  it("edits a unique passage, refuses a missing or ambiguous one", () => {
    expect(agentEdit(plan, "Store it", "Save it", false, 2000).content).toContain("2. Save it");
    expect(() => agentEdit(plan, "absent", "x", false, 2000)).toThrow("not found");
    const twice = agentWrite(plan, undefined, "a a", 2000);
    expect(() => agentEdit(twice, "a", "b", false, 3000)).toThrow("2 times");
    expect(agentEdit(twice, "a", "b", true, 3000).content).toBe("b b");
  });

  it("refuses an edit before any write", () => {
    expect(() => agentEdit(EMPTY_ARTIFACT, "a", "b", false, 1000)).toThrow("no artifact");
  });

  it("marks a user save as an edit to review, and ignores a save without change", () => {
    expect(userSave(plan, plan.content, 2000)).toBe(plan);
    const edited = userSave(plan, "# Plan\n\nmine", 2000);
    expect(edited.editedByUser).toBe(true);
    expect(edited.updatedBy).toBe("user");
    expect(hasReview(edited)).toBe(true);
  });
});

describe("review", () => {
  it("adds and removes comments", () => {
    const commented = addComment(plan, "Store it", "Where?", 2000);
    expect(commented.comments).toHaveLength(1);
    expect(removeComment(commented, commented.comments[0]!.id).comments).toHaveLength(0);
    expect(() => addComment(plan, "x", "   ", 2000)).toThrow();
  });

  it("builds a compact message and clears the review once sent", () => {
    const reviewed = addComment(addComment(userSave(plan, "edited", 2000), "Store it", "In SQLite?", 3000), "", "Shorter", 4000);
    const text = reviewMessage(reviewed);
    expect(text).toContain('Review of the artifact "Plan"');
    expect(text).toContain("artifact_read");
    expect(text).toContain('1. On "Store it": In SQLite?');
    expect(text).toContain("2. Shorter");
    const cleared = clearReview(reviewed);
    expect(hasReview(cleared)).toBe(false);
    expect(cleared.content).toBe("edited");
  });
});

describe("locateQuote", () => {
  it("finds the exact passage, else one that differs only by whitespace", () => {
    expect(locateQuote("abc Store it", "Store it")).toEqual({ start: 4, end: 12 });
    expect(locateQuote("1. Parse\n   the input", "Parse the input")).toEqual({ start: 3, end: 21 });
    expect(locateQuote("abc", "zzz")).toBeUndefined();
    expect(locateQuote("abc", "")).toBeUndefined();
  });
});

describe("locateQuote across Markdown markers", () => {
  const source = "# Plan\n\n1. **Boil fresh water**: heat it.\n2. Pour\n\n> a *quoted* line\n";
  it("matches a passage selected in the rendered view", () => {
    const bold = locateQuote(source, "Boil fresh water: heat");
    expect(source.slice(bold!.start, bold!.end)).toBe("Boil fresh water**: heat");
    const across = locateQuote(source, "heat it.\n2. Pour");
    expect(source.slice(across!.start, across!.end)).toBe("heat it.\n2. Pour");
    const quoted = locateQuote(source, "│ a quoted line");
    expect(source.slice(quoted!.start, quoted!.end)).toBe("a *quoted* line");
  });
});
