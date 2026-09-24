import { describe, expect, it } from "bun:test";
import type { Comment } from "../src/artifact";
import { layout, splitBlocks } from "../src/layout";

const source = "# Plan\n\nFirst paragraph.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n";
const comment = (quote: string, id = quote): Comment => ({ id, quote, note: "n", createdAt: 0 });

describe("splitBlocks", () => {
  it("keeps the top-level blocks with their source offsets", () => {
    const blocks = splitBlocks(source);
    expect(blocks.map((block) => block.raw.trim())).toEqual([
      "# Plan",
      "First paragraph.",
      "- one\n- two",
      "```ts\nconst x = 1;\n```",
    ]);
    for (const block of blocks) expect(source.slice(block.start, block.end)).toBe(block.raw);
  });
});

describe("layout", () => {
  it("puts each comment under the block where its passage ends", () => {
    const { blocks, trailing } = layout(source, [
      comment("paragraph"),
      comment("two"),
      comment("First paragraph. one", "across"),
      comment("", "general"),
      comment("gone", "missing"),
    ]);
    expect(blocks[1]!.comments.map((c) => c.id)).toEqual(["paragraph"]);
    expect(blocks[2]!.comments.map((c) => c.id)).toEqual(["two", "across"]);
    expect(trailing.map((c) => c.id)).toEqual(["general", "missing"]);
  });
});
